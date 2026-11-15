// Afinidad por horizonte, semillas y antigusto (diseño §5.2).
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../musical-dna.js");
const { now, r } = require("./helpers.js");

test("la más escuchada y en más días gana con 100", () => {
  const recs = [r("x", 0), r("x", 1), r("x", 2), r("y", 0)];
  const s = core.seeds(recs, "total", now).items;
  assert.equal(s[0].uri, "x");
  assert.equal(s[0].score, 100);
  assert.equal(s[0].days, 3);
  assert.equal(s[0].valid, 3);
  assert.ok(s[1].score < 100);
});

test("reciente excluye lo de hace más de 7 días", () => {
  assert.equal(core.seeds([r("x", 8)], "reciente", now).items.length, 0);
  assert.equal(core.seeds([r("x", 8)], "total", now).items.length, 1);
});

test("decaimiento: en medio, lo de ayer pesa más que lo de hace 20 días", () => {
  const s = core.seeds([r("old", 20), r("new", 1)], "medio", now).items;
  assert.equal(s[0].uri, "new");
  assert.ok(s[1].score < 100);
});

test("weak con pocas válidas o un solo día", () => {
  assert.equal(core.seeds([r("x", 0), r("x", 0), r("x", 0)], "total", now).items[0].weak, true); // 3 válidas, 1 día
  assert.equal(core.seeds([r("x", 0), r("x", 1), r("x", 2)], "total", now).items[0].weak, false);
});

test("saltos restan y score negativo no aparece", () => {
  const s = core.seeds([r("x", 0, 1000), r("x", 0, 1000)], "total", now);
  assert.equal(s.items.length, 0);
  assert.equal(s.total, 0);
});

test("señales: escuchas, válidas, saltos y última escucha", () => {
  const x = core.seeds([r("x", 0), r("x", 2, 1000)], "total", now).items[0];
  assert.deepEqual([x.listens, x.valid, x.skips, x.lastAt], [2, 1, 1, now]);
  assert.equal(x.artist, "Ax");
});

test("máximo 10 semillas; total cuenta todas", () => {
  const recs = Array.from({ length: 12 }, (_, i) => r("u" + i, 0));
  const s = core.seeds(recs, "total", now);
  assert.equal(s.items.length, 10);
  assert.equal(s.total, 12);
});

test("ignora lo que no es canción", () => {
  assert.equal(core.seeds([{ ...r("ep", 0), kind: "episode" }], "total", now).items.length, 0);
});

test("antigusto: 3 saltos y ninguna válida", () => {
  const a = core.antitaste([r("z", 0, 1000), r("z", 1, 1000), r("z", 2, 1000), r("w", 0, 1000), r("w", 0, 1000), r("w", 0)]);
  assert.deepEqual(a.map((x) => x.uri), ["z"]);
  assert.equal(a[0].skips, 3);
});
