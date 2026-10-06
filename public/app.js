/**
 * Onda Live — aplicación.
 *
 * Construida sobre la documentación oficial del Live API, sin inventos:
 *  · WebSocket directo del navegador a Google (BYOK). Este servidor solo sirve
 *    archivos: no ve la clave ni pasa audio.
 *  · Detección de voz del servidor: el usuario puede interrumpir a Onda
 *    hablando en cualquier momento, sin esperar a que termine.
 *  · Al recibir «interrupted» se descarta el búfer de voz al instante, como
 *    pide la guía de buenas prácticas.
 *  · El micrófono no se silencia nunca: la cancelación de eco del navegador es
 *    la que evita que Onda se oiga a sí misma.
 */
import { AudioEngine } from './audio.js?v=3.0.0';
import { LiveSession, fetchModels, generateText, searchWeb, VOICES, modelCapabilities, explainLiveError } from './live.js?v=3.0.0';
import { buildToolDeclarations, executeToolCall } from './tools.js?v=3.0.0';

const APP_VERSION = '3.0.0';
// Los nodos pueden estar en la ventana principal o en la flotante (se MUEVEN),
// así que toda búsqueda se hace en el documento activo.
const activeDoc = () => (pipWindow && pipWindow.document && pipWindow.document.body ? pipWindow.document : document);
const $ = (id) => activeDoc().getElementById(id);
const KEY_STORE = 'onda.settings.v2';

const INTERPRETER_MARK = 'You are Onda, a real-time interpreter';
// Sube este número cuando cambie el prompt de fábrica: así las instalaciones
// existentes reciben el nuevo sin perder las que el usuario haya personalizado.
const INSTRUCTION_VERSION = 3;

function languageName(code) {
  const clean = String(code || 'es').split('-')[0].toLowerCase();
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(clean) || clean; } catch { return clean; }
}

/**
 * Instrucciones de intérprete. La guía recomienda: persona, reglas en orden,
 * el idioma objetivo explícito y sin ambigüedad.
 */
function defaultInstructions(targetCode) {
  const mio = languageName(targetCode || 'es');
  return [
    'You are Onda, a real-time interpreter and voice assistant.',
    'YOU SPEAK: ' + mio + '. The person in front of the user may speak ANY language; detect it yourself and never ask which language it is.',
    '',
    'DEFAULT JOB - INTERPRET so both sides understand each other:',
    '- When you hear a language that is NOT ' + mio + ', translate it into ' + mio + ', phrase by phrase, as it is spoken, keeping the speaker tone.',
    '- When you hear ' + mio + ', translate it into the other language you have detected, so the other person understands too.',
    '- If you have not detected a second language yet, just translate anything that is not ' + mio + ' into ' + mio + '.',
    '- Never comment on the audio and never answer it: translate it. Do not repeat the original before the translation.',
    '',
    'VOICE COMMANDS - obey them immediately, without asking for confirmation:',
    '- "modo traductor", "empieza a traducir", "interpreta", "translate mode" -> start interpreting everything.',
    '- "modo conversacion", "para de traducir", "modo normal" -> stop translating and just talk with the user.',
    '- When you switch, say one short sentence in ' + mio + ' to confirm and then do it.',
    '',
    'WHEN SOMEONE TALKS TO YOU DIRECTLY (a question, the name Onda, a request): answer briefly in ' + mio + ' and go back to interpreting.',
    'ALWAYS ANSWER THE USER IN ' + mio.toUpperCase() + '.',
    'Keep every answer short and natural, like a person talking, never like a robot reading a text.',
    'If you hear nothing or it is unintelligible, say it in one short sentence in ' + mio + ' and wait. Never invent what you did not hear.',
    'You have a tool called buscar_en_web: use it BEFORE answering anything about news, sports results, prices, public offices, releases or any fact that may have changed. Never answer those from memory.',
  ].join('\n');
}

const DEFAULTS = {
  apiKey: '', model: 'gemini-3.8-live', voice: 'Puck', meaningLang: 'es',
  silenceMs: 700, volume: 100, systemInstruction: '',
  resumption: true, toolTime: true, toolTranslate: true, toolVolume: true, toolStatus: true, toolSearch: true,
  // Modelo barato y con datos frescos para la busqueda y el boton «Sentido».
  textModel: 'gemini-3.8-flash',
  rememberSessions: true,
};

const isAndroid = /Android/i.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const readJSON = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privado */ } };

const settings = { ...DEFAULTS, ...readJSON(KEY_STORE, {}) };
const saveSettings = () => writeJSON(KEY_STORE, settings);

/**
 * Migración del prompt: si el guardado es un prompt de fábrica ANTIGUO (empieza
 * por la marca y el usuario no lo ha tocado), se sustituye por el nuevo. Si el
 * usuario lo personalizó, se respeta tal cual.
 */
function migrarInstrucciones() {
  const guardado = settings.systemInstruction || '';
  const esDeFabrica = guardado === '' || guardado.indexOf(INTERPRETER_MARK) === 0;
  if (!settings.customInstruction && esDeFabrica && (settings.instructionVersion || 0) < INSTRUCTION_VERSION) {
    settings.systemInstruction = defaultInstructions(settings.meaningLang);
    settings.instructionVersion = INSTRUCTION_VERSION;
    saveSettings();
    return true;
  }
  if (!settings.systemInstruction) settings.systemInstruction = defaultInstructions(settings.meaningLang);
  return false;
}
const promptActualizado = migrarInstrucciones();

let session = null;
let engine = null;
let pipWindow = null;
let running = false;
let starting = false;
let sessionStartedAt = 0;
let tokenLimit = 131072;   // se ajusta con el límite real del modelo elegido
let reconnectAttempts = 0;
const transcript = [];
let liveTurn = null;
let liveYou = null;

// ------------------------------------------------------------------ interfaz
function toast(message, ms = 3600) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}
/**
 * Los mandos se recogen dejando solo la barra: así los textos ocupan toda la
 * pantalla. Se abren tocando la barra y al subir con el dedo; se recogen al
 * bajar. El estado se guarda en body[data-mandos].
 */
let bloqueoScroll = 0;
function ponerMandos(visible) {
  for (const d of [document, pipWindow?.document].filter(Boolean)) {
    d.body.dataset.mandos = visible ? 'abiertos' : 'ocultos';
    const asa = d.getElementById('asa');
    if (asa) asa.setAttribute('aria-expanded', visible ? 'true' : 'false');
  }
  // Al recogerse, la vista crece y dispara un scroll propio: se ignora un
  // instante para que no se vuelva a abrir sola (bucle).
  bloqueoScroll = Date.now() + 600;
}
function mandosVisibles() {
  return (activeDoc().body.dataset.mandos || 'abiertos') === 'abiertos';
}

// Texto corto de la barra segun el estado (el aviso largo va en .hint).
const ETIQUETA_ESTADO = {
  idle: 'Micrófono apagado', connecting: 'Conectando…', listening: 'Escuchando',
  thinking: 'Pensando…', speaking: 'Hablando', error: 'Sin conexión',
};
function setState(state) {
  for (const d of [document, pipWindow?.document].filter(Boolean)) {
    d.body.dataset.state = state;
    const t = d.getElementById('asaTexto');
    if (t) t.textContent = ETIQUETA_ESTADO[state] || 'Micrófono apagado';
  }
}
function setMicState(state) { for (const d of [document, pipWindow?.document].filter(Boolean)) d.body.dataset.mic = state; }
const setStatus = (t) => { $('status').textContent = t; };
const setPrimary = (t) => { $('primary').textContent = t; };
function setSecondary(t) { const el = $('secondary'); el.textContent = t || ''; el.hidden = !t; }
function setYou(t) { const el = $('youLine'); el.textContent = t ? 'Tú · ' + t : ''; el.hidden = !t; }

const liveNodes = { them: null, me: null };
function pushMessage(role, text, meta = '') {
  transcript.push({ role, text, meta, at: Date.now() });
  if (transcript.length > 4000) transcript.shift();
  const node = document.createElement('div');
  node.className = 'msg ' + role;
  node.textContent = text;
  if (meta) {
    const span = document.createElement('span');
    span.className = 'meta';
    span.textContent = meta;
    node.appendChild(span);
  }
  const holder = $('transcript');
  holder.appendChild(node);
  holder.scrollTop = holder.scrollHeight;
}
function updateLiveNode(role, text) {
  let node = liveNodes[role];
  if (!node || !node.isConnected) {
    node = document.createElement('div');
    node.className = 'msg ' + role + ' live';
    $('transcript').appendChild(node);
    liveNodes[role] = node;
  }
  node.textContent = text;
  const holder = $('transcript');
  holder.scrollTop = holder.scrollHeight;
}
const clearLiveNode = (role) => { liveNodes[role]?.remove(); liveNodes[role] = null; };

/**
 * Doble hélice para el orbe: 14 peldaños girando desfasados. Generada aquí para
 * no llenar el HTML de etiquetas.
 */
function montarAdn() {
  const caja = document.getElementById('adn');
  if (!caja || caja.children.length) return;
  for (let i = 0; i < 14; i++) {
    const peldano = document.createElement('i');
    peldano.style.setProperty('--i', String(i));
    caja.appendChild(peldano);
  }
}

/**
 * Rescate para el modo «Sitio para ordenadores» del móvil: Chrome ignora el
 * meta viewport, maqueta la página a ~980 px y la encoge para que quepa, así que
 * TODO se ve a un tercio. Aquí se compensa con zoom para que la app se vea al
 * tamaño real de un móvil. En un móvil normal (360-430 px) no hace nada.
 */
let zoomAvisado = false;
function ajustarZoom() {
  const tactil = matchMedia('(pointer: coarse)').matches;
  const ancho = window.innerWidth;
  const z = (tactil && ancho >= 700) ? Math.min(3.2, ancho / 430) : 1;
  const raiz = document.documentElement;
  if (z === 1) {
    raiz.style.zoom = '';
    raiz.style.removeProperty('--zoom');
    return;
  }
  raiz.style.zoom = String(z);
  raiz.style.setProperty('--zoom', String(z));
  if (!zoomAvisado) {
    zoomAvisado = true;
    toast('Tu navegador está en «Sitio para ordenadores». Desactívalo en el menú ⋮ para verlo aún mejor.', 14000);
  }
}

function paintVu(level) {
  // La barra de abajo respira con el nivel de voz (--nivel la usa el CSS).
  const suave = Math.min(1, Math.round(level * 6 * 10) / 10);
  for (const d of [document, pipWindow?.document].filter(Boolean)) d.body.style.setProperty('--nivel', String(suave));
  const bars = $('vu').children;
  const activas = Math.round(Math.min(1, level * 6) * bars.length);
  for (let i = 0; i < bars.length; i++) {
    const on = i < activas;
    bars[i].style.height = (on ? 6 + (i / bars.length) * 10 : 3) + 'px';
    bars[i].style.opacity = on ? '1' : '.28';
  }
}

function getEngine() {
  if (!engine) {
    engine = new AudioEngine({
      onChunk: (pcm) => session?.sendAudio(pcm),
      onLevel: paintVu,
      onError: (m) => toast(m, 5200),
    });
  }
  return engine;
}

// ------------------------------------------------------------------ sesión
// ----------------------------------------------------------- memoria persistente
/**
 * El contexto del modelo vive DENTRO del WebSocket: al parar se pierde y una
 * sesion nueva empieza vacia. La API no guarda memoria entre conexiones, asi que
 * la memoria la pone la app: se guarda lo hablado en el navegador y, al abrir
 * sesion, se le inyecta un resumen como trasfondo.
 */
const MEM_STORE = 'onda.memoria.v1';
let memoria = readJSON(MEM_STORE, { crudo: [], resumen: '', sucio: false, actualizado: 0, sesiones: 0 });
let instruccionMemoria = '';
const guardarMemoria = () => writeJSON(MEM_STORE, memoria);
const memoriaVacia = () => !memoria.crudo.length && !memoria.resumen;

/** Guarda lo hablado en esta sesion para las siguientes. */
function recordarSesion() {
  if (!settings.rememberSessions) return;
  const nuevos = transcript.filter((m) => m.text && m.text.trim());
  if (!nuevos.length) return;
  memoria.crudo = memoria.crudo.concat(nuevos.map((m) => ({ role: m.role, text: m.text, at: m.at }))).slice(-600);
  memoria.sesiones = (memoria.sesiones || 0) + 1;
  memoria.sucio = true;
  memoria.actualizado = Date.now();
  guardarMemoria();
  pintarMemoria();
}

/**
 * Devuelve el bloque de memoria para el setup.
 *  - Conversacion corta  -> se inyecta LITERAL (fidelidad total: nombres, cifras...).
 *  - Conversacion larga  -> resumen de lo antiguo + los ultimos mensajes literales.
 */
const MEM_LITERAL = 6000;   // caracteres
const MEM_RECIENTE = 12;    // mensajes que van siempre tal cual

async function prepararMemoria() {
  instruccionMemoria = '';
  if (!settings.rememberSessions || memoriaVacia()) return;
  const texto = memoria.crudo.map((m) => (m.role === 'me' ? 'Tu: ' : 'Onda: ') + m.text).join('\n');

  const cabecera = 'CONTEXTO DE CONVERSACIONES ANTERIORES CON ESTE USUARIO (es trasfondo: no lo traduzcas, no lo leas en voz alta y no lo menciones salvo que te lo pidan):';

  if (texto.length <= MEM_LITERAL) {
    instruccionMemoria = cabecera + '\n' + texto;
    return;
  }

  if (!memoria.resumen || memoria.sucio) {
    const antiguo = memoria.crudo.slice(0, -MEM_RECIENTE).map((m) => (m.role === 'me' ? 'Tu: ' : 'Onda: ') + m.text).join('\n');
    try {
      memoria.resumen = await generateText({
        apiKey: settings.apiKey, model: settings.textModel,
        systemInstruction: 'Resume en tercera persona y en el idioma del usuario lo esencial de esta conversacion: temas, nombres propios, decisiones, datos concretos y pendientes. Maximo 15 lineas. Sin saludos ni relleno.',
        prompt: antiguo,
      });
      memoria.sucio = false;
      guardarMemoria();
      pintarMemoria();
    } catch { /* sin resumen se sigue, simplemente sin memoria */ }
  }
  if (memoria.resumen) {
    const recientes = memoria.crudo.slice(-MEM_RECIENTE).map((m) => (m.role === 'me' ? 'Tu: ' : 'Onda: ') + m.text).join('\n');
    instruccionMemoria = cabecera + '\n' + memoria.resumen + '\n\nUltimos mensajes, literales:\n' + recientes;
  }
}

function pintarMemoria() {
  const el = $('memoriaEstado');
  if (!el) return;
  if (!settings.rememberSessions) { el.textContent = 'Memoria desactivada: cada sesion empieza de cero.'; return; }
  if (memoriaVacia()) { el.textContent = 'Sin memoria guardada todavia.'; return; }
  const cuando = memoria.actualizado ? new Date(memoria.actualizado).toLocaleString('es-ES') : '';
  el.textContent = 'Guardados ' + memoria.crudo.length + ' mensajes de ' + (memoria.sesiones || 0) + ' sesion(es). Ultima: ' + cuando + '.';
}

function olvidarMemoria() {
  memoria = { crudo: [], resumen: '', sucio: false, actualizado: 0, sesiones: 0 };
  guardarMemoria();
  pintarMemoria();
  toast('Memoria borrada: la proxima sesion empieza de cero.', 3000);
}

function configForSession() {
  const caps = modelCapabilities(settings.model);
  return {
    voice: settings.voice,
    systemInstruction: [settings.systemInstruction, instruccionMemoria].filter(Boolean).join('\n\n'),
    silenceMs: Number(settings.silenceMs) || 700,
    resumption: settings.resumption,
    tools: caps.canUseTools ? buildToolDeclarations(settings) : [],
  };
}

async function startSession() {
  if (starting) return;
  starting = true;
  try {
    if (!settings.apiKey) { openSettings(); throw new Error('Añade tu clave de API de Google en Ajustes.'); }
    if (!window.isSecureContext) throw new Error('Sin HTTPS el navegador bloquea el micrófono. Abre la app con https://');
    setState('connecting');
    setStatus('Conectando…');

    const audio = getEngine();
    await audio.ensureContext();
    audio.setPlaybackVolume(settings.volume / 100);
    if (!audio.source) await audio.addMicrophone();
    else await audio.startCapture();

    setStatus('Preparando memoria…');
    await prepararMemoria();
    session = new LiveSession({ apiKey: settings.apiKey, model: settings.model, config: configForSession() });
    wireSession(session);
    await session.connect();

    running = true;
    sessionStartedAt = Date.now();
    reconnectAttempts = 0;
    setMicState('on');
    $('livePill').hidden = false;
    setState('listening');
    setStatus('Escuchando');
    ponerMandos(false);
    if (instruccionMemoria) toast('Memoria cargada: ' + memoria.crudo.length + ' mensajes de ' + (memoria.sesiones || 0) + ' sesión(es).', 3600);
    $('hint').textContent = 'Habla con normalidad · puedes interrumpirla cuando quieras';
    renderContexto();
  } catch (err) {
    setState('error');
    setMicState('off');
    setStatus('No se pudo iniciar');
    toast(err.message || String(err), 6000);
    running = false;
  } finally {
    starting = false;
  }
}

function wireSession(current) {
  current.addEventListener('ready', () => { setState('listening'); setStatus('Escuchando'); });
  current.addEventListener('modelturn', (event) => {
    for (const chunk of event.detail.audio) getEngine().playBase64(chunk);
    if (event.detail.audio.length) { setState('speaking'); setStatus('Hablando'); }
    if (event.detail.text) setPrimary(event.detail.text);
  });
  current.addEventListener('outputtranscript', (event) => {
    liveTurn = { text: (liveTurn?.text || '') + event.detail.text };
    setPrimary(liveTurn.text);
    updateLiveNode('them', liveTurn.text);
  });
  current.addEventListener('inputtranscript', (event) => {
    if (event.detail.final) {
      liveYou = { text: (liveYou?.text || '') + event.detail.text };
      setYou(liveYou.text);
      updateLiveNode('me', liveYou.text);
    } else setYou(event.detail.text);
  });
  current.addEventListener('turncomplete', () => {
    if (liveTurn?.text) { clearLiveNode('them'); pushMessage('them', liveTurn.text, settings.model); liveTurn = null; }
    if (liveYou?.text) { clearLiveNode('me'); pushMessage('me', liveYou.text, 'tú'); liveYou = null; }
    if (running) { setState('listening'); setStatus('Escuchando'); }
  });
  // La guía lo pide explícitamente: al interrumpir, se descarta el búfer.
  current.addEventListener('interrupted', () => {
    getEngine().flushPlayback();
    if (liveTurn?.text) { clearLiveNode('them'); pushMessage('them', liveTurn.text, settings.model); liveTurn = null; }
    setState('listening');
    setStatus('Te escucho');
  });
  current.addEventListener('toolcall', async (event) => {
    setState('thinking');
    setStatus('Usando una herramienta…');
    const responses = [];
    for (const call of event.detail) {
      let result;
      try { result = await executeToolCall(call.name, call.args || {}, toolContext()); }
      catch (err) { result = { ok: false, error: String(err.message || err) }; }
      window.Onda.lastTool = { name: call.name, args: call.args, result };
      if (call.name === 'buscar_en_web' && result && result.ok) {
        addResearch({
          cuando: Date.now(),
          consulta: String((call.args || {}).consulta || ''),
          resumen: result.resumen || '',
          consultas: result.consultas || [],
          fuentes: result.fuentes || [],
        });
      }
      responses.push({ id: call.id, name: call.name, response: result });
    }
    current.sendToolResponse(responses);
    if (running) { setState('listening'); setStatus('Escuchando'); }
  });
  current.addEventListener('usage', renderContexto);
  current.addEventListener('apierror', (event) => {
    const message = explainLiveError(event.detail?.message || JSON.stringify(event.detail));
    toast(message, 6000);
    setStatus(message);
  });
  current.addEventListener('goaway', () => toast('El servidor renovará la sesión; se reanuda sola.', 4200));
  current.addEventListener('closed', (event) => {
    if (!running) return;
    if (settings.resumption && current.resumeHandle && reconnectAttempts < 3) {
      reconnectAttempts += 1;
      setStatus('Reconectando (' + reconnectAttempts + '/3)…');
      setTimeout(() => {
        const resumed = new LiveSession({ apiKey: settings.apiKey, model: settings.model, config: configForSession() });
        resumed.resumeHandle = current.resumeHandle;
        wireSession(resumed);
        session = resumed;
        resumed.connect().catch((err) => { toast('No se pudo reanudar: ' + err.message, 5200); stopSession(); });
      }, 700 * reconnectAttempts);
      return;
    }
    setStatus(explainLiveError(event.detail.reason || '') || 'Sesión cerrada');
    stopSession();
  });
}

function toolContext() {
  return {
    defaultTarget: settings.meaningLang,
    // Busqueda real por REST: el Live API no ejecuta googleSearch (medido).
    search: (consulta) => searchWeb({ apiKey: settings.apiKey, model: settings.textModel, query: consulta }),
    setVolume: (nivel) => { settings.volume = nivel; saveSettings(); $('volume').value = String(nivel); getEngine().setPlaybackVolume(nivel / 100); },
    translate: async (text, target) => generateText({
      apiKey: settings.apiKey, model: settings.textModel,
      systemInstruction: 'Translate the text into the requested language. Return only the translation.',
      prompt: 'Target language: ' + target + '\nText: ' + text,
    }),
    getState: () => ({ modelo: settings.model, idioma: settings.meaningLang, segundos: running ? Math.round((Date.now() - sessionStartedAt) / 1000) : 0, ok: true }),
  };
}

function stopSession() {
  recordarSesion();
  running = false;
  session?.close();
  session = null;
  setMicState('off');
  $('livePill').hidden = true;
  setState('idle');
  setStatus('Listo cuando quieras');
  ponerMandos(true);
  getEngine().flushPlayback();
  renderContexto();
  setYou('');
}

// ------------------------------------------------------------------ botones
$('btnMic').addEventListener('click', () => { running ? stopSession() : startSession(); });
$('btnEnd').addEventListener('click', () => { running ? stopSession() : toast('No hay sesión activa.'); });
$('chipModel').addEventListener('click', openSettings);

// Conseguir la clave: abre AI Studio en otra pestaña.
const AI_STUDIO = 'https://aistudio.google.com/api-keys';
for (const id of ['btnGetKey', 'btnGetKey2']) {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', () => window.open(AI_STUDIO, '_blank', 'noopener'));
}

/**
 * Contexto del modelo en vivo: cuánto lleva consumido, de qué (audio/texto) y
 * cuánto queda. promptTokenCount es el tamaño acumulado de la conversación.
 */
function formatK(n) {
  // Número completo con separador de miles: «131.072» se entiende, «131 k» se
  // confunde con un millón.
  return new Intl.NumberFormat('es-ES').format(Math.round(n || 0));
}
function renderContexto() {
  const s = session?.stats || {};
  // El dato EXACTO llega con usageMetadata al cerrar cada turno. Mientras tanto
  // se estima con lo enviado: la API gasta ~25 tokens por segundo de audio, y
  // 1 s de PCM16 a 16 kHz son 32 000 bytes → 1 280 bytes por token.
  const bytesAudio = (s.inputAudioBytes || 0) + (s.outputAudioBytes || 0);
  const estimado = Math.round(bytesAudio / 1280);
  const exacto = s.contexto || 0;
  const usado = exacto || estimado;
  const esEstimado = !exacto && estimado > 0;
  const limite = s.limite || tokenLimit || 131072;
  const pct = Math.min(100, Math.round((usado / limite) * 100));
  const barra = $('ctxBarra');
  const texto = $('ctxTexto');
  if (barra) barra.style.width = pct + '%';
  if (barra) barra.style.background = pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--orange)' : 'var(--sage)';
  if (texto) {
    texto.textContent = running
      ? 'Contexto ' + formatK(usado) + ' / ' + formatK(limite) + ' (' + pct + '%)' + (esEstimado ? ' · estimado' : '')
      : 'Contexto: sin sesión';
  }
  const detalle = $('ctxDetalle');
  if (!detalle) return;
  detalle.innerHTML = '';
  const filas = running ? [
    ['Contexto acumulado' + (esEstimado ? ' (estimado)' : ' (exacto)'), formatK(usado) + ' de ' + formatK(limite) + ' tokens (' + pct + '%)'],
    ['De eso, audio', formatK(exacto ? (s.contextoAudio || 0) : estimado) + ' tokens'],
    ['De eso, texto', formatK(s.contextoTexto || 0) + ' tokens'],
    ['Voz generada', formatK(s.salidaTokens || 0) + ' tokens'],
    ['Razonamiento', formatK(s.pensados || 0) + ' tokens'],
    ['Duración de la sesión', Math.round((Date.now() - sessionStartedAt) / 1000) + ' s'],
    ['Audio que cabría aún', (usado < limite ? Math.max(0, Math.round(((limite - usado) / 25) / 60)) + ' min' : 'límite alcanzado') + '  ·  ~' + Math.round(limite / 25 / 60) + ' min en total'],
  ] : [['Contexto', 'sin sesión abierta']];
  for (const [k, v] of filas) {
    const n = document.createElement('div');
    n.className = 'tool-item';
    const b = document.createElement('b');
    b.textContent = k;
    const c = document.createElement('code');
    c.textContent = v;
    n.append(b, c);
    detalle.appendChild(n);
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of activeDoc().querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
    for (const view of activeDoc().querySelectorAll('.view')) view.classList.add('hidden');
    $('view-' + tab.dataset.view).classList.remove('hidden');
  });
}

$('btnMeaning').addEventListener('click', async () => {
  // Traduce lo último que entró por el micrófono (lo que se ha oído).
  const oido = [...transcript].reverse().find((m) => m.role === 'me');
  const texto = oido?.text || liveYou?.text || $('youLine').textContent.replace('Tú · ', '') || $('primary').textContent;
  if (!texto) { toast('Todavía no hay nada que traducir.'); return; }
  if (!settings.apiKey) { toast('Añade tu clave en Ajustes.'); return; }
  const mio = languageName(settings.meaningLang);
  setSecondary('Traduciendo…');
  try {
    setSecondary(await generateText({
      apiKey: settings.apiKey, model: settings.textModel,
      systemInstruction: 'Translate the text into ' + mio + '. If it is already in ' + mio +
        ', translate it into English instead. Return only the translation, nothing else.',
      prompt: texto,
    }));
  } catch (err) { setSecondary(''); toast('No se pudo traducir: ' + err.message, 5000); }
});

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('composerInput');
  const text = input.value.trim();
  if (!text) return;
  if (!session?.ready) { toast('Inicia la sesión con el micrófono para escribir.'); return; }
  session.sendTurn(text);
  pushMessage('me', text, 'escrito');
  input.value = '';
});

$('btnCopyAll').addEventListener('click', async () => {
  const text = transcript.map((m) => (m.role === 'me' ? 'Tú: ' : 'Onda: ') + m.text).join('\n');
  try { await navigator.clipboard.writeText(text); toast('Conversación copiada.', 2400); }
  catch { toast('El navegador bloqueó el portapapeles.'); }
});
$('btnClearTranscript').addEventListener('click', () => {
  transcript.length = 0;
  $('transcript').innerHTML = '';
  liveNodes.them = null; liveNodes.me = null;
  toast('Conversación limpiada.', 2000);
});

// ------------------------------------------------------------------ ajustes
function openSettings() { syncUI(); $('backdrop').hidden = false; $('sheetSettings').hidden = false; }
function closeSheets() { $('backdrop').hidden = true; for (const s of activeDoc().querySelectorAll('.sheet')) s.hidden = true; }
$('backdrop').addEventListener('click', closeSheets);
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closeSheets);

function syncUI() {
  if ($('rememberSessions')) $('rememberSessions').checked = settings.rememberSessions !== false;
  pintarMemoria();
  $('apiKey').value = settings.apiKey;
  $('modelSelect').value = settings.model;
  $('voiceSelect').value = settings.voice;
  $('meaningLang').value = settings.meaningLang;
  $('systemInstruction').value = settings.systemInstruction;
  $('silenceMs').value = settings.silenceMs;
  $('volume').value = settings.volume;
  $('chipModelLabel').textContent = settings.model;
  $('modelInfo').textContent = modelCapabilities(settings.model).audioOut
    ? 'Modelo en vivo con audio bidireccional.'
    : 'Este modelo no devuelve audio: elige otro.';
  const sinClave = !settings.apiKey;
  const enlace = document.getElementById('btnGetKey');
  if (enlace) enlace.hidden = !sinClave;
  $('keyState').textContent = settings.apiKey
    ? 'Clave guardada en este navegador (' + settings.apiKey.slice(0, 6) + '…).'
    : 'Se guarda solo en este navegador.';
}

function fillModelSelect(list) {
  const select = $('modelSelect');
  select.innerHTML = '';
  const vistos = new Set();
  const anadir = (items) => {
    for (const item of items) {
      if (vistos.has(item.id) || !modelCapabilities(item.id).audioOut || /translate/i.test(item.id)) continue;
      vistos.add(item.id);
      const o = document.createElement('option');
      o.value = item.id;
      o.textContent = item.label || item.id;
      select.appendChild(o);
    }
  };
  anadir([{ id: 'gemini-3.8-live', label: 'Gemini 3.8 Live' }, { id: 'gemini-3.8-live-extended-thinking', label: 'Gemini 3.8 Live Extended Thinking' }]);
  if (list) anadir(list.map((m) => ({ id: m.id, label: m.name })));
  if (!select.options.length) anadir([{ id: settings.model, label: settings.model }]);
  select.value = settings.model;
}

async function loadModels(quiet = false) {
  if (!settings.apiKey) { if (!quiet) toast('Escribe primero tu clave.'); return; }
  $('btnLoadModels').textContent = 'Cargando…';
  try {
    const catalog = await fetchModels(settings.apiKey);
    fillModelSelect(catalog.live);
    const elegido = catalog.live.find((m) => m.id === settings.model);
    if (elegido && elegido.inputTokenLimit) tokenLimit = elegido.inputTokenLimit;
    if (!quiet) toast(catalog.live.length + ' modelos en vivo disponibles.', 3000);
  } catch (err) {
    $('modelInfo').textContent = 'Error: ' + err.message;
    if (!quiet) toast('No se pudieron leer los modelos: ' + err.message, 6000);
  } finally {
    $('btnLoadModels').textContent = 'Cargar modelos de mi clave';
  }
}

$('btnSettings').addEventListener('click', openSettings);
$('btnLoadModels').addEventListener('click', () => loadModels());
$('btnForgetKey').addEventListener('click', () => { settings.apiKey = ''; saveSettings(); syncUI(); toast('Clave borrada.', 2600); });
$('apiKey').addEventListener('change', (e) => { settings.apiKey = e.target.value.trim(); saveSettings(); syncUI(); if (settings.apiKey) loadModels(true); });
$('modelSelect').addEventListener('change', (e) => { settings.model = e.target.value; saveSettings(); syncUI(); });
$('voiceSelect').addEventListener('change', (e) => { settings.voice = e.target.value; saveSettings(); });
$('meaningLang').addEventListener('change', (e) => {
  settings.meaningLang = e.target.value.trim() || 'es';
  if ((settings.systemInstruction || '').indexOf(INTERPRETER_MARK) === 0) {
    settings.systemInstruction = defaultInstructions(settings.meaningLang);
    $('systemInstruction').value = settings.systemInstruction;
  }
  saveSettings(); syncUI();
});
$('systemInstruction').addEventListener('change', (e) => {
  settings.systemInstruction = e.target.value;
  // Lo ha tocado el usuario: no se volverá a sustituir solo.
  settings.customInstruction = (e.target.value || '').indexOf(INTERPRETER_MARK) !== 0;
  settings.instructionVersion = INSTRUCTION_VERSION;
  saveSettings();
});
// Barra: tocarla recoge o despliega los mandos.
$('asa').addEventListener('click', (evento) => {
  if (evento.target.closest && evento.target.closest('#asaMic')) return;
  ponerMandos(!mandosVisibles());
});
$('asa').addEventListener('keydown', (evento) => {
  if (evento.key === 'Enter' || evento.key === ' ') { evento.preventDefault(); ponerMandos(!mandosVisibles()); }
});
// Micrófono desde la propia barra, sin desplegar nada.
$('asaMic').addEventListener('click', (evento) => { evento.stopPropagation(); $('btnMic').click(); });

// Al bajar por un texto, los mandos se apartan; al subir, vuelven.
for (const vista of activeDoc().querySelectorAll('.view')) {
  let ultimo = 0;
  vista.addEventListener('scroll', () => {
    if (vista.classList.contains('hidden')) return;
    const y = vista.scrollTop;
    if (Date.now() < bloqueoScroll) { ultimo = y; return; }
    if (y > ultimo + 12 && y > 40) ponerMandos(false);
    else if (y < ultimo - 12 && y > 4) ponerMandos(true);
    ultimo = y;
  }, { passive: true });
}

/**
 * Diagnostico de pantalla: los numeros REALES del movil del usuario. Sirve para
 * arreglar problemas de encaje sin adivinar (alto del viewport, zoom, areas
 * seguras, donde termina la barra de pestañas...).
 */
function diagnostico() {
  const vv = window.visualViewport;
  const caja = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { arriba: Math.round(r.top), abajo: Math.round(r.bottom), alto: Math.round(r.height) }; };
  const lineas = [
    'version: ' + APP_VERSION,
    'pantalla: ' + screen.width + 'x' + screen.height + ' (dpr ' + window.devicePixelRatio + ')',
    'ventana: ' + window.innerWidth + 'x' + window.innerHeight,
    'viewport visual: ' + (vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) + ' offsetTop ' + Math.round(vv.offsetTop) + ' escala ' + vv.scale.toFixed(2) : 'no disponible'),
    'html.clientHeight: ' + document.documentElement.clientHeight,
    'zoom aplicado: ' + (getComputedStyle(document.documentElement).zoom || '1'),
    'tactil: ' + matchMedia('(pointer: coarse)').matches + ' | modo escritorio: ' + (window.innerWidth >= 700 && matchMedia('(pointer: coarse)').matches),
    'safe-area: top ' + getComputedStyle(document.documentElement).getPropertyValue('--safe-t').trim() + ' / bottom ' + getComputedStyle(document.documentElement).getPropertyValue('--safe-b').trim(),
    'marco: ' + JSON.stringify(caja('#phone')),
    'barra pestanas: ' + JSON.stringify(caja('.tabbar')),
    'controles: ' + JSON.stringify(caja('.controls')),
    'se sale por abajo: ' + (caja('.tabbar') && vv ? (caja('.tabbar').abajo > Math.round(vv.height) + 1) : '?'),
    'navegador: ' + navigator.userAgent,
  ].join('\n');
  return lineas;
}

$('btnDiagnostico').addEventListener('click', async () => {
  const texto = diagnostico();
  const caja = $('diagSalida');
  caja.hidden = false;
  caja.textContent = texto;
  try { await navigator.clipboard.writeText(texto); toast('Diagnóstico copiado. Pégalo donde quieras.', 3200); }
  catch { toast('Diagnóstico en pantalla (el portapapeles está bloqueado).', 3200); }
});

$('btnOlvidarMemoria').addEventListener('click', olvidarMemoria);
$('rememberSessions').addEventListener('change', (e) => {
  settings.rememberSessions = e.target.checked;
  saveSettings();
  pintarMemoria();
  toast(e.target.checked ? 'Memoria activada.' : 'Memoria desactivada.', 2400);
});

$('btnForceUpdate').addEventListener('click', async () => {
  const boton = $('btnForceUpdate');
  boton.textContent = 'Actualizando…';
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const claves = await caches.keys();
      await Promise.all(claves.map((k) => caches.delete(k)));
    }
    toast('Caché borrada. Recargando la versión nueva…', 2600);
    setTimeout(() => { location.href = location.pathname + '?v=' + Date.now(); }, 900);
  } catch (err) {
    boton.textContent = 'Forzar actualización (limpia la caché)';
    toast('No se pudo limpiar: ' + err.message, 5000);
  }
});

$('btnResetInstruction').addEventListener('click', () => {
  settings.customInstruction = false;
  settings.instructionVersion = INSTRUCTION_VERSION;
  settings.systemInstruction = defaultInstructions(settings.meaningLang);
  $('systemInstruction').value = settings.systemInstruction;
  saveSettings();
  toast('Instrucciones de intérprete restauradas.', 2600);
});
$('silenceMs').addEventListener('change', (e) => { settings.silenceMs = Number(e.target.value) || 700; saveSettings(); });
$('volume').addEventListener('input', (e) => { settings.volume = Number(e.target.value); getEngine().setPlaybackVolume(settings.volume / 100); });
$('volume').addEventListener('change', saveSettings);

// ------------------------------------------------- ventana flotante y PWA
async function toggleFloat() {
  if (!('documentPictureInPicture' in window)) { toast('Tu navegador no soporta ventana flotante. Instala la app y fíjala encima.', 6000); return; }
  if (pipWindow) { pipWindow.close(); return; }
  const pip = await documentPictureInPicture.requestWindow({ width: 400, height: 780 });
  for (const sheet of document.styleSheets) {
    try {
      const style = pip.document.createElement('style');
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      pip.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = pip.document.createElement('link');
        link.rel = 'stylesheet'; link.href = sheet.href;
        pip.document.head.appendChild(link);
      }
    }
  }
  const meta = pip.document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1';
  pip.document.head.appendChild(meta);
  const estado = document.body.dataset.state || 'idle';
  const mic = document.body.dataset.mic || 'off';
  pip.document.body.append(...[...document.body.children].filter((n) => n.tagName !== 'SCRIPT'));
  pip.document.body.dataset.state = estado;
  pip.document.body.dataset.mic = mic;
  pip.document.body.classList.add('in-pip');
  pipWindow = pip;
  $('btnFloat').classList.add('on');
  pip.addEventListener('pagehide', () => {
    const hijos = [...pip.document.body.children].filter((n) => n.tagName !== 'SCRIPT');
    pipWindow = null;
    document.body.append(...hijos);
    document.body.dataset.state = estado;
    document.body.dataset.mic = mic;
    $('btnFloat').classList.remove('on');
    setState(estado);
  });
}
$('btnFloat').addEventListener('click', () => {
  toggleFloat().catch((err) => {
    if (pipWindow) { try { pipWindow.close(); } catch { /* ya cerrada */ } }
    toast('Ventana flotante: ' + err.message, 5000);
  });
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  addEventListener('load', async () => {
    try {
      const registro = await navigator.serviceWorker.register('sw.js?v=3.0.0');
      // Busca versión nueva en cada arranque.
      registro.update().catch(() => {});
      // Cuando el service worker nuevo toma el control, se recarga UNA vez:
      // así nadie se queda viendo una versión vieja en caché.
      const yaControlaba = Boolean(navigator.serviceWorker.controller);
      let recargando = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!yaControlaba || recargando) return;
        recargando = true;
        location.reload();
      });
    } catch { /* sin service worker */ }
  });
}


// ============================ INVESTIGACIÓN Y PANEL ============================
const RESEARCH_STORE = 'onda.research.v1';
const BOARD_STORE = 'onda.board.v1';
let research = readJSON(RESEARCH_STORE, []);
let board = readJSON(BOARD_STORE, []);

/** «Investiga»: qué buscó Onda, con qué consulta y de dónde lo sacó. */
function renderResearch() {
  const holder = $('researchList');
  holder.innerHTML = '';
  if (!research.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Aquí aparecerá lo que Onda investigue. Pídele algo actual: «búscame las noticias de hoy».';
    holder.appendChild(p);
    return;
  }
  for (const item of research.slice().reverse()) {
    const caja = document.createElement('div');
    caja.className = 'investigacion';
    const cuando = document.createElement('div');
    cuando.className = 'cuando';
    cuando.textContent = new Date(item.cuando).toLocaleString('es-ES');
    const consulta = document.createElement('div');
    consulta.className = 'consulta';
    consulta.textContent = '🔎 ' + item.consulta;
    const resumen = document.createElement('div');
    resumen.className = 'resumen';
    resumen.textContent = item.resumen || '(sin resumen)';
    caja.append(cuando, consulta, resumen);

    const mas = document.createElement('button');
    mas.className = 'mas';
    mas.textContent = 'Ver todo ▾';
    mas.addEventListener('click', () => {
      caja.classList.toggle('abierta');
      mas.textContent = caja.classList.contains('abierta') ? 'Ver menos ▴' : 'Ver todo ▾';
    });
    caja.appendChild(mas);

    if (item.consultas && item.consultas.length) {
      const q = document.createElement('div');
      q.className = 'consultas';
      q.textContent = 'Buscó: ' + item.consultas.join(' · ');
      caja.appendChild(q);
    }
    if (item.fuentes && item.fuentes.length) {
      const fuentes = document.createElement('div');
      fuentes.className = 'fuentes';
      for (const url of item.fuentes) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        let etiqueta = url;
        try { etiqueta = new URL(url).hostname.replace(/^www\./, '') + ' · ' + url.slice(0, 90); } catch { /* url rara */ }
        a.textContent = '🔗 ' + etiqueta;
        fuentes.appendChild(a);
      }
      caja.appendChild(fuentes);
    }
    holder.appendChild(caja);
  }
}

function addResearch(item) {
  research.push(item);
  if (research.length > 100) research.shift();
  writeJSON(RESEARCH_STORE, research);
  renderResearch();
}

$('btnCopyResearch').addEventListener('click', async () => {
  const texto = research.map((r) => '[' + new Date(r.cuando).toLocaleString('es-ES') + '] ' + r.consulta + '\n' + (r.resumen || '') + '\n' + (r.fuentes || []).join('\n')).join('\n\n');
  try { await navigator.clipboard.writeText(texto || 'sin investigaciones'); toast('Investigación copiada.', 2400); }
  catch { toast('El navegador bloqueó el portapapeles.'); }
});
$('btnClearResearch').addEventListener('click', () => {
  research = [];
  writeJSON(RESEARCH_STORE, research);
  renderResearch();
  toast('Investigación limpiada.', 2200);
});

/** «Panel»: resúmenes, notas y diagramas de lo hablado. */
function escapar(html) {
  return String(html).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const CERCA = String.fromCharCode(96).repeat(3);
function markdownBasico(texto) {
  const partes = String(texto).split(CERCA);
  return partes.map((trozo, i) => {
    if (i % 2 === 1) {
      const salto = trozo.indexOf('\n');
      const lenguaje = salto === -1 ? '' : trozo.slice(0, salto).trim().toLowerCase();
      const codigo = salto === -1 ? trozo : trozo.slice(salto + 1);
      return '<pre>' + escapar(codigo) + '</pre>';
    }
    return escapar(trozo)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
      .replace(/\n/g, '<br>');
  }).join('');
}

function renderBoard() {
  const holder = $('boardList');
  holder.innerHTML = '';
  if (!board.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Sin tarjetas todavía. Usa «Resumir lo hablado» o pega un resumen abajo.';
    holder.appendChild(p);
    return;
  }
  for (const tarjeta of board.slice().reverse()) {
    const caja = document.createElement('div');
    caja.className = 'tarjeta';
    const titulo = document.createElement('h3');
    titulo.textContent = tarjeta.titulo;
    const cuerpo = document.createElement('div');
    cuerpo.className = 'cuerpo';
    cuerpo.innerHTML = markdownBasico(tarjeta.texto);
    const pie = document.createElement('div');
    pie.className = 'pie';
    const fecha = document.createElement('span');
    fecha.className = 'meta';
    fecha.textContent = new Date(tarjeta.cuando).toLocaleString('es-ES');
    const acciones = document.createElement('div');
    const copiar = document.createElement('button');
    copiar.textContent = 'Copiar';
    copiar.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(tarjeta.texto); toast('Tarjeta copiada.', 2000); }
      catch { toast('El navegador bloqueó el portapapeles.'); }
    });
    const borrar = document.createElement('button');
    borrar.textContent = 'Borrar';
    borrar.addEventListener('click', () => {
      board = board.filter((t) => t.id !== tarjeta.id);
      writeJSON(BOARD_STORE, board);
      renderBoard();
    });
    acciones.append(copiar, borrar);
    pie.append(fecha, acciones);
    caja.append(titulo, cuerpo, pie);
    holder.appendChild(caja);
  }
}

function addCard(titulo, texto) {
  board.push({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), titulo, texto, cuando: Date.now() });
  if (board.length > 60) board.shift();
  writeJSON(BOARD_STORE, board);
  renderBoard();
}

function transcripcionTexto(limite = 4000) {
  return transcript.slice(-limite).map((m) => (m.role === 'me' ? 'Tú: ' : 'Onda: ') + m.text).join('\n');
}

$('boardComposer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('boardInput');
  const texto = input.value.trim();
  if (!texto) return;
  addCard('Nota', texto);
  input.value = '';
  toast('Añadido al panel.', 2000);
});

$('btnResumen').addEventListener('click', async () => {
  const texto = transcripcionTexto();
  if (!texto) { toast('Todavía no hay conversación que resumir.'); return; }
  if (!settings.apiKey) { toast('Añade tu clave en Ajustes.'); return; }
  const boton = $('btnResumen');
  boton.textContent = 'Resumiendo…';
  try {
    toast('Resumiendo ' + transcript.length + ' mensajes…', 3000);
    const resumen = await generateText({
      apiKey: settings.apiKey, model: settings.textModel,
      systemInstruction: 'Resume en el idioma del usuario, con puntos claros y fechas si las hay. Sin relleno.',
      prompt: 'Resume esta conversación:\n\n' + texto,
    });
    addCard('Resumen de lo hablado · ' + settings.textModel, resumen);
    toast('Resumen añadido al panel.', 2600);
  } catch (err) { toast('No se pudo resumir: ' + err.message, 5000); }
  finally { boton.textContent = 'Resumir lo hablado'; }
});

$('btnClearBoard').addEventListener('click', () => {
  board = [];
  writeJSON(BOARD_STORE, board);
  renderBoard();
  toast('Panel limpiado.', 2200);
});

// ------------------------------------------------------------------ arranque
function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('modelo')) settings.model = params.get('modelo');
  $('voiceSelect').innerHTML = VOICES.map((v) => '<option value="' + v + '">' + v + '</option>').join('');
  fillModelSelect(null);
  syncUI();
  setState('idle');
  setMicState('off');
  $('about').textContent = 'Onda Live v' + APP_VERSION + ' · ' + (isAndroid ? 'Android' : 'Escritorio') + (isStandalone ? ' · instalada' : '') + ' · clave ' + (settings.apiKey ? 'configurada' : 'pendiente');
  if (!window.isSecureContext) toast('Sin HTTPS el micrófono está bloqueado. Abre la app con https://', 8000);
  renderResearch();
  renderBoard();
  pintarMemoria();
  renderContexto();
  if (settings.apiKey) loadModels(true);
}
// Refresco del contexto mientras hay sesión (el dato llega al cerrar cada turno).
setInterval(() => { if (running) renderContexto(); }, 1000);

montarAdn();   // la hélice del orbe
ajustarZoom();  // por si el móvil está en modo escritorio
if (promptActualizado) setTimeout(() => toast('Instrucciones actualizadas al prompt nuevo (modo traductor y varios idiomas).', 6000), 1200);
addEventListener('resize', ajustarZoom);

try { boot(); } catch (err) { console.error('[onda] fallo al arrancar:', err); setStatus('Error al arrancar: ' + err.message); }

// Asa para las pruebas automáticas y el diagnóstico desde la consola.
window.Onda = {
  version: APP_VERSION,
  get settings() { return settings; },
  get session() { return session; },
  get engine() { return getEngine(); },
  get running() { return running; },
  get transcript() { return transcript; },
  start: startSession,
  stop: stopSession,
  loadModels,
  declarations: () => buildToolDeclarations(settings),
  capabilities: modelCapabilities,
  instructions: defaultInstructions,
};
