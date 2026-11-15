// Lógica pura básica: clasificación de escuchas y utilidades.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../musical-dna.js");

test("classify: 30 s o 50 %", () => {
  assert.equal(core.classify(30000, 600000), "valid");
  assert.equal(core.classify(29999, 600000), "skipped");
  assert.equal(core.classify(20000, 40000), "valid"); // 50 %
  assert.equal(core.classify(20000, 0), "skipped"); // duración desconocida: solo cuenta la regla de 30 s
});

test("trackRecords ignora episodios, locales y otros", () => {
  const rs = [{ kind: "track" }, { kind: "episode" }, { kind: "local" }, { kind: "other" }];
  assert.equal(core.trackRecords(rs).length, 1);
});

test("artistName sin artistas", () => {
  assert.equal(core.artistName({ artists: [] }), "—");
  assert.equal(core.artistName({}), "—");
  assert.equal(core.artistName({ artists: [{ name: "Gary Moore" }] }), "Gary Moore");
});

test("dayKey usa la fecha local", () => {
  assert.equal(core.dayKey(new Date(2026, 10, 14, 23, 59).getTime()), "2026-11-14");
  assert.equal(core.dayKey(new Date(2026, 0, 5, 0, 1).getTime()), "2026-01-05");
});

test("CONST expone los valores del spec", () => {
  assert.equal(core.CONST.SIMS, 1000);
  assert.equal(core.CONST.SEED, 2026);
  assert.equal(core.CONST.BATCH, 10);
  assert.equal(core.CONST.STORE_KEY, "musical-dna:v1");
});
