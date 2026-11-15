// Adaptadores de Spotify con respaldo (diseño §5.3). Formas comprobadas por CDP el 2026-11-14.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../musical-dna.js");

const libItem = (i) => ({ uri: "spotify:track:" + i, name: "T" + i, album: { artist: { uri: "spotify:artist:a" + i, name: "A" + i }, images: [{ url: "spotify:image:img" + i }] } });
function libS(pages) {
  let call = 0;
  return { Platform: { LibraryAPI: { getTracks: async ({ offset, limit }) => ({ items: pages[call++] ?? [], offset, limit, totalLength: 0 }) } } };
}

const topTrack = (id) => ({ track: { uri: "spotify:track:" + id, name: "N" + id, artists: { items: [{ uri: "spotify:artist:r", profile: { name: "R" } }] }, albumOfTrack: { coverArt: { sources: [{ url: "https://i.scdn.co/image/" + id }] } } } });
function gqlS() {
  const S = { calls: 0, GraphQL: { Definitions: { queryArtistRelated: "REL", queryArtistOverview: "OV" } } };
  S.GraphQL.Request = async (def, vars) => {
    S.calls += 1;
    if (def === "REL") return { data: { artistUnion: { relatedContent: { relatedArtists: { items: [{ uri: "spotify:artist:r1", profile: { name: "R1" } }, { uri: "spotify:artist:r2", profile: { name: "R2" } }] } } } } };
    return { data: { artistUnion: { discography: { topTracks: { items: [topTrack(vars.uri + "-1"), topTrack(vars.uri + "-2")] } } } } };
  };
  return S;
}
const seeds = [{ title: "S", artistUri: "spotify:artist:a1" }];

test("imageUrl", () => {
  assert.equal(core.imageUrl("spotify:image:ab12"), "https://i.scdn.co/image/ab12");
  assert.equal(core.imageUrl("https://i.scdn.co/image/x"), "https://i.scdn.co/image/x");
  assert.equal(core.imageUrl("x"), null);
  assert.equal(core.imageUrl(undefined), null);
});

test("favoritas: pagina hasta vacío aunque totalLength sea 0", async () => {
  const p1 = Array.from({ length: 50 }, (_, i) => libItem(i));
  const p2 = Array.from({ length: 20 }, (_, i) => libItem(50 + i));
  const res = await core.fetchFavorites(libS([p1, p2, []]));
  assert.equal(res.ok, true);
  assert.equal(res.liked.length, 70);
  assert.deepEqual(res.liked[0], { uri: "spotify:track:0", title: "T0", artist: "A0", artistUri: "spotify:artist:a0", image: "https://i.scdn.co/image/img0" });
});

test("favoritas: tope de 500", async () => {
  const page = Array.from({ length: 50 }, (_, i) => libItem(i));
  assert.equal((await core.fetchFavorites(libS(Array(20).fill(page)))).liked.length, 500);
});

test("favoritas: LibraryAPI ausente o que lanza → ok:false", async () => {
  assert.equal((await core.fetchFavorites({ Platform: {} })).ok, false);
  const boom = { Platform: { LibraryAPI: { getTracks: async () => { throw new Error("x"); } } } };
  assert.equal((await core.fetchFavorites(boom)).ok, false);
});

test("similares: relacionados → top tracks, con caché", async () => {
  const S = gqlS();
  const cache = new Map();
  const res = await core.fetchSimilarGroups(S, seeds, cache);
  assert.equal(res.ok, true);
  assert.equal(res.groups.length, 2);
  assert.equal(res.groups[0].seedTitle, "S");
  assert.equal(res.groups[0].relatedName, "R1");
  assert.equal(res.groups[0].tracks.length, 2);
  assert.deepEqual(res.groups[0].tracks[0], { uri: "spotify:track:spotify:artist:r1-1", title: "Nspotify:artist:r1-1", artist: "R", artistUri: "spotify:artist:r", image: "https://i.scdn.co/image/spotify:artist:r1-1" });
  assert.equal(S.calls, 3);
  await core.fetchSimilarGroups(S, seeds, cache);
  assert.equal(S.calls, 3); // no repite llamadas
});

test("similares: semillas con el mismo artista se consultan una vez", async () => {
  const S = gqlS();
  await core.fetchSimilarGroups(S, [...seeds, { title: "S2", artistUri: "spotify:artist:a1" }], new Map());
  assert.equal(S.calls, 3);
});

test("similares: GraphQL lanza, data null o sin Definitions → ok:false con motivo", async () => {
  const throwingS = { GraphQL: { Definitions: { queryArtistRelated: 1, queryArtistOverview: 2 }, Request: async () => { throw new Error("x"); } } };
  const nullDataS = { GraphQL: { Definitions: { queryArtistRelated: 1, queryArtistOverview: 2 }, Request: async () => ({ data: null }) } };
  assert.deepEqual(await core.fetchSimilarGroups(throwingS, seeds, new Map()), { ok: false, reason: "Spotify no responde" });
  assert.equal((await core.fetchSimilarGroups(nullDataS, seeds, new Map())).ok, false);
  assert.equal((await core.fetchSimilarGroups({}, seeds, new Map())).ok, false);
});

test("similares: sin semillas → ok con 0 grupos", async () => {
  assert.deepEqual(await core.fetchSimilarGroups(gqlS(), [], new Map()), { ok: true, groups: [] });
});

test("similares: las llamadas van en paralelo (no 40 en serie)", async () => {
  const S = gqlS();
  const inner = S.GraphQL.Request;
  let inFlight = 0, maxInFlight = 0;
  S.GraphQL.Request = async (def, vars) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((res) => setTimeout(res, 5));
    inFlight -= 1;
    return inner(def, vars);
  };
  const res = await core.fetchSimilarGroups(S, [{ title: "S1", artistUri: "spotify:artist:a1" }, { title: "S2", artistUri: "spotify:artist:a2" }], new Map());
  assert.ok(maxInFlight >= 2, `máximo en vuelo: ${maxInFlight}`);
  assert.deepEqual(res.groups.map((g) => g.seedTitle + "/" + g.relatedName), ["S1/R1", "S1/R2", "S2/R1", "S2/R2"]); // orden estable
});
