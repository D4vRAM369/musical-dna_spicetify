# Musical DNA

Extensión de [Spicetify](https://spicetify.app) que te enseña **qué define tu gusto** y te sugiere canciones con un pequeño recomendador que **aprende de lo que escuchas**. Todo se queda en tu equipo.

> **Estado: v0.1 en desarrollo.** Necesita [Listening Intelligence](https://github.com/D4vRAM369/listening-intelligence_spicetify): usa su historial. La interfaz está en español.

*English summary: a Spicetify extension that reads Listening Intelligence's local history (read-only) to show your "seed" songs with explainable scores, and suggests tracks from three sources (your history, your liked songs, songs similar to them) using a Thompson-sampling multi-armed bandit that learns which source works best for you. UI in Spanish.*

## Qué hace

Un icono (una doble hélice) en la barra superior abre un panel con tres pestañas:

| Pestaña | Qué ves |
|---|---|
| **Para ti** | 10 sugerencias. Arriba, «la apuesta del bandido». Cada una dice **por qué** está ahí y cuánto acierta su fuente. ▶ la reproduce, ＋ la pone en la cola. |
| **Cómo aprende** | Aciertos de cada fuente, qué haría ahora el bandido y tus últimas pruebas (✓ / ✗ / ⏳). |
| **Tu ADN** | Tus canciones semilla en tres horizontes (7 días, 30 días, todo), con sus señales y un aviso cuando hay pocos datos. Y tu «antigusto»: lo que siempre saltas. |

### Cómo aprende

Inspirado en el sistema de recomendaciones de Spotify (*bandidos multibrazo*; McInerney et al., 2018, «Explore, Exploit, and Explain»), en pequeño:

1. Hay tres fuentes: **tu historial** (lo que te gusta y hace días que no suena), **tus favoritas** (las guardadas que menos pones) y **similares** (canciones top de artistas relacionados con tus semillas).
2. Cuando pulsas ▶, se anota la prueba: si Listening Intelligence registra esa canción en las 6 h siguientes y la escuchas ≥30 s, la fuente suma un acierto; si la saltas, un fallo.
3. ＋ guarda la canción en «Canciones que te gustan» (pasa a ✓) y cuenta como acierto al momento; quitar el ✓ lo deshace.
4. Arriba va «la apuesta»: la fuente que más acierta. El resto se reparte con *Thompson sampling*: cuanto menos sabe de una fuente, más la prueba; cuanto más sabe, más apuesta por la que acierta. «Cómo aprende» te dice con qué probabilidad cree que cada fuente es la mejor.

5. «Para ti» abre con **tu sistema solar**: tú eres el sol y cada fuente un planeta, más grande y brillante cuanto más probable es que sea la mejor. Al bajar por la lista se cargan solas más sugerencias, tanda a tanda, hasta que no quedan más.
6. ✗ descarta una sugerencia para siempre y cuenta como fallo de su fuente.

Nunca te sugiere lo que sonó en las últimas 72 h, lo que siempre saltas ni lo que descartaste.

## Privacidad

- **Nada sale de tu equipo.** Sin servidor ni cuentas.
- Lee la base de datos de Listening Intelligence **en solo lectura**: nunca la modifica.
- Para favoritas y similares usa APIs internas del propio cliente de Spotify. Si fallan, esas fuentes se desactivan y el resto sigue.
- Sus propios datos (las pruebas) están en `musical-dna:v1`. **Exportar** y **Borrar** en el pie del panel.

## Instalación

**Requisitos:** Spotify de escritorio con Spicetify y Listening Intelligence instalada.

```bash
cp musical-dna.js "$(spicetify path userdata)/Extensions/"
spicetify config extensions musical-dna.js     # se AÑADE a las que ya tengas
spicetify apply
```

Para desinstalar: `spicetify config extensions musical-dna.js-` y `spicetify apply`.

## Desarrollo

Un solo archivo, por capas: lógica pura arriba (exportada como `core`, sin Spotify), lectura de datos y adaptadores en medio, interfaz abajo.

```bash
node --test tests/     # Node 20+, sin dependencias
```

## Licencia

[MIT](LICENSE).
