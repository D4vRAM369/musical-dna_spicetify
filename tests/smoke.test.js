// Extremo a extremo con un Spotify simulado: icono → panel → pestañas → ▶ → Borrar.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { fakeIDB } = require("./fake-idb.js");
const { now, r } = require("./helpers.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "musical-dna.js"), "utf8");

// DOM falso mínimo: lo justo que usa el panel.
function fakeEl(tag) {
  return { tag, children: [], style: {}, textContent: "", title: "", src: "", listeners: {},
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    addEventListener(t, cb) { this.listeners[t] = cb; }, click() {} };
}
const textOf = (n) => [n.textContent, ...n.children.map(textOf)].join(" ");
const contains = (n, target) => n === target || n.children.some((c) => contains(c, target));
// Como el PopupModal: primero nuestro handler; luego, ¿sigue lo pulsado dentro? false = el modal se cerraría (Error #6).
function click(root, node) {
  node.listeners.click();
  return contains(root, node);
}
const findButton = (n, text) => (n.tag === "button" && n.textContent === text ? n : n.children.map((c) => findButton(c, text)).find(Boolean));
const tick = async (k = 10) => { for (let i = 0; i < k; i++) await new Promise((res) => setTimeout(res, 0)); };

const LI = (records) => ({ "listening-intelligence": { meta: { meta: { schemaVersion: 1, observingSince: now - 30 * 864e5 } }, records } });
const likedItem = (i) => ({ uri: "spotify:track:fav" + i, name: "Fav" + i, album: { artist: { uri: "spotify:artist:f" + i, name: "F" + i }, images: [] } });

async function boot({ idb, disk = {}, liked = [], gqlFails = true, addFails = false, io = false } = {}) {
  const L = { notes: [] };
  // IntersectionObserver falso: `L.io.fire()` = «el centinela ha entrado en pantalla».
  class FakeIO {
    constructor(cb) { this.cb = cb; this.targets = []; L.io = this; }
    observe(t) { this.targets.push(t); }
    disconnect() { this.targets = []; }
    get observed() { return this.targets; }
    fire() { this.cb(this.targets.map((target) => ({ isIntersecting: true, target }))); }
  }
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  }
  const Spicetify = {
    Player: {}, // ready() solo comprueba que exista
    showNotification: (msg, isError) => L.notes.push({ msg, isError: !!isError }),
    LocalStorage: { get: (k) => (k in disk ? disk[k] : null), set: (k, v) => (disk[k] = String(v)), remove: (k) => delete disk[k] },
    Platform: {
      LibraryAPI: {
        getTracks: async ({ offset }) => ({ items: offset === 0 ? liked : [], totalLength: 0 }),
        add: async (o) => { if (addFails) throw new Error("caído"); L.added = o; },
        remove: async (o) => (L.removed = o),
      },
      ClipboardAPI: { copy: (t) => (L.copied = t) },
    },
    GraphQL: { Definitions: { queryArtistRelated: 1, queryArtistOverview: 2 }, Request: async () => { if (gqlFails) throw new Error("caído"); } },
    Topbar: { Button: class { constructor(label, icon, onClick) { L.topbarClick = onClick; } } },
    PopupModal: { display: (o) => (L.modal = o) },
  };
  Spicetify.Player.playUri = (u) => (L.played = u);
  const win = {};
  const ctx = { Spicetify, window: win, document: { createElement: fakeEl }, console: { log() {}, warn() {}, error() {} },
    setTimeout, Date: FakeDate, indexedDB: idb };
  if (io) ctx.IntersectionObserver = FakeIO;
  vm.runInNewContext(SRC, ctx);
  await tick();
  return { L, disk, win, idb };
}
async function open(env) {
  await env.L.topbarClick();
  await tick(20);
  return env.L.modal.content;
}

test("sin LI: aviso y la base no se crea", async () => {
  const env = await boot({ idb: fakeIDB({}) });
  const root = await open(env);
  assert.match(textOf(root), /Instala Listening Intelligence/);
  assert.equal(env.idb.created, false);
  assert.equal(env.L.modal.title, "Musical DNA");
});

test("con datos: abre en Para ti con la apuesta, porqué y brazo caído", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5), r("a", 6), r("b", 5)])), liked: [likedItem(1), likedItem(2)] });
  const root = await open(env);
  const t = textOf(root);
  assert.match(t, /La apuesta del bandido/);
  assert.match(t, /hace 5 días que no suena/);
  assert.match(t, /en tus favoritas/);
  assert.match(t, /Similares: Spotify no responde/);
  assert.equal(env.win.MusicalDNA.li.status, "ok");
});

test("todos los brazos vacíos: explica por qué", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 0), r("b", 1)])) });
  const t = textOf(await open(env));
  assert.match(t, /sonó en las últimas 72 h/);
  assert.match(t, /Favoritas:/);
  assert.match(t, /Similares: Spotify no responde/);
});

test("▶ guarda la prueba, reproduce y el modal sigue abierto (Error #6)", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])) });
  const root = await open(env);
  assert.ok(click(root, findButton(root, "▶")));
  assert.equal(JSON.parse(env.disk["musical-dna:v1"]).trials.length, 1);
  assert.equal(JSON.parse(env.disk["musical-dna:v1"]).trials[0].action, "play");
  assert.equal(env.L.played, "a");
});

test("＋ guarda en Canciones que te gustan, pasa a ✓ y ✓ la quita", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])) });
  const root = await open(env);
  assert.ok(click(root, findButton(root, "＋")));
  await tick();
  assert.equal(JSON.stringify(env.L.added), JSON.stringify({ uris: ["a"] })); // el objeto viene de otro contexto vm
  assert.equal(JSON.parse(env.disk["musical-dna:v1"]).trials[0].action, "like");
  assert.ok(findButton(root, "✓"), "el ＋ se convierte en ✓");
  assert.ok(click(root, findButton(root, "✓")));
  await tick();
  assert.equal(JSON.stringify(env.L.removed), JSON.stringify({ uris: ["a"] }));
  assert.ok(findButton(root, "＋"), "vuelve a ＋");
  assert.equal(JSON.parse(env.disk["musical-dna:v1"]).trials.length, 0); // quitar deshace el acierto del like
});

test("una favorita ya guardada se muestra con ✓", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 0)])), liked: [likedItem(1)] });
  const root = await open(env);
  assert.ok(findButton(root, "✓"));
});

test("si Spotify falla al guardar, el ✓ se deshace y avisa", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])), addFails: true });
  const root = await open(env);
  click(root, findButton(root, "＋"));
  await tick();
  assert.ok(findButton(root, "＋"));
  assert.ok(env.L.notes.some((n) => n.isError && /biblioteca/.test(n.msg)));
  assert.equal(JSON.parse(env.disk["musical-dna:v1"]).trials.length, 0); // sin guardar no hay acierto
});

test("pestañas, chips y Nuevas sugerencias no salen del DOM al pulsarlos (Error #6)", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5), r("b", 6)])) });
  const root = await open(env);
  for (const t of ["Tu ADN", "Cómo aprende", "Para ti", "Nuevas sugerencias"]) assert.ok(click(root, findButton(root, t)), t);
  click(root, findButton(root, "Tu ADN"));
  for (const h of ["Reciente", "Medio", "Total"]) assert.ok(click(root, findButton(root, h)), h);
  assert.match(textOf(root), /TUS SEMILLAS/);
  assert.match(textOf(root), /Basado en 2 escuchas desde/);
});

test("Cómo aprende muestra la frase del bandido y las pruebas", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])) });
  const root = await open(env);
  click(root, findButton(root, "▶"));
  click(root, findButton(root, "Cómo aprende"));
  const t = textOf(root);
  assert.match(t, /Primero probaré .*\(aún sin pruebas\)/); // la prueba pendiente aún no cuenta (D-005)
  assert.match(t, /⏳/);
});

test("Borrar pide doble clic y solo borra su clave", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])), disk: { "otra:clave": "x" } });
  const root = await open(env);
  click(root, findButton(root, "▶"));
  assert.ok(click(root, findButton(root, "Borrar")));
  assert.ok(env.disk["musical-dna:v1"]);
  assert.ok(click(root, findButton(root, "¿Seguro? Pulsa otra vez")));
  assert.equal(env.disk["musical-dna:v1"], undefined);
  assert.equal(env.disk["otra:clave"], "x");
});

test("Exportar copia las pruebas al portapapeles", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])) });
  const root = await open(env);
  click(root, findButton(root, "▶"));
  click(root, findButton(root, "Exportar"));
  assert.equal(JSON.parse(env.L.copied).trials.length, 1);
});

test("almacén corrupto: aviso una vez, sin romper", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])), disk: { "musical-dna:v1": "{no" } });
  await open(env);
  await open(env);
  assert.equal(env.L.notes.filter((n) => n.isError).length, 1);
  assert.match(textOf(env.L.modal.content), /La apuesta del bandido/);
});

test("▶ varias veces en la misma sugerencia: una sola prueba mientras esté pendiente", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])) });
  const root = await open(env);
  click(root, findButton(root, "▶"));
  await tick();
  click(root, findButton(root, "▶"));
  await tick();
  assert.equal(JSON.parse(env.disk["musical-dna:v1"]).trials.length, 1);
  assert.equal(env.L.played, "a"); // sigue reproduciendo
});

test("✗ descarta: anota fallo, sustituye la prueba pendiente, muestra ↺ y ↺ lo deshace", async () => {
  const env = await boot({ idb: fakeIDB(LI([r("a", 5)])) });
  const root = await open(env);
  click(root, findButton(root, "▶"));
  await tick();
  assert.ok(click(root, findButton(root, "✗")), "el modal sigue abierto (Error #6)");
  await tick();
  let trials = JSON.parse(env.disk["musical-dna:v1"]).trials;
  assert.deepEqual(trials.map((t) => t.action), ["dismiss"]); // el ▶ pendiente se sustituye
  assert.ok(findButton(root, "↺"));
  assert.equal(findButton(root, "▶"), undefined); // fila descartada: solo ↺
  assert.match(textOf(root), /descartada/);
  click(root, findButton(root, "↺"));
  await tick();
  trials = JSON.parse(env.disk["musical-dna:v1"]).trials;
  assert.deepEqual(trials.map((t) => t.action), ["play"]); // vuelve la prueba de antes
  assert.ok(findButton(root, "✗"));
});

const muchos = (n) => Array.from({ length: n }, (_, i) => r("t" + i, 5)); // n canciones de historial, cada una de su artista
const filas = (root) => (textOf(root).match(/\bt\d+\b/g) ?? []);

test("al llegar al final se añade otra tanda sin repetir y con separador", async () => {
  const env = await boot({ idb: fakeIDB(LI(muchos(25))), io: true });
  const root = await open(env);
  const antes = new Set(filas(root));
  assert.equal(antes.size, 10);
  env.L.io.fire();
  await tick();
  const t = textOf(root);
  assert.match(t, /Tanda 2/);
  const despues = filas(root);
  assert.equal(despues.length, 20); // 20 filas…
  assert.equal(new Set(despues).size, 20); // …y ninguna repetida
});

test("sin más candidatos: mensaje final y no observa más", async () => {
  const env = await boot({ idb: fakeIDB(LI(muchos(12))), io: true });
  const root = await open(env);
  env.L.io.fire();
  await tick();
  env.L.io.fire();
  await tick();
  assert.match(textOf(root), /No quedan más estrellas por ahora/);
  assert.equal(env.L.io.observed.length, 0);
  assert.equal(new Set(filas(root)).size, 12);
});

test("Nuevas sugerencias tras varias tandas vuelve a una sola tanda con apuesta", async () => {
  const env = await boot({ idb: fakeIDB(LI(muchos(25))), io: true });
  const root = await open(env);
  env.L.io.fire();
  await tick();
  click(root, findButton(root, "Nuevas sugerencias"));
  await tick();
  assert.doesNotMatch(textOf(root), /Tanda 2/);
  assert.match(textOf(root), /La apuesta del bandido/);
});

test("sin IntersectionObserver el panel funciona (sin carga automática)", async () => {
  const env = await boot({ idb: fakeIDB(LI(muchos(25))) });
  const root = await open(env);
  assert.match(textOf(root), /La apuesta del bandido/);
  assert.equal(new Set(filas(root)).size, 10);
});
