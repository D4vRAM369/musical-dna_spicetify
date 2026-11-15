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

test("arranque en frío: con todas sin pruebas, la tanda rota entre fuentes", () => {
  const pools = { historial: [c("h1"), c("h2")], favoritas: [c("f1", "favoritas"), c("f2", "favoritas")], similares: [c("s1", "similares"), c("s2", "similares")] };
  const b = core.pickBatch(pools, core.armStats([], [], now), () => 0.99, 6);
  assert.deepEqual(b.map((x) => x.uri), ["h1", "f1", "s1", "h2", "f2", "s2"]);
});

test("una fuente sin pruebas se prueba primero; después manda el valor", () => {
  const pools = { historial: [c("h1"), c("h2")], favoritas: [c("f1", "favoritas"), c("f2", "favoritas")], similares: [c("s1", "similares")] };
  const stats = { historial: { trials: 2, value: 0.9 }, favoritas: { trials: 0, value: 0.5 }, similares: { trials: 3, value: 0.2 } };
  assert.deepEqual(core.pickBatch(pools, stats, () => 0.99, 3).map((x) => x.uri), ["f1", "h1", "h2"]);
});

test("banditSentence avisa de las fuentes sin probar", () => {
  const s = { historial: { trials: 2, value: 0.7 }, favoritas: { trials: 0, value: 0.5 }, similares: { trials: 0, value: 0.5 } };
  assert.equal(core.banditSentence(s, ["historial", "favoritas", "similares"]),
    "Primero probaré Favoritas y Similares (aún sin pruebas); después apostaré por la que más acierte");
});

test("guardar (like) es acierto al instante, aunque luego se salte o no suene", () => {
  const like = (uri, minsAgo) => ({ ...T(uri, minsAgo), action: "like" });
  assert.equal(core.resolveTrial(like("l", 1), [], now), "hit");
  assert.equal(core.resolveTrial(like("l", 60), [at(r("l", 0, 1000), 50)], now), "hit");
  assert.equal(core.resolveTrial(like("l", 7 * 60), [], now), "hit");
  assert.equal(core.armStats([like("l", 1)], [], now).historial.hits, 1);
});

test("betaSample: estadístico de orden con rng controlado", () => {
  const seq = [0.9, 0.2, 0.5];
  let i = 0; // a=2, b=2 → 3 uniformes ordenadas [0.2, 0.5, 0.9] → la 2.ª
  assert.equal(core.betaSample(2, 2, () => seq[i++]), 0.5);
});

test("betaSample: media de Beta(3,1) ≈ 0,75 y Beta(1,5) baja, sin NaN", () => {
  const rng = core.seededRng(42);
  const mean = (a, b) => { let s = 0; for (let k = 0; k < 4000; k++) s += core.betaSample(a, b, rng); return s / 4000; };
  assert.ok(Math.abs(mean(3, 1) - 0.75) < 0.02);
  assert.ok(Math.abs(mean(1, 5) - 1 / 6) < 0.02);
});

test("seededRng: misma semilla, misma secuencia, en [0,1)", () => {
  const a = core.seededRng(7), b = core.seededRng(7);
  for (let k = 0; k < 5; k++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
});
