#!/usr/bin/env node
// CLI: ingest one or more GPX files into the desktop SQLite store.
//
// Usage:
//   node ingest.js --db ./arc.db path/to/*.gpx
//   node ingest.js --db ./arc.db --glob "/some/dir/*.gpx"

import { existsSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb, closeDb } from "./db.js";
import { ingestFile } from "./source-loader.js";

function expandArg(arg) {
  // If the shell already globbed, arg is a single file. If it's a directory,
  // pick up every .gpx inside (non-recursive - that's enough for ARC's
  // weekly-export layout).
  if (!existsSync(arg)) return [];
  const st = statSync(arg);
  if (st.isFile()) return [resolve(arg)];
  if (st.isDirectory()) {
    return readdirSync(arg)
      .filter(n => n.toLowerCase().endsWith(".gpx"))
      .map(n => resolve(arg, n));
  }
  return [];
}

function parseArgs(argv) {
  let db = "arc.db";
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") db = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: node ingest.js --db ./arc.db <file-or-dir>...");
      process.exit(0);
    } else inputs.push(a);
  }
  return { db, inputs };
}

async function main() {
  const { db: dbPath, inputs } = parseArgs(process.argv.slice(2));
  if (!inputs.length) {
    console.error("No input files specified. Pass one or more .gpx files or a directory.");
    process.exit(2);
  }
  const db = openDb(dbPath);
  const files = [...new Set(inputs.flatMap(expandArg))];
  if (!files.length) {
    console.error("Nothing to ingest (no matching .gpx files).");
    process.exit(2);
  }
  console.log(`Ingesting ${files.length} file(s) into ${dbPath}`);

  const existing = new Set(
    db.prepare("SELECT filename FROM sources").all().map(r => r.filename),
  );

  let ok = 0, skipped = 0, failed = 0;
  let totalTracks = 0, totalPoints = 0;
  const t0 = Date.now();
  for (const f of files) {
    const name = f.split(/[\\/]/).pop();
    if (existing.has(name)) {
      console.log(`  skip ${name} (already imported)`);
      skipped += 1;
      continue;
    }
    try {
      const res = await ingestFile(f, db);
      console.log(`  ok   ${name}  tracks=${res.tracks}  pts=${res.points}`);
      ok += 1;
      totalTracks += res.tracks;
      totalPoints += res.points;
    } catch (e) {
      console.error(`  fail ${name}: ${e.message}`);
      failed += 1;
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${dt}s. ok=${ok} skipped=${skipped} failed=${failed} tracks=${totalTracks} pts=${totalPoints.toLocaleString()}`);
  closeDb();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
