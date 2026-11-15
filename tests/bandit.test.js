// Atribución de pruebas, exclusiones y bandido ε-greedy (diseño §5.4–5.5).
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../musical-dna.js");
const { now, r, tresSaltos, c } = require("./helpers.js");

const T = (uri, minsAgo, source = "historial") => ({ uri, source, why: "", at: now - minsAgo * 60e3, action: "play" });
const at = (rec, minsAgo) => ({ ...rec, startedAt: now - minsAgo * 60e3 });

test("excluye escuchas de las últimas 72 h y el antigusto", () => {
  const ex = core.excludedUris({ records: [r("x", 1), r("old", 5), ...tresSaltos("z")], trials: [], lastBatch: [], now });
  assert.ok(ex.has("x"));
  assert.ok(ex.has("z"));
  assert.ok(!ex.has("old"));
});

test("prueba pendiente y tanda anterior excluidas; prueba descartada no", () => {
  const ex = core.excludedUris({ records: [], trials: [T("p", 60), T("d", 7 * 60)], lastBatch: ["lb"], now });
  assert.ok(ex.has("p"));
  assert.ok(ex.has("lb"));
  assert.ok(!ex.has("d"));
});

test("hit, miss, pending, discarded", () => {
  const recs = [at(r("h", 0), 50), at(r("m", 0, 1000), 50)];
  assert.equal(core.resolveTrial(T("h", 60), recs, now), "hit");
  assert.equal(core.resolveTrial(T("m", 60), recs, now), "miss");
  assert.equal(core.resolveTrial(T("p", 60), recs, now), "pending");
  assert.equal(core.resolveTrial(T("d", 7 * 60), recs, now), "discarded");
});

test("registro anterior a la prueba no cuenta", () => {
  assert.equal(core.resolveTrial(T("h", 60), [at(r("h", 0), 120)], now), "pending");
});

test("cuenta el PRIMER registro tras la prueba", () => {
  assert.equal(core.resolveTrial(T("h", 60), [at(r("h", 0), 10), at(r("h", 0, 1000), 50)], now), "miss");
});

test("registro fuera de la ventana de 6 h no cuenta", () => {
  assert.equal(core.resolveTrial(T("h", 8 * 60), [at(r("h", 0), 60)], now), "discarded");
});

test("armStats: Laplace y brazos sin datos a 0.5", () => {
  const s = core.armStats([T("h", 60), T("p", 60, "favoritas")], [at(r("h", 0), 50)], now);
  assert.equal(s.historial.value, 2 / 3);
  assert.equal(s.historial.trials, 1);
  assert.equal(s.historial.hits, 1);
  assert.equal(s.favoritas.value, 0.5);
  assert.equal(s.favoritas.pending, 1);
  assert.equal(s.similares.trials, 0);
});

test("pickBatch greedy con rng alto; hueco 1 es la apuesta", () => {
  const pools = { historial: [c("h1"), c("h2")], favoritas: [c("f1", "favoritas")], similares: [] };
  const stats = { historial: { value: 0.9 }, favoritas: { value: 0.1 }, similares: { value: 0.5 } };
  const b = core.pickBatch(pools, stats, () => 0.99, 3);
  assert.deepEqual(b.map((x) => x.uri), ["h1", "h2", "f1"]);
  assert.equal(b[0].bet, true);
  assert.ok(!b[1].bet);
});

test("pickBatch explora con rng bajo (hueco 2 en adelante)", () => {
  const seq = [0.99, 0.1, 0.9];
  let i = 0; // hueco 1 greedy · hueco 2: 0.1 < ε → explora, índice floor(0.9 × 2) = 1 → favoritas
  const pools = { historial: [c("h1"), c("h2")], favoritas: [c("f1", "favoritas")], similares: [] };
  const stats = { historial: { value: 0.9 }, favoritas: { value: 0.1 }, similares: { value: 0.5 } };
  assert.deepEqual(core.pickBatch(pools, stats, () => seq[i++], 2).map((x) => x.uri), ["h1", "f1"]);
});

test("pickBatch: empate de valor sigue el orden historial, favoritas, similares", () => {
  const pools = { historial: [], favoritas: [c("f1", "favoritas")], similares: [c("s1", "similares")] };
  const stats = core.armStats([], [], now);
  assert.equal(core.pickBatch(pools, stats, () => 0.99, 1)[0].uri, "f1");
});

test("pickBatch sin brazos devuelve []", () => {
  assert.deepEqual(core.pickBatch({ historial: [], favoritas: [], similares: [] }, {}, Math.random), []);
});

test("banditSentence", () => {
  const s = { historial: { value: 0.7 }, favoritas: { value: 0.5 }, similares: { value: 0.5 } };
  assert.equal(core.banditSentence(s, ["historial", "favoritas"]), "Ahora apostaría por Historial (80 % de las veces) y exploraría el 20 %");
  assert.equal(core.banditSentence(s, []), "Sin fuentes disponibles");
});
