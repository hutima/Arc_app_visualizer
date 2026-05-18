"use strict";
// Smoke test of the DB + importer with the bundled sample GPX. Not part of
// the app; just verifies the streaming import, R-tree spatial index, and
// stride-decimated track query all work end-to-end in plain Node.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../electron/db");
const { importGpxFile } = require("../electron/gpx-import");
const { writeStreamSource, writeStreamMerged } = require("../electron/gpx-export");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arc-smoke-"));
  const db = openDatabase(tmp);
  console.log("opened db at", db.file);

  const sample = path.resolve(__dirname, "..", "samples", "sample-arc-week.gpx");
  let lastProgress = 0;
  const summary = await importGpxFile(db, sample, ev => {
    if (ev.phase === "import") lastProgress = ev.pointsImported;
  });
  console.log("import summary:", summary, "last-progress:", lastProgress);

  console.log("sources:", db.listSources());
  console.log("types:", db.listTypes());

  // Worldwide query, all sources, all types.
  const allBounds = db.overallBounds();
  console.log("overall bounds:", allBounds);
  const bbox = allBounds || [-90, -180, 90, 180];
  const padded = [bbox[0] - 1, bbox[1] - 1, bbox[2] + 1, bbox[3] + 1];

  const tracks = db.queryTracks({
    bbox: padded,
    sourceIds: db.listSources().map(s => s.id),
    types: db.listTypes(),
    maxPointsPerSegment: 1000,
    maxTracks: 1000,
  });
  console.log("queryTracks returned", tracks.length, "tracks");
  if (tracks[0]) {
    const seg0 = tracks[0].segments[0] || [];
    console.log("first track type:", tracks[0].type, "first segment pts:", seg0.length);
  }

  const wpts = db.queryWaypoints({ bbox: padded, sourceIds: db.listSources().map(s => s.id) });
  console.log("queryWaypoints returned", wpts.length, "waypoints");

  // Roundtrip export.
  const out1 = path.join(tmp, "merged.gpx");
  await writeStreamMerged(db, db.listSourceIdsForExport(), out1);
  console.log("wrote merged:", out1, fs.statSync(out1).size, "bytes");

  const out2 = path.join(tmp, "roundtrip.gpx");
  await writeStreamSource(db, db.listSources()[0].id, out2);
  console.log("wrote roundtrip:", out2, fs.statSync(out2).size, "bytes");

  db.close();

  // Re-open to confirm persistence.
  const db2 = openDatabase(tmp);
  console.log("after reopen, sources:", db2.listSources().length, "types:", db2.listTypes());
  db2.close();

  console.log("OK");
})().catch(e => { console.error(e); process.exit(1); });
