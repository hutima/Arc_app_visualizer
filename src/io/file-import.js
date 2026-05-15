// File reading + batch import. UI calls importFiles() and receives per-file results.

import { parseGpx, GpxParseError } from "../parser/gpx-parser.js";

async function readAsText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/**
 * @param {File[]} files
 * @returns {Promise<{ok: import("../model/types.js").Source[], errors: {file:string, error:string}[]}>}
 */
export async function importFiles(files) {
  const ok = [];
  const errors = [];
  for (const f of files) {
    try {
      const txt = await readAsText(f);
      ok.push(parseGpx(txt, f.name));
    } catch (e) {
      const msg = e instanceof GpxParseError ? e.message : (e?.message || String(e));
      errors.push({ file: f.name, error: msg });
    }
  }
  return { ok, errors };
}
