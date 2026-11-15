// Lectura en solo lectura de la base de LI (diseño §5.1).
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../musical-dna.js");
const { fakeIDB } = require("./fake-idb.js");
const { r } = require("./helpers.js");

const LI = (meta, records) => ({ "listening-intelligence": { meta: { meta }, records } });

test("sin base: sin-li y NO la crea", async () => {
  const idb = fakeIDB({});
  const res = await core.readLiData(idb);
  assert.equal(res.status, "sin-li");
  assert.equal(idb.created, false);
});

test("base sin almacenes: sin-li y cierra", async () => {
  const idb = fakeIDB({ "listening-intelligence": {} });
  assert.equal((await core.readLiData(idb)).status, "sin-li");
  assert.equal(idb.closed, true);
});

test("ok: lee en readonly y cierra", async () => {
  const idb = fakeIDB(LI({ schemaVersion: 1, observingSince: 5 }, [r("a", 0)]));
  const res = await core.readLiData(idb);
  assert.equal(res.status, "ok");
  assert.equal(res.records.length, 1);
  assert.equal(res.observingSince, 5);
  assert.equal(res.version, 1);
  assert.deepEqual(idb.modes, ["readonly"]);
  assert.equal(idb.closed, true);
});

test("schemaVersion 2 → incompatible con la versión", async () => {
  const res = await core.readLiData(fakeIDB(LI({ schemaVersion: 2 }, [r("a", 0)])));
  assert.equal(res.status, "incompatible");
  assert.equal(res.version, 2);
});

test("sin meta → incompatible", async () => {
  assert.equal((await core.readLiData(fakeIDB(LI(undefined, [r("a", 0)])))).status, "incompatible");
});

test("sin registros → vacio", async () => {
  assert.equal((await core.readLiData(fakeIDB(LI({ schemaVersion: 1, observingSince: 5 }, [])))).status, "vacio");
});

test("getAll falla → error y cierra", async () => {
  const idb = fakeIDB(LI({ schemaVersion: 1 }, [r("a", 0)]), { failGetAll: true });
  const res = await core.readLiData(idb);
  assert.equal(res.status, "error");
  assert.match(res.error, /getAll falló/);
  assert.equal(idb.closed, true);
});

test("sin IndexedDB en absoluto → error", async () => {
  assert.equal((await core.readLiData(undefined)).status, "error");
});
