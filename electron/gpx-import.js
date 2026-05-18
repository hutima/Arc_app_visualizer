"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sax = require("sax");

const POINT_BATCH = 4000;

function parseIsoToEpoch(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function num(s) {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stream-parse one GPX file and insert into the SQLite DB in batches.
 * Emits no large intermediates: at any moment we hold the current track's
 * point buffer (up to POINT_BATCH points) and per-segment counters.
 *
 * onProgress({phase, file, pointsImported}) is optional.
 *
 * Returns: { sourceId, trackCount, segmentCount, pointCount, waypointCount }
 */
async function importGpxFile(db, filePath, onProgress) {
  const filename = path.basename(filePath);
  const importedAt = Date.now();
  const sourceId = db.stmts.insertSource.run(filename, importedAt, null).lastInsertRowid;

  // Aggregates updated as we go.
  let trackCount = 0, segmentCount = 0, pointCount = 0, waypointCount = 0;
  let srcMinLat = Infinity, srcMinLon = Infinity, srcMaxLat = -Infinity, srcMaxLon = -Infinity;
  let creator = null;

  // Per-track state.
  let trackId = null;
  let trackSeq = 0;
  let trackName = null, trackType = null, trackRawType = null;
  let trackPointCount = 0;
  let trackMinLat = Infinity, trackMinLon = Infinity, trackMaxLat = -Infinity, trackMaxLon = -Infinity;
  let trackStartTime = null, trackEndTime = null;

  // Per-segment state.
  let segmentId = null;
  let segmentSeq = 0;
  let segmentPointCount = 0;
  let segmentPointBuffer = []; // [seq, lat, lon, ele, time]

  // Per-point state (accumulated between opentag(trkpt) and closetag(trkpt)).
  let curPt = null;
  let curWpt = null;

  // Tag stack to know context.
  const stack = [];
  let textBuf = "";

  function flushSegmentBatch() {
    if (!segmentPointBuffer.length) return;
    const insert = db.stmts.insertPoint;
    const tx = db.txn(() => {
      for (const row of segmentPointBuffer) {
        insert.run(segmentId, row[0], row[1], row[2], row[3], row[4]);
      }
    });
    tx();
    segmentPointBuffer.length = 0;
  }

  function finishSegment() {
    flushSegmentBatch();
    if (segmentId != null) {
      db.raw.prepare("UPDATE segments SET point_count = ? WHERE id = ?")
        .run(segmentPointCount, segmentId);
    }
    segmentId = null;
    segmentPointCount = 0;
  }

  function finishTrack() {
    if (trackId == null) return;
    db.raw.prepare(`
      UPDATE tracks
      SET point_count = ?, start_time = ?, end_time = ?,
          min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?
      WHERE id = ?
    `).run(
      trackPointCount,
      trackStartTime, trackEndTime,
      trackPointCount ? trackMinLat : null,
      trackPointCount ? trackMinLon : null,
      trackPointCount ? trackMaxLat : null,
      trackPointCount ? trackMaxLon : null,
      trackId
    );
    if (trackPointCount) {
      db.stmts.insertTrackRtree.run(trackId, trackMinLat, trackMaxLat, trackMinLon, trackMaxLon);
      if (trackMinLat < srcMinLat) srcMinLat = trackMinLat;
      if (trackMinLon < srcMinLon) srcMinLon = trackMinLon;
      if (trackMaxLat > srcMaxLat) srcMaxLat = trackMaxLat;
      if (trackMaxLon > srcMaxLon) srcMaxLon = trackMaxLon;
    }
    trackId = null;
    trackName = trackType = trackRawType = null;
    trackPointCount = 0;
    trackMinLat = trackMinLon = Infinity;
    trackMaxLat = trackMaxLon = -Infinity;
    trackStartTime = trackEndTime = null;
  }

  return new Promise((resolve, reject) => {
    const strict = false;
    const parser = sax.createStream(strict, {
      trim: true,
      normalize: false,
      lowercase: true,
      position: false,
    });

    parser.on("error", (e) => {
      parser._parser.error = null;
      parser._parser.resume();
      reject(e);
    });

    parser.on("opentag", (node) => {
      const name = node.name; // already lowercased
      const attrs = node.attributes;
      stack.push(name);
      textBuf = "";

      if (name === "gpx") {
        creator = attrs.creator || null;
      } else if (name === "wpt") {
        const lat = num(attrs.lat), lon = num(attrs.lon);
        if (lat != null && lon != null) curWpt = { lat, lon, ele: null, time: null, name: null };
      } else if (name === "trk") {
        trackSeq += 1;
        trackId = db.stmts.insertTrack.run(
          sourceId, trackSeq, null, "", null, 0, null, null, null, null, null, null
        ).lastInsertRowid;
        segmentSeq = 0;
      } else if (name === "trkseg" && trackId != null) {
        segmentSeq += 1;
        segmentId = db.stmts.insertSegment.run(trackId, segmentSeq, 0).lastInsertRowid;
        segmentPointCount = 0;
      } else if (name === "trkpt" && segmentId != null) {
        const lat = num(attrs.lat), lon = num(attrs.lon);
        if (lat != null && lon != null) curPt = { lat, lon, ele: null, time: null };
      }
    });

    parser.on("text", (t) => { textBuf += t; });
    parser.on("cdata", (t) => { textBuf += t; });

    parser.on("closetag", (name) => {
      stack.pop();
      const text = textBuf.trim();
      textBuf = "";
      const parent = stack[stack.length - 1];

      if (parent === "wpt" && curWpt) {
        if (name === "name") curWpt.name = text || null;
        else if (name === "time") curWpt.time = parseIsoToEpoch(text);
        else if (name === "ele") curWpt.ele = num(text);
      } else if (parent === "trkpt" && curPt) {
        if (name === "ele") curPt.ele = num(text);
        else if (name === "time") curPt.time = parseIsoToEpoch(text);
      } else if (parent === "trk" && trackId != null) {
        if (name === "name") trackName = text || null;
        else if (name === "type") {
          trackRawType = text || null;
          trackType = (text || "").toLowerCase();
          db.raw.prepare("UPDATE tracks SET name = ?, type = ?, raw_type = ? WHERE id = ?")
            .run(trackName, trackType, trackRawType, trackId);
        }
      }

      if (name === "wpt") {
        if (curWpt) {
          const wid = db.stmts.insertWaypoint.run(
            sourceId, curWpt.name, curWpt.lat, curWpt.lon, curWpt.ele, curWpt.time
          ).lastInsertRowid;
          db.stmts.insertWaypointRtree.run(wid, curWpt.lat, curWpt.lat, curWpt.lon, curWpt.lon);
          waypointCount += 1;
          if (curWpt.lat < srcMinLat) srcMinLat = curWpt.lat;
          if (curWpt.lon < srcMinLon) srcMinLon = curWpt.lon;
          if (curWpt.lat > srcMaxLat) srcMaxLat = curWpt.lat;
          if (curWpt.lon > srcMaxLon) srcMaxLon = curWpt.lon;
        }
        curWpt = null;
      } else if (name === "trkpt") {
        if (curPt && segmentId != null) {
          segmentPointCount += 1;
          trackPointCount += 1;
          pointCount += 1;
          if (curPt.lat < trackMinLat) trackMinLat = curPt.lat;
          if (curPt.lon < trackMinLon) trackMinLon = curPt.lon;
          if (curPt.lat > trackMaxLat) trackMaxLat = curPt.lat;
          if (curPt.lon > trackMaxLon) trackMaxLon = curPt.lon;
          if (curPt.time != null) {
            if (trackStartTime == null || curPt.time < trackStartTime) trackStartTime = curPt.time;
            if (trackEndTime == null || curPt.time > trackEndTime) trackEndTime = curPt.time;
          }
          segmentPointBuffer.push([segmentPointCount, curPt.lat, curPt.lon, curPt.ele, curPt.time]);
          if (segmentPointBuffer.length >= POINT_BATCH) {
            flushSegmentBatch();
            if (onProgress) onProgress({ phase: "import", file: filename, pointsImported: pointCount });
          }
        }
        curPt = null;
      } else if (name === "trkseg") {
        finishSegment();
        segmentCount += 1;
      } else if (name === "trk") {
        finishTrack();
        trackCount += 1;
      }
    });

    parser.on("end", () => {
      // Final aggregate update on the source.
      const bounds = pointCount + waypointCount > 0 ? [srcMinLat, srcMinLon, srcMaxLat, srcMaxLon] : [null, null, null, null];
      db.stmts.updateSourceStats.run(
        trackCount, segmentCount, pointCount, waypointCount,
        bounds[0], bounds[1], bounds[2], bounds[3],
        sourceId
      );
      if (creator) {
        db.raw.prepare("UPDATE sources SET creator = ? WHERE id = ?").run(creator, sourceId);
      }
      resolve({
        id: sourceId,
        filename,
        importedAt,
        creator,
        visible: true,
        trackCount, segmentCount, pointCount, waypointCount,
        bounds: bounds[0] == null ? null : bounds,
      });
    });

    const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1 << 20 });
    stream.on("error", reject);
    stream.pipe(parser);
  });
}

async function importGpxFiles(db, filePaths, onProgress) {
  const ok = [];
  const errors = [];
  for (let i = 0; i < filePaths.length; i++) {
    const p = filePaths[i];
    if (onProgress) onProgress({ phase: "start", file: path.basename(p), index: i, total: filePaths.length });
    try {
      const summary = await importGpxFile(db, p, onProgress);
      ok.push(summary);
    } catch (e) {
      errors.push({ file: path.basename(p), error: e?.message || String(e) });
    }
  }
  if (onProgress) onProgress({ phase: "done", total: filePaths.length });
  return { ok, errors };
}

module.exports = { importGpxFile, importGpxFiles };
