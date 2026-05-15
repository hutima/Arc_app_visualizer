// Minimal pub/sub. Modules subscribe to the store's events without importing the store
// directly - that's what keeps map/UI/editing decoupled.

export function createBus() {
  const listeners = new Map();
  return {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try { fn(payload); } catch (e) { console.error(`[bus:${event}]`, e); }
      }
    },
  };
}
