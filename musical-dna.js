// Musical DNA — extensión de Spicetify: perfil de gusto explicable + mini-recomendador (bandido con Thompson sampling).
// Lee en SOLO LECTURA el historial de Listening Intelligence (IndexedDB "listening-intelligence" v1).
// Capas: lógica pura (arriba, testeable con Node) → lectura de datos y adaptadores → interfaz (abajo, solo en Spotify).

(function musicalDNA() {
  "use strict";

  const TAG = "[DNA]"; // prefijo para encontrar nuestros mensajes en la consola
  const H = 3600e3; // una hora en ms
  const DAY = 24 * H;
  // Valores fijados en el diseño (docs/superpowers/specs/2026-11-14-musical-dna-design.md).
  const CONST = Object.freeze({
    VALID_MIN_MS: 30000, // escucha válida: al menos 30 s… (igual que LI)
    VALID_RATIO: 0.5, // …o el 50 % de la duración
    HORIZONS: Object.freeze({
      reciente: { days: 7, half: 3 }, // half = vida media del peso en días
      medio: { days: 30, half: 10 },
      total: { days: null, half: null }, // sin límite ni decaimiento
    }),
    DAY_BONUS: 0.25, // premio por cada día distinto en que sonó
    SKIP_PENALTY: 0.5, // castigo por cada salto
    WEAK_VALID: 3, // menos válidas que esto → «poca muestra»
    WEAK_DAYS: 2, // menos días que esto → «poca muestra»
    SEEDS_SHOWN: 10,
    SKIP_MIN: 3, // antigusto: al menos 3 saltos y ninguna válida (mismo criterio que LI)
    RECENT_EXCLUDE_MS: 72 * H, // no sugerir lo que sonó hace menos de 72 h
    SIMS: 1000, // sorteos de Monte Carlo para «mejor fuente con un N % de probabilidad»
    SEED: 2026, // semilla fija de esas simulaciones: misma frase con los mismos datos
    BATCH: 10, // sugerencias por tanda
    ATTR_WINDOW_MS: 6 * H, // una prueba se resuelve con la primera escucha en las 6 h siguientes
    MAX_TRIALS: 2000,
    FAV_LIMIT: 500,
    STORE_KEY: "musical-dna:v1",
  });

  // ─────────────────────────── LÓGICA PURA (core) ───────────────────────────

  // Igual que LI (D-004 de LI): válida o saltada se CALCULA, no se guarda.
  function classify(playedMs, durationMs) {
    if (playedMs >= CONST.VALID_MIN_MS) return "valid";
    if (durationMs > 0 && playedMs >= durationMs * CONST.VALID_RATIO) return "valid";
    return "skipped";
  }

  // Las métricas usan solo canciones de Spotify: fuera pódcasts, archivos locales y otros.
  const trackRecords = (records) => records.filter((r) => r && r.kind === "track");

  // Clave de día en hora LOCAL (no UTC): «días distintos» debe coincidir con los días que vive Brian.
  function dayKey(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const artistName = (r) => r?.artists?.[0]?.name || "—";

  // ── Afinidad (diseño §5.2) ──
  // Por canción: suma de pesos de sus escuchas VÁLIDAS (más peso cuanto más recientes, según el horizonte),
  // premio por días distintos y castigo por saltos. Se normaliza a 0–100 frente a la mejor del horizonte.
  function affinityMap(records, horizon, now) {
    const { days, half } = CONST.HORIZONS[horizon];
    const from = days == null ? -Infinity : now - days * DAY;
    const acc = new Map(); // uri → acumulador
    for (const r of trackRecords(records)) {
      if (r.startedAt < from || r.startedAt > now) continue;
      const a = acc.get(r.uri) ?? { uri: r.uri, title: r.title, artist: artistName(r), artistUri: r.artists?.[0]?.uri ?? null,
        listens: 0, valid: 0, skips: 0, dayset: new Set(), weight: 0, lastAt: 0 };
      a.listens += 1;
      a.lastAt = Math.max(a.lastAt, r.startedAt);
      if (classify(r.playedMs, r.durationMs) === "valid") {
        a.valid += 1;
        a.dayset.add(dayKey(r.startedAt));
        a.weight += half == null ? 1 : 0.5 ** ((now - r.startedAt) / DAY / half); // vida media: a los `half` días pesa la mitad
      } else a.skips += 1;
      acc.set(r.uri, a);
    }
    const raw = new Map();
    for (const a of acc.values()) {
      const days = a.dayset.size;
      raw.set(a.uri, Math.max(0, a.weight * (1 + CONST.DAY_BONUS * (days - 1)) - CONST.SKIP_PENALTY * a.skips));
    }
    const max = Math.max(0, ...raw.values());
    const out = new Map();
    for (const a of acc.values()) {
      const score = max > 0 ? Math.round((raw.get(a.uri) / max) * 100) : 0;
      if (score <= 0) continue; // negativa o nula: no es señal de gusto
      const { dayset, weight, ...rest } = a;
      const d = dayset.size;
      out.set(a.uri, { ...rest, days: d, score, weak: a.valid < CONST.WEAK_VALID || d < CONST.WEAK_DAYS });
    }
    return out;
  }

  // Las semillas que ve Brian en «Tu ADN»: las 10 de más afinidad.
  function seeds(records, horizon, now) {
    const all = [...affinityMap(records, horizon, now).values()].sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
    return { items: all.slice(0, CONST.SEEDS_SHOWN), total: all.length };
  }

  // Antigusto: canciones que siempre saltas (≥ SKIP_MIN saltos y 0 válidas). Nunca se sugieren.
  function antitaste(records) {
    const acc = new Map();
    for (const r of trackRecords(records)) {
      const a = acc.get(r.uri) ?? { uri: r.uri, title: r.title, artist: artistName(r), skips: 0, valid: 0 };
      classify(r.playedMs, r.durationMs) === "valid" ? (a.valid += 1) : (a.skips += 1);
      acc.set(r.uri, a);
    }
    return [...acc.values()]
      .filter((a) => a.valid === 0 && a.skips >= CONST.SKIP_MIN)
      .sort((a, b) => b.skips - a.skips)
      .map(({ valid, ...a }) => a);
  }

  // ── Fuentes de candidatos (diseño §5.3): los «brazos» del bandido ──
  // Candidato = { uri, title, artist, artistUri, image, source, why }. Las exclusiones llegan ya calculadas.
  const cand = (t, source, why) => ({ uri: t.uri, title: t.title ?? t.uri, artist: t.artist ?? "—", artistUri: t.artistUri ?? null,
    image: t.image ?? null, source, why });

  // Historial: lo que más te gusta (horizonte total) y no ha sonado últimamente → redescubrir.
  function historyCandidates(records, now, excluded) {
    return [...affinityMap(records, "total", now).values()]
      .filter((s) => !excluded.has(s.uri))
      .sort((a, b) => b.score - a.score)
      .map((s) => cand(s, "historial", `la escuchaste ${s.listens}× · hace ${Math.floor((now - s.lastAt) / DAY)} días que no suena`));
  }

  // Cuántas veces sonó cada uri (canciones), para favoritas y para saber qué es «conocido».
  function playCounts(records) {
    const n = new Map();
    for (const r of trackRecords(records)) n.set(r.uri, (n.get(r.uri) ?? 0) + 1);
    return n;
  }

  // Favoritas: las guardadas que menos pones primero. sort() es estable: en empate queda el orden de Spotify.
  function favoriteCandidates(liked, records, excluded) {
    const n = playCounts(records);
    return liked
      .filter((t) => !excluded.has(t.uri))
      .map((t) => ({ t, plays: n.get(t.uri) ?? 0 }))
      .sort((a, b) => a.plays - b.plays)
      .map(({ t, plays }) => cand(t, "favoritas", `en tus favoritas · la has puesto ${plays}×`));
  }

  // Similares: canciones top de artistas relacionados con tus semillas. Se intercalan los grupos
  // (una de cada uno por turnos) para que una sola semilla no acapare la lista.
  function similarCandidates(groups, known, excluded) {
    const seen = new Set();
    const out = [];
    const queues = groups.map((g) => ({ g, i: 0 }));
    let left = true;
    while (left) {
      left = false;
      for (const q of queues) {
        while (q.i < q.g.tracks.length) {
          const t = q.g.tracks[q.i++];
          if (seen.has(t.uri) || known.has(t.uri) || excluded.has(t.uri)) continue;
          seen.add(t.uri);
          out.push(cand(t, "similares", `parecida a ${q.g.seedTitle} · relacionado con ${q.g.relatedName}`));
          break; // un candidato por grupo y turno
        }
        if (q.i < q.g.tracks.length) left = true;
      }
    }
    return out;
  }

  // ── Atribución y bandido (diseño §5.4–5.5) ──
  const SOURCES = ["historial", "favoritas", "similares"]; // también es el orden de desempate
  const LABEL = { historial: "Historial", favoritas: "Favoritas", similares: "Similares" };

  // Una prueba (Brian pulsó ▶ o ＋) se resuelve con el PRIMER registro de esa canción en las 6 h siguientes.
  // Excepción: guardar en «Canciones que te gustan» (action "like") es un acierto explícito, no hace falta escucharla.
  function resolveTrial(trial, records, now) {
    if (trial.action === "like") return "hit";
    const end = trial.at + CONST.ATTR_WINDOW_MS;
    let first = null;
    for (const r of trackRecords(records))
      if (r.uri === trial.uri && r.startedAt >= trial.at && r.startedAt <= end && (!first || r.startedAt < first.startedAt)) first = r;
    if (first) return classify(first.playedMs, first.durationMs) === "valid" ? "hit" : "miss";
    return now < end ? "pending" : "discarded";
  }

  // Lo que nunca se sugiere ahora: antigusto, lo que sonó hace < 72 h, pruebas pendientes y la tanda anterior.
  function excludedUris({ records, trials, lastBatch, now }) {
    const ex = new Set(antitaste(records).map((a) => a.uri));
    for (const r of trackRecords(records)) if (r.startedAt >= now - CONST.RECENT_EXCLUDE_MS) ex.add(r.uri);
    for (const t of trials) if (resolveTrial(t, records, now) === "pending") ex.add(t.uri);
    for (const u of lastBatch) ex.add(u);
    return ex;
  }

  // Estado del bandido RECALCULADO desde las pruebas + registros de LI (no se guarda ningún contador).
  // value = (aciertos + 1) / (pruebas + 2): suavizado de Laplace; una fuente sin datos vale 0,5.
  function armStats(trials, records, now) {
    const s = Object.fromEntries(SOURCES.map((src) => [src, { source: src, trials: 0, hits: 0, value: 0.5, pending: 0, discarded: 0 }]));
    for (const t of trials) {
      const a = s[t.source];
      if (!a) continue;
      const res = resolveTrial(t, records, now);
      if (res === "hit") (a.hits += 1), (a.trials += 1);
      else if (res === "miss") a.trials += 1;
      else a[res] += 1;
    }
    for (const a of Object.values(s)) a.value = (a.hits + 1) / (a.trials + 2);
    return s;
  }

  // Muestra de una distribución Beta(a, b) con a, b ENTEROS ≥ 1 (aciertos + 1, fallos + 1).
  // Truco del «estadístico de orden»: tira a + b − 1 números al azar en [0, 1), ordénalos y coge el a-ésimo.
  // Sale exactamente Beta(a, b) y no hace falta ninguna librería de estadística.
  // Con muchas pruebas (a + b > 60) ordenar miles de números por sorteo es lento; ahí la campana Beta ya es
  // casi idéntica a una normal con su misma media y varianza, así que se usa esa (Box-Muller, 2 números al azar).
  function betaSample(a, b, rng) {
    if (a + b > 60) {
      const n = a + b;
      const sd = Math.sqrt((a * b) / (n * n * (n + 1))); // desviación típica de Beta(a, b)
      const z = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng()); // normal estándar (Box-Muller)
      return Math.min(1, Math.max(0, a / n + sd * z)); // recortada a [0, 1]: es una proporción
    }
    const u = Array.from({ length: a + b - 1 }, rng).sort((x, y) => x - y); // sort numérico (sin él, ordenaría como texto)
    return u[a - 1];
  }

  // Generador de números «aleatorios» con semilla (mulberry32): la misma semilla da siempre la misma secuencia.
  // Sirve para que una simulación dé el mismo resultado cada vez (tests y frases estables en pantalla).
  function seededRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // 2^32: pasa de entero a [0, 1)
    };
  }

  // Thompson sampling híbrido (D-007). Hueco 1 = «la apuesta»: la fuente de mayor media, sin azar.
  // Huecos 2+: cada fuente saca un número de su campana Beta(aciertos + 1, fallos + 1) y gana el mayor.
  // Campana ancha (pocas pruebas) → a veces saca mucho → se explora sola; campana estrecha y baja → casi nunca gana.
  function pickBatch(pools, stats, rng, n = CONST.BATCH) {
    const next = Object.fromEntries(SOURCES.map((s) => [s, 0])); // siguiente candidato de cada fuente
    const used = new Set();
    const out = [];
    const value = (s) => stats[s]?.value ?? 0.5;
    const picks = Object.fromEntries(SOURCES.map((s) => [s, 0])); // cuántas veces sale cada fuente en ESTA tanda
    // Arranque en frío (D-005): una fuente con 0 pruebas sale una vez antes que nadie, y en empate de valor
    // gana la que menos ha salido en la tanda. Así, sin datos, la tanda rota entre fuentes en vez de repetir una.
    const untried = (avail) => avail.find((s) => stats[s]?.trials === 0 && picks[s] === 0);
    // Greedy: mayor media; en empate, la que menos ha salido en la tanda (y después el orden de SOURCES).
    const greedy = (avail) =>
      untried(avail) ??
      avail.reduce((b, s) => (value(s) > value(b) || (value(s) === value(b) && picks[s] < picks[b]) ? s : b));
    const draw = (s) => {
      const hits = stats[s]?.hits ?? 0;
      return betaSample(hits + 1, (stats[s]?.trials ?? 0) - hits + 1, rng); // fallos = pruebas − aciertos
    };
    // Thompson: gana la mayor muestra; en empate (casi imposible con azar real), el orden de SOURCES.
    const thompson = (avail) => {
      if (untried(avail)) return untried(avail);
      const d = Object.fromEntries(avail.map((s) => [s, draw(s)]));
      return avail.reduce((b, s) => (d[s] > d[b] ? s : b));
    };
    while (out.length < n) {
      // Disponible = le quedan candidatos no usados (salta duplicados entre fuentes).
      for (const s of SOURCES) while (pools[s]?.[next[s]] && used.has(pools[s][next[s]].uri)) next[s] += 1;
      const avail = SOURCES.filter((s) => pools[s]?.[next[s]]);
      if (!avail.length) break;
      const src = out.length === 0 ? greedy(avail) : thompson(avail);
      picks[src] += 1;
      const pick = pools[src][next[src]++];
      used.add(pick.uri);
      out.push({ ...pick, bet: out.length === 0 });
    }
    return out;
  }

  // ¿Con qué probabilidad es cada fuente la mejor? Método de Monte Carlo: repetir el sorteo de Thompson
  // CONST.SIMS veces y contar cuántas gana cada una. Semilla fija → mismo resultado con los mismos datos
  // (la frase de «Cómo aprende» no cambia en cada redibujado).
  function probBest(stats, available) {
    const rng = seededRng(CONST.SEED);
    const wins = Object.fromEntries(available.map((s) => [s, 0]));
    for (let k = 0; k < CONST.SIMS; k++) {
      let top = null, topDraw = -1;
      for (const s of available) {
        const hits = stats[s]?.hits ?? 0;
        const d = betaSample(hits + 1, (stats[s]?.trials ?? 0) - hits + 1, rng);
        if (d > topDraw) (top = s), (topDraw = d);
      }
      wins[top] += 1;
    }
    return Object.fromEntries(available.map((s) => [s, wins[s] / CONST.SIMS]));
  }

  function banditSentence(stats, available) {
    if (!available.length) return "Sin fuentes disponibles";
    const untried = available.filter((s) => stats[s]?.trials === 0);
    if (untried.length) {
      const names = untried.map((s) => LABEL[s]);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names.at(-1)}` : names[0];
      return `Primero probaré ${list} (aún sin pruebas); después apostaré por la que más acierte`;
    }
    const best = available.reduce((b, s) => ((stats[s]?.value ?? 0.5) > (stats[b]?.value ?? 0.5) ? s : b));
    const pct = Math.round(probBest(stats, available)[best] * 100);
    return `Ahora apostaría por ${LABEL[best]}: es tu mejor fuente con un ${pct} % de probabilidad`;
  }

  // ── Almacén propio (diseño §5.6): solo las pruebas; todo lo demás se recalcula ──
  const emptyStore = () => ({ schemaVersion: 1, trials: [] });
  const okTrial = (t) => t && typeof t.uri === "string" && typeof t.source === "string" && typeof t.at === "number";

  // Nunca lanza: si lo guardado no se entiende, se empieza de cero y se avisa una vez.
  function parseStore(raw) {
    if (raw == null) return { state: emptyStore(), warning: null };
    try {
      const s = JSON.parse(raw);
      if (s?.schemaVersion !== 1 || !Array.isArray(s.trials)) throw new Error("forma");
      return { state: { schemaVersion: 1, trials: s.trials.filter(okTrial) }, warning: null };
    } catch {
      return { state: emptyStore(), warning: "Datos de Musical DNA ilegibles: se empieza de cero" };
    }
  }

  // Devuelve un estado NUEVO (no muta el anterior) con como mucho MAX_TRIALS pruebas, las más recientes.
  const addTrial = (state, trial) => ({ ...state, trials: [...state.trials, trial].slice(-CONST.MAX_TRIALS) });
  const serializeStore = (state) => JSON.stringify(state);

  // ─────────────────────────── DATOS DE LI (solo lectura) ───────────────────────────
  // Abre la base de LI SIN número de versión (una futura v2 no da VersionError; la compatibilidad
  // la decide meta.schemaVersion). Si la base no existe, el navegador dispara onupgradeneeded:
  // abortamos para NO crearla vacía, porque entonces LI no podría crear sus almacenes.
  const asPromise = (req) => new Promise((ok, ko) => ((req.onsuccess = () => ok(req.result)), (req.onerror = () => ko(req.error))));

  function readLiData(idb) {
    const base = { records: [], observingSince: null, version: null };
    if (!idb?.open) return Promise.resolve({ ...base, status: "error", error: "IndexedDB no disponible" });
    return new Promise((resolve) => {
      let missing = false;
      const req = idb.open("listening-intelligence");
      req.onupgradeneeded = (e) => {
        missing = true;
        e.target.transaction.abort(); // no crear nada en la base de otra extensión
      };
      req.onerror = () => resolve(missing ? { ...base, status: "sin-li" } : { ...base, status: "error", error: String(req.error) });
      req.onsuccess = async () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains("records") || !db.objectStoreNames.contains("meta")) return resolve({ ...base, status: "sin-li" });
          const tx = db.transaction(["records", "meta"], "readonly");
          const [meta, records] = await Promise.all([asPromise(tx.objectStore("meta").get("meta")), asPromise(tx.objectStore("records").getAll())]);
          const version = meta?.schemaVersion ?? null;
          if (version !== 1) return resolve({ ...base, status: "incompatible", version });
          const out = { records, observingSince: meta.observingSince ?? null, version };
          resolve({ ...out, status: records.length ? "ok" : "vacio" });
        } catch (e) {
          resolve({ ...base, status: "error", error: String(e?.message ?? e) });
        } finally {
          db.close(); // no bloquear una futura actualización de versión de LI
        }
      };
    });
  }

  // ─────────────────────────── ADAPTADORES DE SPOTIFY (APIs internas, con respaldo) ───────────────────────────
  // No son contratos estables: cualquier fallo se convierte en { ok: false, reason } y la fuente queda «no disponible».

  function imageUrl(u) {
    if (typeof u !== "string") return null;
    if (u.startsWith("spotify:image:")) return "https://i.scdn.co/image/" + u.slice("spotify:image:".length);
    return u.startsWith("https://") ? u : null;
  }

  // Canciones guardadas. Se pagina hasta una página vacía: totalLength llega a 0 en Spotify 1.2.95 (comprobado por CDP).
  async function fetchFavorites(S) {
    const api = S?.Platform?.LibraryAPI;
    if (typeof api?.getTracks !== "function") return { ok: false, reason: "Spotify no da acceso a tus favoritas" };
    try {
      const liked = [];
      while (liked.length < CONST.FAV_LIMIT) {
        const page = await api.getTracks({ offset: liked.length, limit: 50 });
        const items = page?.items ?? [];
        if (!items.length) break;
        for (const t of items) {
          const art = t.album?.artist ?? t.artists?.[0] ?? {};
          liked.push({ uri: t.uri, title: t.name, artist: art.name ?? "—", artistUri: art.uri ?? null, image: imageUrl(t.album?.images?.[0]?.url) });
        }
      }
      return { ok: true, liked: liked.slice(0, CONST.FAV_LIMIT) };
    } catch (e) {
      return { ok: false, reason: "Spotify no da acceso a tus favoritas" };
    }
  }

  // Similares: semilla → 3 artistas relacionados (queryArtistRelated) → sus 5 canciones top (queryArtistOverview).
  // `cache` (Map) guarda respuestas por artista durante la sesión para no repetir llamadas.
  async function fetchSimilarGroups(S, seedList, cache) {
    const G = S?.GraphQL;
    const D = G?.Definitions;
    const fail = { ok: false, reason: "Spotify no responde" };
    if (typeof G?.Request !== "function" || !D?.queryArtistRelated || !D?.queryArtistOverview) return fail;
    let tried = 0, worked = 0;
    // Se guarda la PROMESA, no el valor: dos semillas que piden el mismo artista a la vez comparten una sola llamada.
    const cached = (key, fn) => {
      if (cache.has(key)) return cache.get(key);
      tried += 1;
      const p = fn().then(
        (v) => ((worked += 1), v),
        () => (cache.delete(key), null), // un fallo suelto se salta (y se reintentará en otra apertura)
      );
      cache.set(key, p);
      return p;
    };
    const related = (uri) => cached("rel:" + uri, async () => {
      const items = (await G.Request(D.queryArtistRelated, { uri, locale: "" })).data.artistUnion.relatedContent.relatedArtists.items;
      return items.slice(0, 3).map((a) => ({ uri: a.uri, name: a.profile.name }));
    });
    const top = (uri) => cached("top:" + uri, async () => {
      const items = (await G.Request(D.queryArtistOverview, { uri, locale: "", includePrerelease: false })).data.artistUnion.discography.topTracks.items;
      return items.slice(0, 5).map(({ track: t }) => ({ uri: t.uri, title: t.name, artist: t.artists?.items?.[0]?.profile?.name ?? "—",
        artistUri: t.artists?.items?.[0]?.uri ?? null, image: imageUrl(t.albumOfTrack?.coverArt?.sources?.[0]?.url) }));
    });
    const seen = new Set();
    const uniq = seedList.slice(0, 10).filter((s) => s.artistUri && !seen.has(s.artistUri) && seen.add(s.artistUri));
    // Todo en paralelo (~2 rondas de red en vez de hasta 40 llamadas en serie). Promise.all conserva el orden.
    const perSeed = await Promise.all(uniq.map(async (s) => {
      const rels = (await related(s.artistUri)) ?? [];
      const tops = await Promise.all(rels.map((rel) => top(rel.uri)));
      return rels.map((rel, i) => ({ seedTitle: s.title, relatedName: rel.name, tracks: tops[i] ?? [] })).filter((g) => g.tracks.length);
    }));
    const groups = perSeed.flat();
    return tried > 0 && worked === 0 && !groups.length ? fail : { ok: true, groups };
  }

  const core = { imageUrl, fetchFavorites, fetchSimilarGroups, readLiData, parseStore, addTrial, serializeStore, CONST, SOURCES, LABEL, classify, trackRecords, dayKey, artistName, affinityMap, seeds, antitaste,
    historyCandidates, favoriteCandidates, similarCandidates, playCounts,
    resolveTrial, excludedUris, armStats, pickBatch, banditSentence, betaSample, seededRng, probBest };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof Spicetify === "undefined") return; // en Node (tests) termina aquí

  // ─────────────────────────── SPOTIFY: estado de la sesión ───────────────────────────

  // Un solo estado por sesión de Spotify. La tanda se conserva entre aperturas del panel; solo
  // «Nuevas sugerencias» la regenera. Las respuestas de GraphQL se guardan en `gqlCache`.
  // `saved` = URIs que sabemos en «Canciones que te gustan» (se siembra con las favoritas leídas).
  const session = { batch: null, clicked: new Set(), saved: new Set(), gqlCache: new Map(), warned: false };

  function loadStore() {
    const { state, warning } = parseStore(Spicetify.LocalStorage.get(CONST.STORE_KEY));
    if (warning && !session.warned) {
      session.warned = true; // avisar UNA vez por sesión
      Spicetify.showNotification(warning, true);
    }
    return state;
  }
  const saveStore = (state) => Spicetify.LocalStorage.set(CONST.STORE_KEY, serializeStore(state));

  // Lee LI y las fuentes externas. Devuelve todo lo que necesitan las tres pestañas.
  async function loadData() {
    const li = await readLiData(typeof indexedDB !== "undefined" ? indexedDB : undefined);
    if (li.status !== "ok") return { li };
    const now = Date.now();
    const fav = await fetchFavorites(Spicetify);
    if (fav.ok) for (const t of fav.liked) session.saved.add(t.uri);
    const simSeeds = [
      ...seeds(li.records, "total", now).items.slice(0, 5),
      ...(fav.ok ? fav.liked.slice(0, 5) : []), // las 5 favoritas más recientes (orden de Spotify)
    ].map((s) => ({ title: s.title, artistUri: s.artistUri }));
    const sim = await fetchSimilarGroups(Spicetify, simSeeds, session.gqlCache);
    return { li, fav, sim };
  }

  // Pools de candidatos + motivo de cada fuente vacía o caída (lo que se explica en «Para ti»).
  function buildPools(data, trials, lastBatch, now) {
    const { li, fav, sim } = data;
    const records = li.records;
    const excluded = excludedUris({ records, trials, lastBatch, now });
    const known = new Set([...playCounts(records).keys(), ...(fav.ok ? fav.liked.map((t) => t.uri) : [])]);
    const pools = {
      historial: historyCandidates(records, now, excluded),
      favoritas: fav.ok ? favoriteCandidates(fav.liked, records, excluded) : [],
      similares: sim.ok ? similarCandidates(sim.groups, known, excluded) : [],
    };
    const why = {};
    if (!pools.historial.length)
      why.historial = affinityMap(records, "total", now).size ? "todo lo que tienes sonó en las últimas 72 h" : "aún no hay escuchas válidas";
    if (!fav.ok) why.favoritas = fav.reason;
    else if (!pools.favoritas.length) why.favoritas = fav.liked.length ? "tus guardadas sonaron hace poco" : "no tienes canciones guardadas";
    if (!sim.ok) why.similares = sim.reason;
    else if (!pools.similares.length) why.similares = "sin canciones nuevas de artistas relacionados";
    return { pools, why };
  }

  // ─────────────────────────── SPOTIFY: interfaz ───────────────────────────

  // Icono: doble hélice. Glifo sólido, currentColor (toma el color del tema), viewBox 24.
  const ICON_SVG =
    '<svg role="img" height="18" width="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M7 3c0 6 10 6 10 12s-10 6-10 6"/><path d="M17 3c0 6-10 6-10 12"/><path d="M9 7h6M9 17h6"/></svg>';

  // Colores SOLO del tema (var(--spice-*)), nunca fijos.
  const SUB = "color:var(--spice-subtext);font-size:13px";
  const CUT = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const BTN = "border:none;border-radius:999px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;";
  const ON = "background:var(--spice-button);color:var(--spice-main)";
  const OFF = "background:var(--spice-card);color:var(--spice-text)";
  const LABEL_H = "font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--spice-subtext);margin-top:8px";
  const VIEWS = [["dna", "Tu ADN"], ["foryou", "Para ti"], ["learn", "Cómo aprende"]];
  const HZ = [["reciente", "Reciente"], ["medio", "Medio"], ["total", "Total"]];

  // textContent (no innerHTML): un título de canción nunca se interpreta como HTML.
  function el(tag, text, style) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (style) node.style.cssText = style;
    return node;
  }
  function button(text, style, onClick) {
    const b = el("button", text, BTN + style);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // Carátula: la imagen real si la hay; si no, un degradado que depende del URI (siempre el mismo para la misma canción).
  function cover(c, size) {
    const box = `width:${size}px;height:${size}px;border-radius:4px;flex:none`;
    if (c.image) {
      const img = el("img", null, box + ";object-fit:cover");
      img.src = c.image;
      return img;
    }
    let h = 0;
    for (const ch of c.uri) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return el("div", null, `${box};background:linear-gradient(135deg,hsl(${h},60%,45%),hsl(${(h + 60) % 360},60%,30%))`);
  }

  function bar(pct) {
    const outer = el("div", null, "height:6px;border-radius:3px;background:var(--spice-card);overflow:hidden;flex:1;min-width:60px");
    outer.append(el("div", null, `height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:var(--spice-button)`));
    return outer;
  }

  const fmtDate = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  };

  function notice(li) {
    if (li.status === "sin-li") return "Instala Listening Intelligence: Musical DNA usa su historial.";
    if (li.status === "incompatible") return `Versión de datos no compatible (esperaba 1, hay ${li.version ?? "ninguna"}).`;
    if (li.status === "vacio") return "Aún no hay escuchas: Listening Intelligence todavía no ha registrado nada.";
    return `No se pudo leer el historial: ${li.error}`;
  }

  function mountUI() {
    if (typeof Spicetify.Topbar?.Button !== "function" || typeof Spicetify.PopupModal?.display !== "function")
      return console.warn(TAG, "Topbar/PopupModal no disponibles: sin icono");

    new Spicetify.Topbar.Button("Musical DNA", ICON_SVG, async () => {
      let view = "foryou";
      let horizon = "total";
      let store = loadStore();
      let data = null; // null = cargando

      // Lo FIJO (Error #6 de LI): pestañas, chips, «Nuevas sugerencias» y pie se crean UNA vez y no salen del DOM.
      const COL = "display:flex;flex-direction:column;gap:12px";
      const root = el("div", null, `${COL};color:var(--spice-text)`);
      const body = el("div", null, COL); // lo único que se redibuja
      const tabs = VIEWS.map(([k, label]) => button(label, "", () => setView(k)));
      const chips = HZ.map(([k, label]) => button(label, "", () => ((horizon = k), render())));
      const refresh = button("Nuevas sugerencias", OFF, () => newBatch(session.batch?.items)); // sin repetir lo no pulsado
      const tabsRow = el("div", null, "display:flex;gap:8px;flex-wrap:wrap");
      const toolsRow = el("div", null, "display:flex;gap:8px;flex-wrap:wrap");
      tabsRow.append(...tabs);
      toolsRow.append(refresh, ...chips);
      const header = el("div", null, "position:sticky;top:0;z-index:1;background:var(--spice-player);display:flex;flex-direction:column;gap:10px;padding-bottom:8px");
      header.append(tabsRow, toolsRow);

      const foot = el("div", null, "display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--spice-card);padding-top:12px");
      const info = el("span", null, SUB);
      const exp = button("Exportar", OFF, () => exportStore());
      let armed = false; // Borrar pide un segundo clic: el mismo botón cambia de texto (no se sustituye)
      const wipe = button("Borrar", OFF, () => {
        if (!armed) {
          armed = true;
          wipe.textContent = "¿Seguro? Pulsa otra vez";
          return;
        }
        armed = false;
        wipe.textContent = "Borrar";
        Spicetify.LocalStorage.remove(CONST.STORE_KEY); // solo nuestra clave, nunca clear()
        store = parseStore(null).state;
        Spicetify.showNotification("Datos de Musical DNA borrados");
        render();
      });
      const actions = el("div", null, "display:flex;gap:8px");
      actions.append(exp, wipe);
      foot.append(info, actions);
      root.append(header, body, foot);

      function exportStore() {
        const text = serializeStore(store);
        if (typeof Spicetify.Platform?.ClipboardAPI?.copy === "function") {
          Spicetify.Platform.ClipboardAPI.copy(text);
          Spicetify.showNotification(`Copiadas ${store.trials.length} pruebas al portapapeles`);
          return;
        }
        const a = el("a"); // respaldo: descarga del archivo
        a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        a.download = `musical-dna-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
      }

      function setView(k) {
        view = k;
        tabs.forEach((t, i) => (t.style.cssText = BTN + (VIEWS[i][0] === k ? ON : OFF)));
        refresh.style.display = k === "foryou" ? "" : "none";
        chips.forEach((c) => (c.style.display = k === "dna" ? "" : "none"));
        render();
      }

      // Genera una tanda nueva. `prev` = tanda anterior: lo no pulsado de ella no se repite.
      function makeBatch(prev, now) {
        const lastBatch = prev ? prev.filter((c) => !session.clicked.has(c.uri)).map((c) => c.uri) : [];
        const { pools, why } = buildPools(data, store.trials, lastBatch, now);
        session.batch = { items: pickBatch(pools, armStats(store.trials, data.li.records, now), Math.random), why, available: SOURCES.filter((s) => pools[s].length) };
        session.clicked = new Set();
      }
      function newBatch(prev) {
        if (!data || data.li.status !== "ok") return;
        makeBatch(prev, Date.now());
        render();
      }

      function tryIt(c, action) {
        // Si ya hay una prueba de esta canción esperando resultado, volver a pulsar ▶ solo reproduce:
        // una sugerencia = una prueba (si no, 3 clics contarían como 3 aciertos o 3 fallos de la fuente).
        const now = Date.now();
        const waiting = store.trials.some((t) => t.uri === c.uri && resolveTrial(t, data.li.records, now) === "pending");
        if (!waiting) {
          // Primero anotar (síncrono), después actuar: si Spotify falla, la prueba ya está guardada.
          store = addTrial(store, { uri: c.uri, source: c.source, why: c.why, at: now, action });
          saveStore(store);
          session.clicked.add(c.uri);
        }
        Spicetify.Player.playUri(c.uri);
        Spicetify.showNotification(waiting ? "Ya estaba anotada: sigue sonando" : "Anotado: veremos si te gusta");
        setTimeout(render, 0); // redibujar DESPUÉS del clic: el botón pulsado sigue en el DOM mientras el clic sube (Error #6)
      }

      // ＋/✓ como el corazón nativo de Spotify: guarda o quita de «Canciones que te gustan».
      // Optimista: el icono cambia al momento; si Spotify falla, se deshace y se avisa.
      function toggleSaved(c) {
        const api = Spicetify.Platform?.LibraryAPI;
        const saving = !session.saved.has(c.uri);
        const call = saving ? api?.add : api?.remove;
        if (typeof call !== "function") return Spicetify.showNotification("Spotify no deja guardar canciones desde aquí", true);
        const flip = (on) => (on ? session.saved.add(c.uri) : session.saved.delete(c.uri), setTimeout(render, 0)); // Error #6
        flip(saving);
        const before = store; // para deshacer la anotación si Spotify falla
        if (saving && !store.trials.some((t) => t.action === "like" && t.uri === c.uri)) {
          store = addTrial(store, { uri: c.uri, source: c.source, why: c.why, at: Date.now(), action: "like" });
          saveStore(store);
          session.clicked.add(c.uri);
        } else if (!saving) {
          // Quitar el ✓ deshace el acierto: un like arrepentido no debe seguir premiando a la fuente.
          store = { ...store, trials: store.trials.filter((t) => !(t.action === "like" && t.uri === c.uri)) };
          saveStore(store);
        }
        Promise.resolve()
          .then(() => call.call(api, { uris: [c.uri] }))
          .then(() => Spicetify.showNotification(saving ? "Añadida a Canciones que te gustan" : "Quitada de Canciones que te gustan"))
          .catch((e) => {
            console.warn(TAG, "LibraryAPI", e);
            flip(!saving);
            store = before;
            saveStore(store);
            Spicetify.showNotification("No se pudo actualizar tu biblioteca", true);
          });
      }

      function saveButton(c) {
        const on = session.saved.has(c.uri);
        const b = button(on ? "✓" : "＋", (on ? ON : OFF) + ";width:32px;height:32px;padding:0", () => toggleSaved(c));
        b.title = on ? "Quitar de Canciones que te gustan" : "Guardar en Canciones que te gustan";
        return b;
      }

      function row(c, stats, big) {
        const r = el("div", null, `display:flex;align-items:center;gap:12px;padding:8px;border-radius:6px;${big ? "background:var(--spice-card)" : ""}`);
        const text = el("div", null, "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1");
        if (big) text.append(el("div", "La apuesta del bandido", LABEL_H + ";margin-top:0"));
        const s = stats[c.source];
        text.append(
          el("div", c.title, `font-weight:700;${big ? "font-size:18px;" : ""}${CUT}`),
          el("div", c.artist, `${SUB};${CUT}`),
          el("div", `${c.why} · ${LABEL[c.source]} ${s.hits}/${s.trials} ✓`, "font-size:11px;color:var(--spice-button);" + CUT),
        );
        const btns = el("div", null, "display:flex;gap:6px;flex:none");
        btns.append(
          button("▶", ON + ";width:32px;height:32px;padding:0", () => tryIt(c, "play")),
          saveButton(c),
        );
        r.append(cover(c, big ? 64 : 40), text, btns);
        return r;
      }

      function renderForYou(now) {
        if (!session.batch) makeBatch(null, now); // primera apertura de la sesión
        const { items, why } = session.batch;
        const stats = armStats(store.trials, data.li.records, now);
        const out = [];
        if (!items.length) out.push(el("div", "Ahora mismo no hay nada que sugerirte:", "font-weight:700"));
        items.forEach((c, i) => out.push(row(c, stats, i === 0)));
        for (const s of SOURCES) if (why[s]) out.push(el("div", `${LABEL[s]}: ${why[s]}`, SUB));
        return out;
      }
      function renderLearn(now) {
        const stats = armStats(store.trials, data.li.records, now);
        const available = session.batch?.available ?? [];
        const out = [el("div", banditSentence(stats, available), "font-weight:700")];
        for (const s of SOURCES) {
          const a = stats[s];
          const line = el("div", null, "display:flex;align-items:center;gap:12px");
          const pct = a.trials ? Math.round((a.hits / a.trials) * 100) : 0;
          line.append(el("div", LABEL[s], "width:90px;font-weight:700"), bar(pct),
            el("div", `${a.hits}/${a.trials} ✓ · valor ${a.value.toFixed(2)}`, SUB + ";width:150px;text-align:right"));
          out.push(line);
          const st = session.batch?.why?.[s];
          out.push(el("div", st ? `No disponible: ${st}` : `Disponible · ${a.pending} pendientes`, SUB + ";margin:-6px 0 4px 102px"));
        }
        out.push(el("div", "Últimas pruebas", LABEL_H));
        const sym = { hit: "✓", miss: "✗", pending: "⏳", discarded: "—" };
        const last = store.trials.slice(-10).reverse();
        if (!last.length) out.push(el("div", "Aún no has probado ninguna sugerencia: pulsa ▶ o ＋ en «Para ti».", SUB));
        for (const t of last) out.push(el("div", `${sym[resolveTrial(t, data.li.records, now)]} ${LABEL[t.source] ?? t.source} · ${t.why ?? t.uri}`, SUB + ";" + CUT));
        out.push(el("div", "✓ escuchada ≥30 s o guardada · ✗ saltada · ⏳ esperando (6 h) · — no llegó a sonar", SUB + ";font-size:11px"));
        return out;
      }

      function renderDna(now) {
        const { items } = seeds(data.li.records, horizon, now);
        const out = [el("div", "🧬 TUS SEMILLAS (de aquí salen las sugerencias)", LABEL_H)];
        if (!items.length) out.push(el("div", "Sin semillas en este horizonte.", SUB));
        for (const s of items) {
          const head = el("div", null, "display:flex;align-items:center;gap:12px");
          head.append(el("div", `${s.title} — ${s.artist}`, `flex:2;min-width:0;font-weight:700;${CUT}`), bar(s.score), el("div", String(s.score), "width:32px;text-align:right;font-weight:700"));
          const sig = `${s.listens} escuchas · ${s.valid} completas · ${s.days} ${s.days === 1 ? "día" : "días distintos"}${s.weak ? "   ⚠ poca muestra" : ""}`;
          out.push(head, el("div", sig, SUB + ";margin-top:-8px"));
        }
        out.push(el("div", "🚫 TU ANTIGUSTO (nunca te lo sugerirá)", LABEL_H));
        const anti = antitaste(data.li.records);
        if (!anti.length) out.push(el("div", "Nada: no hay canciones que saltes siempre.", SUB));
        for (const a of anti.slice(0, 10)) out.push(el("div", `${a.title} — ${a.artist} · ${a.skips} saltos de ${a.skips}`, SUB));
        return out;
      }

      function render() {
        const now = Date.now();
        chips.forEach((c, i) => (c.style.cssText = BTN + (HZ[i][0] === horizon ? ON : OFF) + (view === "dna" ? "" : ";display:none")));
        if (!data) return body.replaceChildren(el("div", "Cargando…", SUB));
        if (data.li.status !== "ok") {
          info.textContent = "";
          return body.replaceChildren(el("div", notice(data.li), "font-weight:700"));
        }
        const n = trackRecords(data.li.records).length;
        info.textContent = `Basado en ${n} escuchas${data.li.observingSince ? " desde " + fmtDate(data.li.observingSince) : ""}`;
        const parts = view === "foryou" ? renderForYou(now) : view === "learn" ? renderLearn(now) : renderDna(now);
        body.replaceChildren(...parts);
        window.MusicalDNA = { status: "listo", li: { status: data.li.status, n }, arms: armStats(store.trials, data.li.records, now),
          batch: session.batch?.items.map((c) => `${c.source}: ${c.title}`) ?? [], refresh: () => newBatch(session.batch?.items) };
      }

      setView(view);
      Spicetify.PopupModal.display({ title: "Musical DNA", content: root, isLarge: true });
      try {
        data = await loadData();
      } catch (e) {
        data = { li: { status: "error", error: String(e?.message ?? e) } };
      }
      render();
    });
  }

  const ready = () => Spicetify?.Player && Spicetify?.Platform && Spicetify?.LocalStorage;

  // Reintenta cada 100 ms; se rinde a los 30 s para no esperar para siempre.
  (function waitForSpicetify(tries = 0) {
    if (ready()) {
      window.MusicalDNA = { status: "listo" };
      loadStore(); // aviso temprano si lo guardado es ilegible
      return mountUI();
    }
    if (tries >= 300) {
      window.MusicalDNA = { status: "timeout" };
      return console.warn(TAG, "Spicetify no disponible tras 30 s; extensión desactivada");
    }
    setTimeout(() => waitForSpicetify(tries + 1), 100);
  })();
})();
