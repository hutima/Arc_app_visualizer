// Derive the {sources-visible} X {types-visible} product from the store.
// The layer-manager calls this on every filter change and adjusts the map.

export function currentVisibility(store) {
  const visibleSources = new Set();
  for (const s of store.listSources()) if (store.isSourceVisible(s.id)) visibleSources.add(s.id);
  const visibleTypes = new Set();
  for (const t of store.listTypes()) if (store.isTypeVisible(t)) visibleTypes.add(t);
  return { visibleSources, visibleTypes };
}
