// Renderer-side import shim. The actual streaming GPX parser lives in the
// main process - see electron/gpx-import.js. We just hand it file paths and
// surface the per-file ok/error result back to the UI.

export async function pickAndImport(store, onProgress) {
  const paths = await window.api.pickGpxFiles();
  if (!paths.length) return { ok: [], errors: [], canceled: true };
  return await importPaths(store, paths, onProgress);
}

export async function importPaths(store, paths, onProgress) {
  let off = null;
  if (onProgress) off = window.api.onImportProgress(onProgress);
  try {
    return await store.importPaths(paths);
  } finally {
    if (off) off();
  }
}
