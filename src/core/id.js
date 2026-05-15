// Stable opaque IDs. Not cryptographic; just unique within a session.

let counter = 0;
export function nextId(prefix) {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}
