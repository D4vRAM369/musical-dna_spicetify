// Datos de prueba compartidos por los tests del core.
const DAY = 864e5;
const now = new Date(2026, 10, 20, 12).getTime(); // 20/11/2026 12:00 local

// Registro de LI mínimo: canción `uri` escuchada hace `daysAgo` días, `playedMs` sonando (200 s = válida).
const r = (uri, daysAgo, playedMs = 200000) => ({
  id: `${now - daysAgo * DAY}-${uri}`,
  kind: "track",
  uri,
  title: uri,
  artists: [{ uri: "a:" + uri, name: "A" + uri }],
  durationMs: 200000,
  playedMs,
  startedAt: now - daysAgo * DAY,
});

// 3 saltos de la misma canción, hace 5–7 días (fuera de la ventana de 72 h).
const tresSaltos = (uri) => [r(uri, 5, 1000), r(uri, 6, 1000), r(uri, 7, 1000)];

// Candidato mínimo.
const c = (uri, source = "historial") => ({ uri, title: uri, artist: "A", artistUri: "a:" + uri, image: null, source, why: "" });

module.exports = { DAY, now, r, tresSaltos, c };
