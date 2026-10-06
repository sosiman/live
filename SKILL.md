---
name: wow-agent
description: "Agente de voz especializado en World of Warcraft (proyecto Forever): loot, BiS, builds, talentos, macros, addons, misiones, mapas, jefes y parches. Usar para operar, desplegar, depurar o extender la app: WebSocket del Live API, busqueda guiada por fuentes (Wowhead, Icy Veins, Murlok, Raider.IO, Warcraft Logs, Wago, CurseForge), memoria entre sesiones, PWA y su contenedor en el servidor."
version: 3.3.3
author: Sosi + agente DSH
license: MIT
platforms: [linux, web]
metadata:
  tags: [wow, world-of-warcraft, forever, voz, gemini-live, pwa, byok, contenedor]
---

# Forever / wow-agent — Agente de voz de World of Warcraft

App PWA que **escucha y contesta por voz** sobre World of Warcraft, con la mínima
latencia posible, usando la **Gemini Live API** en modo **BYOK** (cada usuario pone su
clave de Google). El navegador habla **directo** con Google: no hay backend de IA, ni
cuentas, ni base de datos, y el servidor no ve la clave ni el audio.

**Producción:** <https://wow.loktar.cc> · **Contenedor:** `wow-agent` en `192.168.0.50:8087`

---

## 1. Estado actual (a fecha de este documento)

| | |
| :--- | :--- |
| Versión de la app | **3.3.3** (`APP_VERSION` en `public/app.js`) |
| Dominio | **wow.loktar.cc** (Cloudflare Tunnel → `http://192.168.0.50:8087`) |
| Repo local | `/home/sosi/Escritorio/wow agent/wow-agent` |
| Repo remoto | <https://github.com/sosiman/live> |
| Servidor | `/opt/wow-agent` · contenedor `wow-agent` (imagen `wow-agent:3.3.3`) |
| Verificación | **42/42** con `node scripts/verify-app.mjs --url https://wow.loktar.cc` |
| Logo | `public/icons/logo.svg` (la «W»), iconos generados con `scripts/render-icons.mjs` |

> **Nombres internos que NO se renombran:** las claves del navegador siguen siendo
> `onda.settings.v2`, `onda.memoria.v1`, `onda.research.v1`, `onda.board.v1` y el asa de
> depuración `window.Onda` (con alias `window.Forever`). Cambiarlas **borraría ajustes y
> memoria** de quien ya la usa.

---

## 2. Qué hace hoy

- **Especialista de WoW por voz**: loot y porcentajes de drop, BiS, builds y talentos,
  prioridad de stats, macros, addons y WeakAuras, misiones, mapas y coordenadas, jefes y
  mecánicas, profesiones, PvP, economía y notas de parche.
- **Contesta corto y hablado**: primero el dato en una frase (nombre, cifra, zona,
  coordenada), luego el detalle. Nunca lee listas ni URLs en voz alta.
- **Busca cuando el dato puede cambiar** y deja las fuentes a la vista en la pestaña
  *Investiga* (consulta, resumen y enlaces).
- **Recuerda entre sesiones**: guarda lo hablado y al despertar inyecta el contexto.
- **Modo traductor** a demanda («modo traductor»): sigue interpretando voz si se lo piden.
- **PWA instalable** y **ventana flotante** en el escritorio.

---

## 3. Arquitectura (tres piezas y ni una más)

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
        └── buscar_en_web y los resúmenes usan modelos de TEXTO (generateContent)

   servidor (server.mjs): SOLO reparte archivos. No ve la clave, no pasa audio.
```

| Pieza | Responsabilidad |
| :--- | :--- |
| `server.mjs` | Servir `public/` por HTTP/HTTPS. En producción, detrás de Cloudflare. |
| `public/live.js` | Único punto que habla con Google: setup del WebSocket, eventos, reconexión. |
| `public/audio.js` | Micrófono con cancelación de eco, remuestreo a 16 kHz y cola de voz. |

**Dos modelos, dos papeles:** `gemini-3.8-live` pone la voz (solo emite audio: es incapaz
de escribir); `gemini-3.8-flash` (texto, contexto de 1 M) escribe los resúmenes, la
memoria y las búsquedas. Contexto: 131.072 tokens el de voz, 1.048.576 el de texto.

---

## 4. El prompt (qué lleva dentro)

Vive en `public/app.js → defaultInstructions()` y es editable en Ajustes. Reglas clave:

1. **Voz primero**: el dato directo en una frase; después, como mucho, dos frases más.
2. **Nunca lee listas, tablas ni URLs**; si usó fuentes, dice «tienes las fuentes en Investigar».
3. **Nunca inventa** cifras, porcentajes ni nombres: si duda, busca.
4. **Pregunta una vez** en qué versión/expansión juega (si hace falta) y lo recuerda.
5. **Idioma**: contesta en el idioma del usuario, pero deja los nombres (objetos, jefes,
   habilidades) en inglés, como en el juego.
6. **Memoria**: usa el bloque de contexto anterior y no lo lee en voz alta.
7. **Comandos de voz**: «busca en wowhead…», «modo traductor», «modo juego/modo wow».

`INSTRUCTION_VERSION` (hoy **5**) controla que las instalaciones existentes reciban el
prompt nuevo sin pisar el que el usuario haya personalizado.

---

## 5. Herramientas del modelo

`buscar_en_web(consulta, fuente)` — búsqueda real por REST con `googleSearch` y fuentes.
El argumento `fuente` limita la búsqueda con `site:`:

| Fuente | Para qué |
| :--- | :--- |
| `wowhead` / `wowhead-es` | objetos, misiones, NPCs, mapas, coordenadas, % de drop |
| `icy-veins` | guías de clase, subida de nivel, raids y mazmorras |
| `murlok` | builds y stats reales de los mejores en M+ y PvP |
| `raiderio` · `warcraftlogs` | puntuación M+, runs, logs y parses |
| `wago` · `curseforge` | WeakAuras y addons |
| `wowprogress` · `method` · `simc` | progresión, guías de alto nivel, simulaciones |
| `general` | cuando no aplica ninguna |

Además: `hora_actual`, `traducir_texto`, `ajustar_volumen` y `estado_sesion`.

> **Medido:** el Live API acepta el tool `googleSearch` del servidor pero **no busca**
> (no devuelve `groundingMetadata`). Por eso la búsqueda se hace por REST desde la app.

---

## 6. Memoria entre sesiones

El Live API **no tiene memoria**: cada WebSocket arranca vacío y `sessionResumption` solo
reconecta a la MISMA sesión. La memoria la pone la app:

- Al **parar** la sesión se guarda lo hablado en `localStorage` (`onda.memoria.v1`).
- Al **abrir** sesión se inyecta un bloque en el `systemInstruction`:
  · conversación corta (< 6.000 caracteres) → **literal**, sin resumir (fidelidad total);
  · conversación larga → resumen de lo antiguo con `gemini-3.8-flash` + los **últimos 12
    mensajes literales**.
- En Ajustes: interruptor, estado («Guardados N mensajes de M sesiones») y
  **«Olvidar conversaciones anteriores»**.

**Sobrevive a cerrar la app** (es disco, no memoria volátil). Solo se pierde borrando los
datos del sitio, en incógnito o con «Olvidar». El botón «Forzar actualización» **no** la toca.

---

## 7. La interfaz

- **Escucha**: el orbe (con la hélice de ADN cuando habla), el contexto consumido en vivo
  y los tres botones: «Qué dijo» (traduce lo último oído), micrófono y «Terminar».
- **Texto**: transcripción de la conversación, con copiar y limpiar, y un compositor para
  escribir en vez de hablar.
- **Investiga**: cada búsqueda con su consulta, su resumen y **los enlaces de las fuentes**.
- **Panel**: resúmenes de lo hablado, notas que pegas tú y el desglose del contexto.
- **Barra de estado**: siempre visible; se tiñe con un barrido y late con el volumen del
  micrófono. Recoge los tres botones (al empezar a escuchar, al bajar leyendo) y los
  devuelve al tocarla o al subir.
- **Ajustes**: clave, modelos, voz, idioma, instrucciones, memoria, copiar/pegar ajustes
  y memoria, forzar actualización y diagnóstico de pantalla.

---

## 8. Operar y desplegar

```sh
cd "/home/sosi/Escritorio/wow agent/wow-agent"

# 1. Subir APP_VERSION en public/app.js
node scripts/sellar-version.mjs          # versiona las URLs (OBLIGATORIO)
node scripts/verify-app.mjs --key CLAVE  # 42 comprobaciones en Chrome real

# 2. Desplegar
tar czf - --exclude=certs --exclude=.git --exclude=node_modules . \
  | ssh root@192.168.0.50 'mkdir -p /opt/wow-agent && tar xzf - -C /opt/wow-agent'
ssh root@192.168.0.50 'cd /opt/wow-agent && ./deploy/instalar.sh actualizar'

# 3. Comprobar
ssh root@192.168.0.50 'cd /opt/wow-agent && ./deploy/instalar.sh estado'
curl -s https://wow.loktar.cc/__health
```

`instalar.sh` acepta `desplegar`, `actualizar`, `estado`, `logs` y `parar`. El contenedor
es **node:22-alpine sin privilegios** (usuario `node`, disco de solo lectura, `cap_drop: ALL`,
`no-new-privileges`) y el TLS lo pone Cloudflare, por eso el móvil obtiene micrófono sin avisos.

**Cambiar de dominio:** `./scripts/cambiar-dominio.sh viejo.dominio nuevo.dominio`.

**Caché:** Cloudflare tiende a cachear `.js`/`.css` 4 horas ignorando el origen; por eso las
URLs van selladas con `?v=` y `deploy/cloudflare-cache.py` deja una Cache Rule con
`cache: false` + `browser_ttl: respect_origin` y purga. `instalar.sh` lo ejecuta solo.
Credenciales en `/root/.cloudflare.env` (600) del servidor, zona `loktar.cc`.

---

## 9. Trampas ya pisadas (no repetir)

1. El **Live API no busca** con `googleSearch`: la búsqueda va por REST desde la app.
2. **No silenciar el micrófono** ni inventar turnos: la cancelación de eco + salida por
   `<audio>` es lo que permite interrumpir hablando sin que se corten las respuestas.
3. Fragmentos de **32 ms** (la doc pide 20-40 ms); con 100 ms se notaba el retardo.
4. Al recibir `interrupted` hay que **tirar el búfer de voz** del cliente (lo exige la doc).
5. `proactivity` y `enableAffectiveDialog` **no existen** en esta versión del API (error 1007).
6. **Sin dependencias externas** en el frontend (Mermaid desde CDN fallaba y rompía la vista).
7. La ventana flotante mueve el DOM: usar `activeDoc()` para buscar elementos.
8. **Sellar la versión antes de desplegar**: sin eso, Cloudflare deja HTML nuevo con JS viejo.
9. Nada de `viewport-fit=cover`: la barra de pestañas quedaba debajo de los botones de Android.
10. El primer pintado no puede depender del CSS (fogonazo): hay CSS crítico en línea.

---

## 10. Privacidad y coste

- La clave vive en el `localStorage` del usuario y solo se usa contra Google.
- El audio va del navegador a Google; el servidor no lo toca ni lo guarda.
- Cada usuario paga su consumo en su propio proyecto de Google AI.
- **Pendiente:** fijar en el prompt la versión/expansión exacta de «Forever» (el servidor de
  Sosi), y afinar las fuentes si es Classic o un servidor propio.
