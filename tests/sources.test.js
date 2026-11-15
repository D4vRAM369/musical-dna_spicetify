// Fuentes de candidatos puras (diseño §5.3). Reciben las exclusiones ya calculadas.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../musical-dna.js");
const { now, r } = require("./helpers.js");

test("historial: por afinidad, con porqué", () => {
  const c = core.historyCandidates([r("a", 5), r("a", 6), r("b", 5)], now, new Set());
  assert.equal(c[0].uri, "a");
  assert.equal(c[0].source, "historial");
  assert.equal(c[0].artist, "Aa");
  assert.match(c[0].why, /la escuchaste 2× · hace 5 días que no suena/);
});

test("historial: respeta exclusiones", () => {
  assert.deepEqual(core.historyCandidates([r("a", 5), r("b", 5)], now, new Set(["a"])).map((c) => c.uri), ["b"]);
});

test("favoritas: primero las menos escuchadas, con porqué", () => {
  const liked = [{ uri: "a", title: "A" }, { uri: "b", title: "B" }];
  const c = core.favoriteCandidates(liked, [r("a", 5)], new Set());
  assert.deepEqual(c.map((x) => x.uri), ["b", "a"]);
  assert.equal(c[0].source, "favoritas");
  assert.match(c[0].why, /en tus favoritas · la has puesto 0×/);
});

test("favoritas: empate conserva el orden original y respeta exclusiones", () => {
  const liked = [{ uri: "a" }, { uri: "b" }, { uri: "c" }];
  assert.deepEqual(core.favoriteCandidates(liked, [], new Set(["b"])).map((x) => x.uri), ["a", "c"]);
});

test("similares: sin conocidas, sin duplicados, intercaladas", () => {
  const g = [
    { seedTitle: "S1", relatedName: "R1", tracks: [{ uri: "k" }, { uri: "n1" }, { uri: "n2" }] },
    { seedTitle: "S2", relatedName: "R2", tracks: [{ uri: "m1" }, { uri: "n1" }] },
  ];
  const c = core.similarCandidates(g, new Set(["k"]), new Set());
  assert.deepEqual(c.map((x) => x.uri), ["n1", "m1", "n2"]);
  assert.equal(c[0].source, "similares");
  assert.equal(c[0].why, "parecida a S1 · relacionado con R1");
});

test("similares: respeta exclusiones", () => {
  const g = [{ seedTitle: "S", relatedName: "R", tracks: [{ uri: "x" }, { uri: "y" }] }];
  assert.deepEqual(core.similarCandidates(g, new Set(), new Set(["x"])).map((c) => c.uri), ["y"]);
});
