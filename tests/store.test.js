// Almacén propio de pruebas «musical-dna:v1» (diseño §5.6).
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../musical-dna.js");

test("null → vacío sin aviso", () => {
  assert.deepEqual(core.parseStore(null), { state: { schemaVersion: 1, trials: [] }, warning: null });
});

test("corrupto → vacío con aviso", () => {
  for (const raw of ["{no", '{"schemaVersion":2,"trials":[]}', '{"schemaVersion":1,"trials":5}', "null"]) {
    const p = core.parseStore(raw);
    assert.equal(p.state.trials.length, 0, raw);
    assert.equal(p.warning, "Datos de Musical DNA ilegibles: se empieza de cero", raw);
  }
});

test("filtra pruebas mal formadas", () => {
  const raw = JSON.stringify({ schemaVersion: 1, trials: [{ uri: "a", source: "historial", at: 1 }, { uri: "b" }, { source: "x", at: 2 }, { uri: "c", source: "favoritas", at: "3" }] });
  assert.deepEqual(core.parseStore(raw).state.trials.map((t) => t.uri), ["a"]);
});

test("addTrial recorta a 2000 y no muta", () => {
  const s0 = { schemaVersion: 1, trials: Array.from({ length: 2000 }, (_, i) => ({ uri: "u" + i, source: "historial", at: i })) };
  const s = core.addTrial(s0, { uri: "new", source: "favoritas", at: 9999, action: "play" });
  assert.equal(s.trials.length, 2000);
  assert.equal(s.trials[0].uri, "u1");
  assert.equal(s.trials.at(-1).uri, "new");
  assert.equal(s0.trials.length, 2000);
  assert.equal(s0.trials.at(-1).uri, "u1999");
});

test("ida y vuelta", () => {
  const s = core.addTrial(core.parseStore(null).state, { uri: "a", source: "historial", why: "w", at: 1, action: "queue" });
  assert.deepEqual(core.parseStore(core.serializeStore(s)).state, s);
});
