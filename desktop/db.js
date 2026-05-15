// SQLite wrapper. Single connection per process (better-sqlite3 is sync).

import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, "schema.sql");

let _db = null;
let _dbPath = null;

export function openDb(path) {
  if (_db && _dbPath === path) return _db;
  if (_db) { _db.close(); _db = null; }
  _dbPath = path;
  _db = new Database(path);
  _db.pragma("foreign_keys = ON");
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  initSchema(_db);
  return _db;
}

export function getDb() {
  if (!_db) throw new Error("DB not opened; call openDb(path) first.");
  return _db;
}

export function closeDb() {
  if (!_db) return;
  _db.close();
  _db = null;
  _dbPath = null;
}

function initSchema(db) {
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(sql);
}

// Quick CLI: `node db.js --init <path>` creates an empty database file.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === "--init") {
    const path = args[1] || "arc.db";
    if (existsSync(path)) {
      console.error(`Refusing to overwrite existing ${path}.`);
      process.exit(2);
    }
    openDb(path);
    console.log(`Initialised ${path}`);
    closeDb();
  } else {
    console.log("usage: node db.js --init <path>");
  }
}
