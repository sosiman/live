# Onda Live — instrucciones para agentes

Documento de trabajo para cualquier agente (o persona) que toque este proyecto.
Explica **qué es**, **cómo funciona por dentro** y **qué decisiones están tomadas
y por qué**, con la evidencia que las respalda. Léelo antes de cambiar nada.

---

## 1. Qué es

Una PWA que **habla y traduce en tiempo real** con la Gemini Live API, en modo
**BYOK**: cada usuario pone su clave de Google y el navegador habla **directo**
con Google. No hay backend de IA, ni cuentas, ni base de datos.

- Conversación de voz fluida y **se puede interrumpir hablando** en cualquier momento.
- Actúa de **intérprete**: traduce lo que oye y solo conversa si le hablas a él.
- **Busca en Google de verdad** (con fuentes visibles) y **resume** lo hablado.
- PWA instalable, formato móvil siempre, y **ventana flotante** en el escritorio.

Producción: **https://live.lockthard.es** (Cloudflare Tunnel → contenedor en
`192.168.0.50:8087`).

---

## 2. Arquitectura

```
   Navegador (móvil o PC)
   ├── interfaz .................. index.html + styles.css + app.js
   ├── audio ..................... audio.js + pcm-worklet.js + pcm-player-worklet.js
   ├── protocolo ................. live.js   (WebSocket oficial del Live API)
   └── herramientas .............. tools.js  (buscar_en_web, hora, traducir, volumen)
        │
        │  wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent?key=…
        ▼
   Google Gemini Live API  ──►  voz 24 kHz + transcripciones + toolCall
        ▲
        │  https://generativelanguage.googleapis.com/v1beta  (REST)
        └── buscar_en_web y resúmenes usan modelos de TEXTO (generateContent)

   servidor (server.mjs): SOLO reparte archivos. No ve la clave, no pasa audio.
```

Tres piezas y ni una más:

| Pieza | Responsabilidad |
| :--- | :--- |
| `server.mjs` | Servir la carpeta `public/` por HTTP/HTTPS. En producción va detrás de Cloudflare. |
| `public/live.js` | Único punto que habla con Google: abre el WebSocket, manda el setup, traduce eventos a `CustomEvent` y reconecta con el handle de sesión. |
| `public/audio.js` | Micrófono con cancelación de eco, remuestreo a 16 kHz, y cola de reproducción de la voz. |

El resto (`app.js`) es estado, interfaz y herramientas.

---

## 3. Decisiones tomadas con la documentación oficial

Fuente: `ai.google.dev/gemini-api/docs/live-api` y su **guía de buenas prácticas**.
Cada una está comprobada contra la API real (ver §6).

| Decisión | Por qué | Dónde |
| :--- | :--- | :--- |
| **Detección de voz del servidor activada** (AAD) | La doc: «es esencial para conversaciones naturales, permite al usuario interrumpir al modelo en cualquier momento». El cliente **no** implementa detección de voz. | `live.js → buildSetup()` |
| **El micrófono nunca se silencia** | Silenciarlo (half-duplex, turnos manuales) rompía la conversación y añadía latencia. Se probó y se descartó. | `audio.js`, `app.js` |
| **Interrupción libre** (`START_OF_ACTIVITY_INTERRUPTS`) | El usuario habla y el modelo se calla. | `live.js → buildSetup()` |
| **Al interrumpir, se descarta el búfer de voz** | La doc lo exige: «you must immediately discard your client-side audio buffer». | `app.js` (evento `interrupted`) → `audio.js → flushPlayback()` |
| **Fragmentos de 32 ms** | La doc: «send audio in chunks of 20ms to 40ms». Con 100 ms se notaba el retardo. | `audio.js → CHUNK_MS` |
| **Compresión de contexto** | El audio gasta ~25 tokens/s; sin compresión la sesión muere a los 15 min. | `live.js → contextWindowCompression` |
| **Reanudación de sesión** | «The server may periodically reset the WebSocket connection». Se guarda el handle. | `live.js → resumeHandle`, `app.js` (reconexión) |
| **Voz por elemento `<audio>`** | Chrome usa esa reproducción como referencia para **cancelar el eco**: así el modelo no se oye a sí mismo por el altavoz. | `audio.js → ensureContext()` |
| **Instrucciones en inglés, persona + reglas + idioma explícito** | La guía recomienda persona, reglas en orden y «RESPOND UNMISTAKABLY IN …». | `app.js → defaultInstructions()` |

### Contexto de cada modelo (medido con la clave del proyecto)

| Modelo | Uso | Entrada |
| :--- | :--- | :--- |
| `gemini-3.8-live` | voz (conversación e interpretación) | **131.072** |
| `gemini-3.8-live-extended-thinking` | voz con razonamiento (LOW/MEDIUM/HIGH obligatorio) | 131.072 |
| `gemini-3.8-flash` | **texto**: buscar, resumir, «Sentido» | **1.048.576** |

La app muestra el consumo en vivo (barra bajo el orbe y desglose en **Panel**).
El dato exacto llega con `usageMetadata` al cerrar cada turno; mientras
tanto se estima con `bytes/1280` (25 tokens por segundo de audio).

---

## 4. Lo que NO hay que hacer (lecciones con evidencia)

1. **No declarar `googleSearch` esperando que busque.** Medido: el Live API
   lo acepta y **no devuelve `groundingMetadata`**; el modelo responde de memoria con
   datos viejos. La búsqueda la hace `buscar_en_web` por REST
   (`generateContent` + `googleSearch`), que sí grounded y devuelve fuentes.
2. **No silenciar el micrófono ni inventar turnos.** Se probó: cualquier voz que
   entre mientras el modelo habla **corta la respuesta a la mitad**, y cerrar el
   micro para evitarlo impide interrumpirle. La solución es cancelación de eco +
   salida por `<audio>`.
3. **No usar el modelo de traducción pura** (`gemini-3.5-live-translate-preview`): no
   admite instrucciones ni herramientas. Traduce igual de bien el asistente.
4. **No declarar campos que esta versión del API no tiene**: `proactivity` y
   `enableAffectiveDialog` devuelven `1007 Cannot find field`.
5. **No hacer VAD propio ni reglas de «600 ms»**: duplican lo que ya hace el servidor.
6. **No añadir dependencias externas al frontend.** La app es autosuficiente
   (se intentó Mermaid desde CDN: fallaba y rompía la vista).
7. **No mover el DOM sin actualizar `activeDoc()`**: la ventana flotante mueve los
   nodos a otro documento y las búsquedas por id dejan de encontrarlos.
8. **No confiar en `Cache-Control` del origen detrás de Cloudflare.** Medido
   (2026-09-16): Cloudflare **sobrescribe** el `no-cache` del origen en `.js`/`.css`
   con un **Browser Cache TTL de 4 horas** (`max-age=14400`), mientras el HTML
   (`cf-cache-status: DYNAMIC`) sí va fresco. Resultado: móviles con el **HTML nuevo y
   el JS viejo** — botones que aparecen y no responden, versiones mezcladas. La salida
   que no depende del CDN es **sellar la versión en las URLs** (`app.js?v=2.8.0`,
   imports con `?v=`, shell del service worker con `?v=`): URL nueva = fallo de caché
   garantizado. **Todo despliegue empieza por `node scripts/sellar-version.mjs`**
   (lee `APP_VERSION`, versiona las URLs, sincroniza `server.mjs`, `package.json`,
   `Dockerfile` y `compose.yaml`, y aborta si el sellado queda mal).
   **Resuelto también en el CDN (2026-09-17):** credenciales en `/root/.cloudflare.env`
   (600, token **de cuenta**, por eso `/user/tokens/verify` da «Invalid API Token» y hay
   que verificar con `/accounts/{id}/tokens/verify`). `deploy/cloudflare-cache.py` deja
   una Cache Rule con `cache: false` + `browser_ttl: respect_origin` para
   `live.lockthard.es`, pone `browser_cache_ttl` de la zona en «respetar cabeceras» y
   purga. **`instalar.sh` ya lo ejecuta en cada despliegue y lo muestra en `estado`.**
   Resultado medido: `cache-control: no-cache` + `cf-cache-status: DYNAMIC` en
   `index.html`, `app.js`, `styles.css` y `sw.js`.
9. **La barra de estado vive en el `index.html`, no en el `app.js`.** `#asa` muestra un
   texto corto por estado (`ETIQUETA_ESTADO` en `app.js → setState()`), se tiñe con un
   barrido (`--verde → --orange → --lila-fuerte`) y late con `--nivel`, que `paintVu()`
   actualiza con el volumen del micrófono. Recoge los tres botones (`.mando`) para dejar
   sitio a los textos: se recoge al empezar a escuchar y al bajar leyendo, y vuelve al
   tocar la barra o al subir. **Ojo con el bucle:** recoger los mandos hace crecer la
   vista y dispara un `scroll` propio, así que `ponerMandos()` marca `bloqueoScroll`
   (600 ms) y el manejador de scroll lo ignora; sin eso se reabría sola.
10. **El primer pintado no puede depender del CSS.** El `index.html` arranca con
   `<html class="cargando">` y un `<style>` crítico en línea: fondo crema, `body`
   oculto y las hojas (`.sheet`, `.sheet-backdrop`) en `display:none`. El `<link>` del
   CSS quita la clase con `onload`, y hay un `setTimeout` de 2,5 s por si el CSS no
   llega. Sin esto se veía el fogonazo: HTML sin estilos, con la hoja de ajustes
   desparramada al final — pasaba sobre todo al abrir sin clave, porque
   `startSession()` llama a `openSettings()`.
11. **Nada de `viewport-fit=cover` en el meta viewport.** Con `cover`, la app se
   dibuja **debajo de la barra de navegación de Android** (los 3 botones): los iconos
   de abajo se veían y las etiquetas quedaban tapadas. Sin `cover`, el navegador
   reserva ese espacio y la maqueta nunca queda por debajo. Además la barra de
   pestañas lleva `calc(16px + var(--safe-b))` de margen inferior. Medido con Chrome
   por CDP a 360x640, 360x744, 360x800 y 393x852: la barra termina siempre dentro de
   la ventana (`tabbar.bottom` 624/728/784/836 con ventanas 640/744/800/852).
12. **El Live API no tiene memoria entre sesiones: la pone la app.** Cada WebSocket
   arranca con el contexto vacío (medido: 1277 → 0 al parar), y `sessionResumption`
   solo sirve para reconectar a la MISMA sesión, no para volver mañana. Por eso
   `app.js` guarda lo hablado en `localStorage` (`onda.memoria.v1`) y al abrir sesión
   inyecta un bloque de contexto en el `systemInstruction`:
   · conversación corta (< 6000 caracteres) → **literal**, sin resumir (fidelidad total:
     nombres, cifras, claves);
   · conversación larga → resumen con `gemini-3.8-flash` de lo antiguo + los últimos
     12 mensajes literales.
   Verificado de punta a punta: se le da un dato en una sesión, se para, y al volver
   responde con él («La clave es 4471»). Ojo al probarlo: hay que usar el compositor o
   la voz (que sí registran en la transcripción), **no** `session.sendTurn()` directo,
   o el dato no se guarda y la prueba miente.
13. **No depender del `app.js` para salir de una caché rota.** El `index.html` lleva un
   script **inline** con `window.__ONDA_VERSION`: si la versión cargada no coincide,
   borra service workers y cachés y recarga. El botón «Forzar actualización» también
   se atiende desde ese script, así que funciona aunque el `app.js` esté viejo.
14. **La purga de Cloudflare puede fallar sin romper nada.** Si el token caduca o se rota
   (pasó el 2026-09-17), `cloudflare-cache.py` devuelve 403 y `instalar.sh` sigue
   desplegando: la Cache Rule y el `browser_cache_ttl` ya aplicados **persisten**, y con
   las URLs versionadas la purga es solo una comodidad. Para reactivarla, actualizar
   `/root/.cloudflare.env`.

---

## 5. Mapa de archivos

```
onda-live/
├── server.mjs                 servidor estático (HTTP/HTTPS), sin dependencias
├── Dockerfile                 imagen node:22-alpine, usuario «node», solo lectura
├── deploy/
│   ├── compose.yaml           contenedor endurecido, publica 8087
│   ├── cloudflare-cache.py    regla de caché + purga (usa /root/.cloudflare.env)
│   └── instalar.sh            desplegar | estado | logs | parar | actualizar
├── public/
│   ├── index.html             orbe, micrófono, transcripción, Investiga, Panel, Ajustes
│   ├── styles.css             paleta cálida; animación de ADN cuando habla
│   ├── app.js                 estado, sesión, interfaz, búsqueda y panel
│   ├── audio.js               micrófono (AEC) + reproducción por <audio>
│   ├── live.js                cliente del Live API + searchWeb()
│   ├── tools.js               herramientas que el modelo puede llamar
│   ├── pcm-worklet.js         captura 16 kHz en bloques de 32 ms
│   ├── pcm-player-worklet.js  cola de reproducción continua a 24 kHz
│   ├── sw.js, manifest.webmanifest, icons/
├── scripts/
│   ├── verify-app.mjs         38 comprobaciones contra la API en Chrome real
│   └── make-icons.mjs         iconos PNG sin dependencias
└── docs/                      capturas de referencia
```

---

## 6. Ejecutar y verificar en local

```sh
node server.mjs                       # https://localhost:8443 (+ aviso por HTTP en 8080)
node server.mjs --http --port 8087    # como en producción
node scripts/verify-app.mjs --key TU_CLAVE
```

### Publicar una versión (orden obligatorio)

```sh
# 1. Subir APP_VERSION en public/app.js
# 2. Sellar la versión en todas las URLs y ficheros (obligatorio)
node scripts/sellar-version.mjs
# 3. Comprobar que arranca sin errores de consola
node scripts/verify-app.mjs --key TU_CLAVE
# 4. Desplegar
tar czf - --exclude=certs --exclude=.git --exclude=node_modules . | ssh root@192.168.0.50 'mkdir -p /opt/onda-live && tar xzf - -C /opt/onda-live'
ssh root@192.168.0.50 'cd /opt/onda-live && ./deploy/instalar.sh actualizar'
```

La verificación abre Chrome por CDP y comprueba de verdad: sesión abierta,
configuración recomendada, ritmo de 32 kB/s, cancelación de eco activa, respuesta
con voz, descarte del búfer al interrumpir, búsqueda real con fuentes, resumen,
contexto en vivo, barra de estado con mandos que se recogen y ventana flotante.
**Debe salir 38/38.**

En el móvil hace falta HTTPS (el navegador no da micrófono sin contexto seguro):
el certificado autofirmado se acepta una vez, o se instala desde `/certificado`.

---

## 7. Despliegue (servidor + Cloudflare)

```sh
# desde este equipo
tar czf - --exclude=certs --exclude=.git --exclude=node_modules . \
  | ssh root@192.168.0.50 'mkdir -p /opt/onda-live && tar xzf - -C /opt/onda-live'

# en el servidor
ssh root@192.168.0.50 'cd /opt/onda-live && ./deploy/instalar.sh desplegar'
```

- Contenedor **sin privilegios**: usuario `node` (1000), `read_only`, `cap_drop: ALL`,
  `no-new-privileges` y `tmpfs` de 16 MB. El demonio de Docker es rootful: si se
  quiere rootless de verdad hay que instalar Podman o Docker rootless (pendiente).
- **Puerto 8087**: es el que espera el túnel (*Cloudflare Zero Trust* →
  `live.lockthard.es` → `http://192.168.0.50:8087`).
- **El TLS lo pone Cloudflare**, así que el origen va por HTTP. En el navegador la
  página es HTTPS y por eso el micrófono funciona.
- **No hace falta WebSocket en el túnel**: la app habla con Google directamente.

Comprobación de que está vivo:

```sh
curl -s http://192.168.0.50:8087/__health        # desde la red
curl -s https://live.lockthard.es/__health       # a través de Cloudflare
```

---

## 8. Privacidad y coste

- La clave vive en el `localStorage` del navegador del usuario. El contenedor no la ve.
- El audio viaja a Google; el servidor no lo toca ni lo guarda.
- Cada usuario paga su consumo en su proyecto de Google AI. La app muestra el
  contexto consumido, pero **no es un límite de gasto**.
- La búsqueda y los resúmenes gastan tokens del modelo de texto de la misma clave.

---

## 9. Estado y pendientes

**Funciona y está verificado (38/38):** conversación, interrupción libre,
intérprete, búsqueda con fuentes en «Investiga», resúmenes y notas en «Panel»,
contexto en vivo, barra de estado animada con mandos que se recogen, PWA,
ventana flotante y despliegue en contenedor con purga de CDN.

**Pendiente / ideas acordadas:**
- Sala con varias personas ([`docs/SALA.md`](docs/SALA.md)): un anfitrión con la clave
  y los invitados entrando por enlace. Requiere relé en el servidor.
- Rootless real (Podman) si se quiere prescindir del demonio rootful.
- Vídeo (que el modelo vea la pantalla): funciona a nivel de motor, desactivado
  en la interfaz porque en Wayland el portal de PipeWire tumbaba la sesión.
