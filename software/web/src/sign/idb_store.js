// idb_store.js - the IndexedDB persistence adapter for SignCapture in the
// browser. SHARED SOURCE: kept byte-identical with the copy in the
// sign-language stack (TAKTO-SIGN, not in this release), whose test suite
// enforces the parity so the store real operators depend on is the exact code
// its adversarial suite exercises in Node (against a fake indexedDB).
//
// Mirrors fs_store.mjs semantics:
//   - a sealed rep is persisted the instant it seals (one record per rep),
//   - getMeta distinguishes ABSENT (fresh session -> null) from CORRUPT
//     (throws, so rehydrate falls back to the rep records instead of silently
//     resetting and overwriting already-sealed reps),
//   - getReps skips a corrupt/torn rep record rather than throwing (one bad
//     record must not lose the whole otherwise-recoverable session),
//   - listSessions enumerates every session with a meta record, so a refreshed
//     page can find and resume an interrupted session.
// No DOM use: only globalThis.indexedDB, so Node tests can inject a fake.
// No em dashes.

export function idbStore(idb) {
  const IDB = idb || globalThis.indexedDB;
  const DB = "takto_sign", VER = 1;
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = IDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("reps")) db.createObjectStore("reps");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = async (name, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(name, mode), s = t.objectStore(name);
      const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  };
  const repKey = (id, index) => `${id}::${String(index).padStart(6, "0")}`;
  return {
    async putMeta(id, m) { await tx("meta", "readwrite", (s) => s.put(m, id)); },
    async getMeta(id) {
      const m = await tx("meta", "readonly", (s) => s.get(id));
      if (m === undefined || m === null) return null;             // absent
      if (typeof m !== "object") throw new Error("corrupt meta"); // torn write
      return m;
    },
    async putRep(id, rep) { await tx("reps", "readwrite", (s) => s.put(rep, repKey(id, rep.index))); },
    async getReps(id) {
      const db = await open();
      const keys = await new Promise((res, rej) => {
        const t = db.transaction("reps", "readonly"), s = t.objectStore("reps");
        const req = s.getAllKeys();
        req.onsuccess = () => res((req.result || []).filter((k) => String(k).startsWith(id + "::")));
        req.onerror = () => rej(req.error);
      });
      const out = [];
      for (const k of keys) {
        let rep = null;
        try { rep = await tx("reps", "readonly", (s) => s.get(k)); } catch (_) { continue; }
        // skip a corrupt/torn rep record (not an object, or no numeric index):
        // serialize() quarantines deeper value corruption
        if (rep && typeof rep === "object" && Number.isFinite(rep.index)) out.push(rep);
      }
      return out.sort((a, b) => a.index - b.index);
    },
    async listSessions() {
      try { return (await tx("meta", "readonly", (s) => s.getAllKeys())) || []; }
      catch (_) { return []; }
    },
    async clearSession(id) {
      await tx("meta", "readwrite", (s) => s.delete(id));
      const db = await open();
      const keys = await new Promise((res, rej) => {
        const t = db.transaction("reps", "readonly"), s = t.objectStore("reps");
        const req = s.getAllKeys();
        req.onsuccess = () => res((req.result || []).filter((k) => String(k).startsWith(id + "::")));
        req.onerror = () => rej(req.error);
      });
      for (const k of keys) await tx("reps", "readwrite", (s) => s.delete(k));
    },
  };
}
