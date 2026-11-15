// IndexedDB falsa mínima (Node no tiene). Imita lo que usa readLiData:
// open() sin versión, onupgradeneeded si la base no existe (y abort), transacciones readonly, get/getAll, close.
// dbs = { nombre: { meta: { clave: valor }, records: [...] } }. knobs.failGetAll: getAll falla.
function fakeIDB(dbs, knobs = {}) {
  const idb = { created: false, modes: [], closed: false };
  const later = (fn) => setTimeout(fn, 0);
  const request = (fn) => {
    const req = {};
    later(() => {
      try {
        req.result = fn();
        req.onsuccess?.({ target: req });
      } catch (e) {
        req.error = e;
        req.onerror?.({ target: req });
      }
    });
    return req;
  };
  idb.open = (name) => {
    const req = {};
    later(() => {
      if (!(name in dbs)) {
        let aborted = false;
        req.transaction = { abort: () => (aborted = true) };
        req.onupgradeneeded?.({ target: req });
        if (aborted) {
          req.error = Object.assign(new Error("aborted"), { name: "AbortError" });
          return req.onerror?.({ target: req });
        }
        idb.created = true; // si nadie aborta, el navegador crea la base vacía
        dbs[name] = {};
      }
      const data = dbs[name];
      req.result = {
        objectStoreNames: { contains: (n) => n in data },
        close: () => (idb.closed = true),
        transaction(stores, mode) {
          idb.modes.push(mode);
          return {
            objectStore: (n) => ({
              get: (k) => request(() => data[n][k]),
              getAll: () => request(() => {
                if (knobs.failGetAll) throw new Error("getAll falló");
                return [...data[n]];
              }),
            }),
          };
        },
      };
      req.onsuccess?.({ target: req });
    });
    return req;
  };
  return idb;
}

module.exports = { fakeIDB };
