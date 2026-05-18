"use strict";

const fs = require("node:fs");

const NS = "http://www.topografix.com/GPX/1/1";

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function isoFromEpoch(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

function makeWriter(stream) {
  // Buffered writer with backpressure handling. Chunks are accumulated into
  // a string until they exceed CHUNK_BYTES, then flushed; if the stream's
  // internal buffer is full, callers must await the returned promise.
  const CHUNK_BYTES = 64 * 1024;
  let buf = "";
  let pendingDrain = null;

  function awaitDrain() {
    if (pendingDrain) return pendingDrain;
    pendingDrain = new Promise(res => stream.once("drain", () => {
      pendingDrain = null;
      res();
    }));
    return pendingDrain;
  }

  async function flush() {
    if (!buf) return;
    const chunk = buf;
    buf = "";
    if (!stream.write(chunk)) await awaitDrain();
  }

  async function write(s) {
    buf += s;
    if (buf.length >= CHUNK_BYTES) await flush();
  }

  async function close() {
    await flush();
    await new Promise((res, rej) => stream.end(err => err ? rej(err) : res()));
  }

  return { write, flush, close };
}

async function writeWaypoint(w, write) {
  await write(`  <wpt lat="${w.lat}" lon="${w.lon}">`);
  if (w.ele != null) await write(`<ele>${w.ele}</ele>`);
  const t = isoFromEpoch(w.time);
  if (t) await write(`<time>${t}</time>`);
  if (w.name) await write(`<name>${esc(w.name)}</name>`);
  await write(`</wpt>\n`);
}

async function writeTrackOpen(t, write) {
  await write(`  <trk>`);
  if (t.name) await write(`<name>${esc(t.name)}</name>`);
  const tp = t.raw_type || t.type;
  if (tp) await write(`<type>${esc(tp)}</type>`);
  await write(`\n`);
}

async function writePoint(p, write) {
  await write(`      <trkpt lat="${p.lat}" lon="${p.lon}">`);
  if (p.ele != null) await write(`<ele>${p.ele}</ele>`);
  const t = isoFromEpoch(p.time);
  if (t) await write(`<time>${t}</time>`);
  await write(`</trkpt>\n`);
}

async function writeHeader(creator, write) {
  await write(`<?xml version="1.0" encoding="UTF-8"?>\n`);
  await write(`<gpx version="1.1" xmlns="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`);
  if (creator) await write(` creator="${esc(creator)}"`);
  await write(`>\n`);
}

async function writeOneSource(db, sourceId, write) {
  let headerWritten = false;
  let creator = null;
  for (const ev of db.iterateSourceForExport(sourceId)) {
    if (ev.kind === "source") {
      creator = ev.source.creator;
      await writeHeader(creator, write);
      headerWritten = true;
    } else if (ev.kind === "waypoint") {
      await writeWaypoint(ev.waypoint, write);
    } else if (ev.kind === "track-open") {
      await writeTrackOpen(ev.track, write);
    } else if (ev.kind === "track-close") {
      await write(`  </trk>\n`);
    } else if (ev.kind === "segment-open") {
      await write(`    <trkseg>\n`);
    } else if (ev.kind === "segment-close") {
      await write(`    </trkseg>\n`);
    } else if (ev.kind === "point") {
      await writePoint(ev.point, write);
    }
  }
  if (!headerWritten) await writeHeader(null, write);
}

async function writeStreamSource(db, sourceId, outPath) {
  const stream = fs.createWriteStream(outPath, { encoding: "utf8" });
  const w = makeWriter(stream);
  try {
    await writeOneSource(db, sourceId, w.write);
    await w.write(`</gpx>\n`);
  } finally {
    await w.close();
  }
}

async function writeStreamMerged(db, sourceIds, outPath) {
  const stream = fs.createWriteStream(outPath, { encoding: "utf8" });
  const w = makeWriter(stream);
  try {
    let creator = null;
    for (const id of sourceIds) {
      const row = db.raw.prepare("SELECT creator FROM sources WHERE id = ?").get(id);
      if (row?.creator) { creator = row.creator; break; }
    }
    await writeHeader(creator, w.write);

    for (const id of sourceIds) {
      for (const ev of db.iterateSourceForExport(id)) {
        if (ev.kind === "source") continue;
        if (ev.kind === "waypoint") await writeWaypoint(ev.waypoint, w.write);
        else if (ev.kind === "track-open") await writeTrackOpen(ev.track, w.write);
        else if (ev.kind === "track-close") await w.write(`  </trk>\n`);
        else if (ev.kind === "segment-open") await w.write(`    <trkseg>\n`);
        else if (ev.kind === "segment-close") await w.write(`    </trkseg>\n`);
        else if (ev.kind === "point") await writePoint(ev.point, w.write);
      }
    }
    await w.write(`</gpx>\n`);
  } finally {
    await w.close();
  }
}

module.exports = { writeStreamSource, writeStreamMerged };
