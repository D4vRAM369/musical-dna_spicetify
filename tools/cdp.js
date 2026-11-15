// Ejecuta JavaScript en la interfaz de Spotify desde la terminal, vía Chrome DevTools Protocol (CDP).
// Requiere Spotify arrancado con: flatpak run com.spotify.Client --remote-debugging-port=9222
// Uso: node --experimental-websocket tools/cdp.js 'MusicalDNA.status'
// (Node 20 necesita --experimental-websocket; desde Node 22, WebSocket ya es global.)
const expr = process.argv[2];
if (!expr) {
  console.error("Uso: node --experimental-websocket tools/cdp.js '<expresión JS>'");
  process.exit(1);
}
(async () => {
  const list = await (await fetch("http://localhost:9222/json/list")).json(); // páginas abiertas en Spotify
  const page = list.find((t) => t.type === "page" && t.url.includes("xpui")); // la interfaz principal
  if (!page) throw new Error("No hay página xpui: ¿Spotify está abierto con --remote-debugging-port=9222?");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onopen = () =>
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  ws.onmessage = (m) => {
    const r = JSON.parse(m.data);
    if (r.id !== 1) return; // ignora otros mensajes del protocolo
    const ex = r.result?.exceptionDetails;
    console.log(ex ? `EXCEPCIÓN: ${ex.exception?.description ?? JSON.stringify(ex)}` : JSON.stringify(r.result?.result?.value ?? r.result?.result, null, 1));
    ws.close();
  };
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
