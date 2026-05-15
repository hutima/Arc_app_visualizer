#!/usr/bin/env node
// Local HTTP server: serves the desktop client + REST API backed by SQLite.
//
// Personal-use only. Binds to 127.0.0.1 by default. CORS is off; treat
// this like a localhost dev server.

import "./dom-shim.js";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { openDb } from "./db.js";
import {
  listSourcesSummary, listTypesSummary, loadFullSource, deleteSource,
  listAnchorPairs, upsertAnchorPair, deleteAnchorPair,
  listCanonicalPaths, upsertCanonicalPath, deleteCanonicalPath,
} from "./queries.js";
import { findMatches } from "../src/editing/canonical-path/matcher.js";
import { serializeSource, serializeMerged } from "../src/serializer/gpx-serializer.js";
import { ingestFile } from "./source-loader.js";
import { parseGpx } from "../src/parser/gpx-parser.js";
import { insertSource } from "./source-loader.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, "..", "..");        // repo root
const DESKTOP_ROOT = resolve(__filename, "..");      // .../desktop
const WEB_ROOT = join(DESKTOP_ROOT, "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gpx":  "application/gpx+xml; charset=utf-8",
  ".png":  "image/png",
  ".webmanifest": "application/manifest+json",
  ".svg":  "image/svg+xml",
};

function parseArgs(argv) {
  let dbPath = "arc.db", port = 8765, host = "127.0.0.1";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") dbPath = argv[++i];
    else if (a === "--port") port = Number(argv[++i]);
    else if (a === "--host") host = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: node serve.js [--db ./arc.db] [--port 8765] [--host 127.0.0.1]");
      process.exit(0);
    }
  }
  return { dbPath, port, host };
}

function send(res, code, payload, headers = {}) {
  if (typeof payload === "string") {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", ...headers });
    res.end(payload);
  } else if (payload instanceof Buffer) {
    res.writeHead(code, headers);
    res.end(payload);
  } else {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(payload));
  }
}

async function readJsonBody(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limitBytes) { req.destroy(); reject(new Error("payload too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks).toString("utf-8");
        resolve(buf ? JSON.parse(buf) : null);
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function readRawBody(req, limitBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limitBytes) { req.destroy(); reject(new Error("payload too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------- Static files ----------

const STATIC_ROOTS = [
  { mount: "/src/",   root: join(ROOT, "src") },
  { mount: "/styles/",root: join(ROOT, "styles") },
  { mount: "/icons/", root: join(ROOT, "icons") },
  { mount: "/samples/", root: join(ROOT, "samples") },
  { mount: "/web/",   root: WEB_ROOT },
];

async function tryServeStatic(req, res) {
  let path = req.url.split("?")[0];
  if (path === "/" || path === "") {
    // Redirect so the browser URL becomes /web/desktop.html, which makes
    // relative imports in the HTML resolve the same way they do under the
    // Electron app:// protocol.
    res.writeHead(302, { Location: "/web/desktop.html" });
    res.end();
    return true;
  }

  for (const { mount, root } of STATIC_ROOTS) {
    if (path.startsWith(mount)) {
      const rel = path.slice(mount.length);
      const abs = normalize(join(root, rel));
      if (!abs.startsWith(root)) { send(res, 403, "forbidden"); return true; }
      if (!existsSync(abs) || !statSync(abs).isFile()) return false;
      const ext = extname(abs).toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      const body = await readFile(abs);
      send(res, 200, body, { "Content-Type": mime, "Cache-Control": "no-cache" });
      return true;
    }
  }
  return false;
}

// ---------- API ----------

function handleApi(db, req, res, url) {
  const { pathname, searchParams } = url;
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]

  // GET /api/health
  if (parts[1] === "health" && req.method === "GET") {
    return send(res, 200, { ok: true, dbPath: db.cwdPath, sqlite: db.prepare("SELECT sqlite_version() v").get().v });
  }

  // GET /api/sources
  if (parts[1] === "sources" && parts.length === 2 && req.method === "GET") {
    return send(res, 200, listSourcesSummary(db));
  }

  // GET /api/source/:id
  // DELETE /api/source/:id
  // GET /api/source/:id/export
  if (parts[1] === "source" && parts.length >= 3) {
    const id = parts[2];
    if (req.method === "GET" && parts.length === 3) {
      const src = loadFullSource(db, id);
      if (!src) return send(res, 404, { error: "not found" });
      return send(res, 200, src);
    }
    if (req.method === "DELETE" && parts.length === 3) {
      deleteSource(db, id);
      return send(res, 204, "");
    }
    if (req.method === "GET" && parts[3] === "export") {
      const src = loadFullSource(db, id);
      if (!src) return send(res, 404, { error: "not found" });
      const xml = serializeSource(src);
      return send(res, 200, xml, {
        "Content-Type": MIME[".gpx"],
        "Content-Disposition": `attachment; filename="${src.filename}"`,
      });
    }
  }

  // GET /api/export/merged
  if (parts[1] === "export" && parts[2] === "merged" && req.method === "GET") {
    const summaries = listSourcesSummary(db);
    if (!summaries.length) return send(res, 404, { error: "no sources" });
    const sources = summaries.map(s => loadFullSource(db, s.id)).filter(Boolean);
    const xml = serializeMerged(sources);
    return send(res, 200, xml, {
      "Content-Type": MIME[".gpx"],
      "Content-Disposition": `attachment; filename="merged.gpx"`,
    });
  }

  // GET /api/types
  if (parts[1] === "types" && req.method === "GET") {
    return send(res, 200, listTypesSummary(db));
  }

  // POST /api/match
  // body: AnchorPair plus optional { sourceIds: [...] } to scope.
  if (parts[1] === "match" && req.method === "POST") {
    return (async () => {
      const body = await readJsonBody(req);
      if (!body?.pair) return send(res, 400, { error: "missing pair" });
      const ids = body.sourceIds && body.sourceIds.length
        ? body.sourceIds
        : listSourcesSummary(db).map(s => s.id);
      const sources = ids.map(id => loadFullSource(db, id)).filter(Boolean);
      const matches = findMatches(sources, body.pair);
      send(res, 200, matches);
    })().catch(e => send(res, 500, { error: e.message }));
  }

  // GET /api/anchor-pairs
  // PUT /api/anchor-pair/:id    (body = AnchorPair shape; id can be "new" to mint)
  // DELETE /api/anchor-pair/:id
  if (parts[1] === "anchor-pairs" && req.method === "GET") {
    return send(res, 200, listAnchorPairs(db));
  }
  if (parts[1] === "anchor-pair" && parts.length === 3) {
    const id = parts[2];
    if (req.method === "PUT") {
      return (async () => {
        const body = await readJsonBody(req);
        if (!body) return send(res, 400, { error: "missing body" });
        const pair = {
          ...body,
          id: id === "new" ? `ap_${randomUUID()}` : id,
          createdAt: body.createdAt || Date.now(),
        };
        upsertAnchorPair(db, pair);
        send(res, 200, pair);
      })().catch(e => send(res, 500, { error: e.message }));
    }
    if (req.method === "DELETE") {
      deleteAnchorPair(db, id);
      return send(res, 204, "");
    }
  }

  // GET /api/canonical-paths
  // PUT /api/canonical-path/:id   (body = CanonicalPath; id == "new" mints)
  // DELETE /api/canonical-path/:id
  if (parts[1] === "canonical-paths" && req.method === "GET") {
    return send(res, 200, listCanonicalPaths(db));
  }
  if (parts[1] === "canonical-path" && parts.length === 3) {
    const id = parts[2];
    if (req.method === "PUT") {
      return (async () => {
        const body = await readJsonBody(req);
        if (!body?.anchorPairId) return send(res, 400, { error: "missing anchorPairId" });
        const cp = {
          ...body,
          id: id === "new" ? `cp_${randomUUID()}` : id,
          updatedAt: body.updatedAt || Date.now(),
        };
        upsertCanonicalPath(db, cp);
        send(res, 200, cp);
      })().catch(e => send(res, 500, { error: e.message }));
    }
    if (req.method === "DELETE") {
      deleteCanonicalPath(db, id);
      return send(res, 204, "");
    }
  }

  // POST /api/ingest    (body = raw GPX bytes; ?filename=... required)
  if (parts[1] === "ingest" && req.method === "POST") {
    return (async () => {
      const filename = searchParams.get("filename");
      if (!filename) return send(res, 400, { error: "missing ?filename=" });
      const buf = await readRawBody(req);
      const source = parseGpx(buf.toString("utf-8"), filename);
      const id = insertSource(source, db);
      send(res, 200, { id, filename });
    })().catch(e => send(res, 400, { error: e.message }));
  }

  return send(res, 404, { error: "not found" });
}

// ---------- Main ----------

async function main() {
  const { dbPath, port, host } = parseArgs(process.argv.slice(2));
  const db = openDb(dbPath);
  db.cwdPath = dbPath;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        return handleApi(db, req, res, url);
      }
      const served = await tryServeStatic(req, res);
      if (!served) send(res, 404, "not found");
    } catch (e) {
      console.error("[serve]", e);
      send(res, 500, { error: e.message });
    }
  });

  server.listen(port, host, () => {
    console.log(`ARC GPX Visualizer (desktop) listening at http://${host}:${port}/`);
    console.log(`Using database: ${dbPath}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
