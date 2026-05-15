# ARC GPX Visualizer - Desktop

A self-contained Electron app for the ARC GPX Visualizer. Same Leaflet UI
as the browser PWA at the repo root, but data lives in a bundled SQLite
database instead of browser memory. Designed for personal use against
hundreds of MB of GPX exports.

## Why this exists

The static PWA at the repo root loads GPX files into memory. Once your
corpus grows past a few hundred MB that stops working - the browser
chokes on parsing and rendering, and there's no persistent state for
anchor pairs or canonical paths. This desktop variant:

- **Stores GPX in SQLite** with packed binary blobs for segment points
  (~16 bytes / point) and a pre-computed per-track bbox + R*Tree index.
  A 500 MB GPX corpus fits in a 500 MB - 1 GB DB.
- **Loads sources on demand.** The Library card lists everything in the
  DB; you click `+` to load a source into the map and `-` to unload it.
  Browser memory only carries what you're actively inspecting.
- **Persists anchor pairs and canonical paths.** Define a Home <-> Work
  pair once, it's there next time you open the app.
- **No external server.** Everything runs in-process via Electron IPC.

## Quick start

```sh
cd desktop
npm install            # better-sqlite3 + xmldom + electron + electron-rebuild
                       # postinstall rebuilds better-sqlite3 for Electron's Node ABI
npm start              # launches the Electron app
```

First run creates the SQLite database at the OS-standard userData
location (e.g. `~/Library/Application Support/...` on macOS,
`%APPDATA%` on Windows, `~/.config/...` on Linux). Use **File > Open
Database** to point at a custom path.

### Importing GPX

Three ways, pick whichever fits:

1. **Drag-drop** any number of `.gpx` files onto the window.
2. **Import GPX...** button in the Library card (native file dialog).
3. **File > Import GPX...** menu (Cmd/Ctrl+O).

Files are ingested in the main process so big imports don't block the
UI. Already-imported filenames are skipped automatically.

## Headless / scripted use

The same data layer also runs as a standalone Node HTTP server, useful
for running on a NAS or batch-ingesting a folder of files:

```sh
cd desktop
npm run rebuild:node     # swap better-sqlite3 back to the Node ABI
node ingest.js --db ./arc.db /path/to/folder
node serve.js --db ./arc.db --port 8765
# browse http://127.0.0.1:8765/
npm run rebuild:electron # swap back to Electron ABI before npm start
```

The `rebuild:node` / `rebuild:electron` scripts swap which `.node`
binary is installed. Pick the one matching the runtime you're about
to use.

## Architecture

```
desktop/
  package.json
  schema.sql              SQLite tables + R*Tree index
  db.js                   connection + schema init
  codec.js                segment-point blob encode / decode
  dom-shim.js             DOMParser/XMLSerializer polyfill for Node;
                          patches xmldom's NamedNodeMap/NodeList to iterate
  source-loader.js        GPX -> DB (reuses src/parser/gpx-parser.js)
  queries.js              reads + writes for sources, tracks, anchors, canonicals
  ingest.js               CLI for batch ingest
  serve.js                HTTP server (headless mode)
  electron/
    main.js               Electron entry: protocol handler, IPC handlers, menu
    preload.cjs           contextBridge exposing window.electronAPI
  web/
    desktop.html          renderer entry
    desktop.css           additions on top of /styles/app.css
    main.js               renderer bootstrap (reuses everything under /src/)
    api-client.js         dual-mode: Electron IPC if available, HTTP fetch otherwise
    library.js            Library card with load/unload toggles + ingest UI
    persistence-bridge.js mirrors anchor/canonical changes to the data layer
```

The Electron main process registers an `app://-/<path>` protocol that
serves files from the repo root. The renderer's HTML and JS use the
same relative paths (`../../src/...`, `../../styles/...`) in both
Electron mode and HTTP mode, so the same files work without
modification across both runtimes.

## IPC / HTTP surface

| Operation                  | IPC channel              | HTTP                                  |
|----------------------------|--------------------------|---------------------------------------|
| health                     | `health`                 | `GET /api/health`                     |
| list sources               | `sources:list`           | `GET /api/sources`                    |
| load full source           | `source:load`            | `GET /api/source/:id`                 |
| delete source              | `source:remove`          | `DELETE /api/source/:id`              |
| list distinct types        | `types`                  | `GET /api/types`                      |
| match anchor pair          | `match`                  | `POST /api/match`                     |
| list anchor pairs          | `anchorPairs:list`       | `GET /api/anchor-pairs`               |
| upsert anchor pair         | `anchorPairs:upsert`     | `PUT /api/anchor-pair/:id`            |
| delete anchor pair         | `anchorPairs:delete`     | `DELETE /api/anchor-pair/:id`         |
| list canonical paths       | `canonicalPaths:list`    | `GET /api/canonical-paths`            |
| upsert canonical path      | `canonicalPaths:upsert`  | `PUT /api/canonical-path/:id`         |
| delete canonical path      | `canonicalPaths:delete`  | `DELETE /api/canonical-path/:id`      |
| ingest from dialog         | `ingest:dialog`          | n/a                                   |
| ingest from paths          | `ingest:paths`           | n/a                                   |
| ingest raw bytes           | `ingest:buffer`          | `POST /api/ingest?filename=...`       |
| export single source       | `export:source`          | `GET /api/source/:id/export`          |
| export merged              | `export:merged`          | `GET /api/export/merged`              |
| save arbitrary text        | `export:writeText`       | n/a                                   |

## Known limitations

- **Edit op persistence.** The canonical-path edits made through the
  canonical-card live in browser memory and are session-only, same as
  the static PWA. To bake them in, use the "Loaded files" export which
  writes the in-memory effective sources to GPX. A future change can
  persist ops to an `edits` table and replay them when sources load.
- **Viewport-aware track queries.** The R*Tree index is in the schema
  but the UI requires you to click "load" per source rather than
  panning the map to fetch tiles. Per-source loading keeps memory
  bounded for the corpus sizes we care about.
- **CLI vs Electron ABI.** better-sqlite3 ships separate prebuilt
  binaries for Node and Electron. The `postinstall` rebuilds for
  Electron by default. Use `npm run rebuild:node` to switch back if
  you want to run `node ingest.js` or `node serve.js` directly.

## Packaging a standalone binary

For a personal app you can just `npm start`. To produce a
double-clickable installer for macOS / Windows / Linux, add
`electron-builder` and a build target:

```sh
npm install --save-dev electron-builder
npx electron-builder --mac --win --linux
```

`electron-builder` config can live in `package.json`'s `build` field.
Not set up by default - it's a separate concern from the app working.
