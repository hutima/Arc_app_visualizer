// Renderer-side export shim. Streaming GPX serialization happens in the
// main process - see electron/gpx-export.js. Here we just trigger the IPC
// calls and surface result paths back to the UI.

export async function exportMerged(sourceIds) {
  return await window.api.exportMerged(sourceIds);
}

export async function exportPerFile(sourceIds) {
  return await window.api.exportPerFile(sourceIds);
}
