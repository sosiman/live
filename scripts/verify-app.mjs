#!/usr/bin/env node
/**
 * Onda Live — verificación en un navegador real contra la API de Google.
 *
 *   node scripts/verify-app.mjs --key <API_KEY>
 *
 * Comprueba lo que pide la documentación oficial del Live API:
 *   · WebSocket directo del navegador a Google (BYOK), sin backend.
 *   · Detección de voz del servidor y posibilidad de interrumpir.
 *   · Fragmentos de audio de 20-40 ms.
 *   · Descarte del búfer al recibir una interrupción.
 *   · Compresión de contexto y reanudación de sesión configuradas.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1]; };
const KEY = arg('key') ?? process.env.GOOGLE_API_KEY ?? '';
const URL_APP = arg('url', 'https://localhost:8443');
const PORT = Number(arg('port', 9377));
const PROFILE = path.join(os.tmpdir(), 'onda-verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!KEY) { console.error('Falta --key o GOOGLE_API_KEY'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log((ok ? '  OK  ' : ' FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 160) : ''));
  return Boolean(ok);
};

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.console = []; }
  static async connect(port) {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        const page = list.find((t) => t.type === 'page');
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
          const cdp = new Cdp(ws);
          ws.onmessage = (e) => cdp.onMessage(JSON.parse(e.data));
          return cdp;
        }
      } catch { /* esperando */ }
      await sleep(250);
    }
    throw new Error('No se pudo conectar a Chrome.');
  }
  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') this.console.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.console.push('EXCEPTION: ' + ((d && d.exception && d.exception.description) || (d && d.text) || ''));
    }
    this.events.push(msg);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 60000);
    });
  }
  async waitEvent(method, timeout = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = this.events.find((e) => e.method === method);
      if (found) return found;
      await sleep(120);
    }
    return null;
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  async goto(url) {
    this.events.length = 0;
    await this.send('Page.navigate', { url });
    await this.waitEvent('Page.loadEventFired');
    await sleep(700);
  }
}

const E_READY = '(async function () { for (var i = 0; i < 60; i++) { if (window.Onda.session && window.Onda.session.ready) return true; await new Promise(function (r) { setTimeout(r, 500); }); } return false; })()';

fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn('google-chrome', [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', '--ignore-certificate-errors',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--enable-features=DocumentPictureInPictureAPI',
  '--window-size=430,900', 'about:blank',
], { stdio: 'ignore' });

let ok = true;
let cdp;
try {
  cdp = await Cdp.connect(PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('\n1) Arranque y PWA');
  await cdp.goto(URL_APP);
  ok = check('La app arranca', await cdp.evaluate('Boolean(window.Onda)')) && ok;
  ok = check('Título correcto', (await cdp.evaluate('document.title')) === 'Onda Live') && ok;
  ok = check('Service worker registrado', (await cdp.evaluate('navigator.serviceWorker.getRegistrations().then(function (r) { return r.length; })')) >= 1) && ok;

  console.log('\n2) Clave y catálogo de modelos (BYOK)');
  await cdp.evaluate('localStorage.setItem("onda.settings.v2", ' + JSON.stringify(JSON.stringify({ apiKey: KEY, model: 'gemini-3.8-live', voice: 'Puck', meaningLang: 'es', silenceMs: 700 })) + ')');
  await cdp.goto(URL_APP);
  const modelos = await cdp.evaluate('(async function () { for (var i = 0; i < 60; i++) { if (document.getElementById("modelSelect").options.length > 2) break; await new Promise(function (r) { setTimeout(r, 500); }); } return Array.from(document.getElementById("modelSelect").options).map(function (o) { return o.value; }); })()');
  ok = check('Se leen los modelos en vivo de la clave', modelos.length >= 3, modelos.slice(0, 4).join(', ')) && ok;
  ok = check('gemini-3.8-live disponible', modelos.includes('gemini-3.8-live')) && ok;

  const idiomas = await cdp.evaluate('(function () { var s = document.getElementById("meaningLang"); return { tipo: s.tagName, opciones: Array.from(s.options).map(function (o) { return o.value; }) }; })()');
  ok = check('El idioma es un selector con varias opciones', idiomas.tipo === 'SELECT' && idiomas.opciones.length >= 5, idiomas.opciones.slice(0, 6).join(', ')) && ok;
  ok = check('Incluye alemán, inglés, ucraniano y chino', ['de', 'en', 'uk', 'zh'].every((c) => idiomas.opciones.includes(c)), idiomas.opciones.join(',')) && ok;

  console.log('\n3) Sesión y configuración recomendada por la documentación');
  await cdp.evaluate('window.Onda.start()');
  const listo = await cdp.evaluate(E_READY);
  ok = check('WebSocket con Google abierto (setupComplete)', listo) && ok;
  const setup = await cdp.evaluate('JSON.stringify(window.Onda.session.buildSetup())');
  ok = check('Detección de voz del servidor activada', /"automaticActivityDetection":\{"disabled":false/.test(setup)) && ok;
  ok = check('Se puede interrumpir hablando (START_OF_ACTIVITY_INTERRUPTS)', /"activityHandling":"START_OF_ACTIVITY_INTERRUPTS"/.test(setup)) && ok;
  ok = check('Compresión de contexto para sesiones largas', /contextWindowCompression/.test(setup)) && ok;
  ok = check('Reanudación de sesión', /sessionResumption/.test(setup)) && ok;
  ok = check('No se envía nada de silenciar el micrófono', !/halfDuplex|duck/i.test(setup)) && ok;

  console.log('\n4) Audio: fragmentos de 20-40 ms y micrófono abierto');
  await sleep(3000);
  const audio = await cdp.evaluate('({ captura: window.Onda.engine.captureRunning, bytes: window.Onda.session.stats.inputAudioBytes })');
  ok = check('Captura de audio activa', audio.captura, JSON.stringify(audio)) && ok;
  const tasa = audio.bytes / 3;
  ok = check('Ritmo de envío correcto (16 kHz PCM16 ≈ 32 kB/s)', tasa > 24000 && tasa < 40000, Math.round(tasa) + ' B/s') && ok;
  const elementoAudio = await cdp.evaluate('(function () { var e = window.Onda.engine; return { hayElemento: Boolean(e.audioEl), tieneFlujo: Boolean(e.streamDest && e.audioEl && e.audioEl.srcObject), pausado: e.audioEl ? e.audioEl.paused : null }; })()');
  ok = check('La voz se reproduce por <audio> (referencia de cancelación de eco)', elementoAudio.hayElemento && elementoAudio.tieneFlujo, JSON.stringify(elementoAudio)) && ok;
  const microfonia = await cdp.evaluate('(function () { var t = window.Onda.engine.source && window.Onda.engine.source.stream.getAudioTracks()[0]; if (!t) return null; var s = t.getSettings ? t.getSettings() : {}; return { eco: s.echoCancellation, ruido: s.noiseSuppression, ganancia: s.autoGainControl }; })()');
  ok = check('Cancelación de eco activada en el micrófono', microfonia && microfonia.eco === true, JSON.stringify(microfonia)) && ok;

  console.log('\n5) Conversación');
  await cdp.evaluate('window.Onda.session.sendTurn("Di exactamente: prueba superada.")');
  const hablo = await cdp.evaluate('(async function () { for (var i = 0; i < 60; i++) { if (window.Onda.session.stats.outputAudioBytes > 4800) return true; await new Promise(function (r) { setTimeout(r, 500); }); } return false; })()');
  ok = check('Responde con voz', hablo, Math.round((await cdp.evaluate('window.Onda.session.stats.outputAudioBytes')) / 48000 * 10) / 10 + ' s') && ok;
  await sleep(2500);
  const textos = await cdp.evaluate('window.Onda.transcript.filter(function (m) { return m.role === "them"; }).map(function (m) { return m.text; })');
  ok = check('Transcripción de la respuesta', textos.length > 0, JSON.stringify(textos).slice(0, 120)) && ok;

  console.log('\n6) Interrupción (lo que pide la guía de buenas prácticas)');
  const interrupcion = await cdp.evaluate('(async function () { var e = window.Onda.engine; var bytes = new Uint8Array(96000); var s = ""; for (var i = 0; i < bytes.length; i += 4096) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096)); e.playBase64(btoa(s)); await new Promise(function (r) { setTimeout(r, 300); }); var antes = (e.playerState || {}).queuedMs || 0; window.Onda.session.dispatchEvent(new CustomEvent("interrupted")); await new Promise(function (r) { setTimeout(r, 300); }); return { antes: antes, despues: (e.playerState || {}).queuedMs || 0 }; })()');
  ok = check('Al interrumpir se descarta el búfer de voz', interrupcion.antes > 100 && interrupcion.despues === 0, JSON.stringify(interrupcion)) && ok;

  console.log('\n4c) Barra de estado y mandos que se recogen');
  const barra = await cdp.evaluate('(function () { var a = document.getElementById("asa"); if (!a) return null; var r = a.getBoundingClientRect(); return { alto: Math.round(r.height), ancho: Math.round(r.width), texto: document.getElementById("asaTexto").textContent, flecha: Boolean(a.querySelector(".asa-flecha")), micro: Boolean(a.querySelector("#asaMic")) }; })()');
  ok = check('Existe la barra de estado con su texto y su micrófono', barra && barra.alto >= 30 && barra.micro && barra.texto.length > 3, JSON.stringify(barra)) && ok;
  const estadoAntes = await cdp.evaluate('document.body.dataset.mandos || "abiertos"');
  await cdp.evaluate('document.getElementById("asa").click(); "ok"');
  await new Promise((r) => setTimeout(r, 800));
  const recogido = await cdp.evaluate('(function () { return { mandos: document.body.dataset.mandos || "abiertos", alto: Math.round(document.getElementById("mando").getBoundingClientRect().height) }; })()');
  ok = check('Tocando la barra los mandos cambian de estado', recogido.mandos !== estadoAntes, estadoAntes + ' -> ' + recogido.mandos) && ok;
  ok = check('Recogidos no ocupan sitio (alto 0)', recogido.mandos === 'ocultos' ? recogido.alto === 0 : recogido.alto > 60, 'alto ' + recogido.alto + ' con mandos ' + recogido.mandos) && ok;
  await cdp.evaluate('document.getElementById("asa").click(); "ok"');
  await new Promise((r) => setTimeout(r, 800));
  const desplegado = await cdp.evaluate('document.body.dataset.mandos || "abiertos"');
  ok = check('Y al tocarla otra vez vuelven', desplegado === estadoAntes, desplegado) && ok;
  const conScroll = await cdp.evaluate('(function () { var v = document.querySelector(".view:not(.hidden)"); var d = document.createElement("div"); d.style.flex = "none"; d.style.height = "2000px"; v.appendChild(d); v.scrollTop = 0; v.dispatchEvent(new Event("scroll")); return v.scrollHeight > v.clientHeight; })()');
  if (conScroll) {
    await cdp.evaluate('(function () { var v = document.querySelector(".view:not(.hidden)"); v.scrollTop = 700; v.dispatchEvent(new Event("scroll")); return "ok"; })()');
    await new Promise((r) => setTimeout(r, 800));
    const trasBajar = await cdp.evaluate('document.body.dataset.mandos');
    await cdp.evaluate('(function () { var v = document.querySelector(".view:not(.hidden)"); v.scrollTop = 500; v.dispatchEvent(new Event("scroll")); return "ok"; })()');
    await new Promise((r) => setTimeout(r, 800));
    const trasSubir = await cdp.evaluate('document.body.dataset.mandos');
    ok = check('Al bajar leyendo se esconden y al subir vuelven', trasBajar === 'ocultos' && trasSubir === 'abiertos', trasBajar + ' -> ' + trasSubir) && ok;
    await cdp.evaluate('(function () { var d = document.getElementById("relleno"); if (d) d.remove(); return "ok"; })()');
  }

  console.log('\n5b) Contexto del modelo en vivo');
  const ctx1 = await cdp.evaluate('(async function () { for (var i = 0; i < 20; i++) { var s = window.Onda.session.stats; if (s.contexto) return { contexto: s.contexto, limite: s.limite, audio: s.contextoAudio, texto: s.contextoTexto, barra: document.getElementById("ctxTexto").textContent }; await new Promise(function (r) { setTimeout(r, 500); }); } return null; })()');
  ok = check('La app muestra el contexto consumido en vivo', ctx1 && ctx1.contexto > 0 && /Contexto/.test(ctx1.barra), JSON.stringify(ctx1)) && ok;
  ok = check('Sabe el límite real del modelo (128 k, no 1-2 M)', ctx1 && ctx1.limite >= 100000 && ctx1.limite <= 200000, ctx1 ? String(ctx1.limite) : '') && ok;
  ok = check('Desglosa audio y texto del contexto', ctx1 && (ctx1.audio > 0 || ctx1.texto > 0), ctx1 ? 'audio ' + ctx1.audio + ' · texto ' + ctx1.texto : '') && ok;
  const detalleCtx = await cdp.evaluate('(function () { var d = document.getElementById("ctxDetalle").textContent; return d.slice(0, 120); })()');
  ok = check('El Panel detalla el contexto', /Contexto acumulado|audio/i.test(detalleCtx), detalleCtx) && ok;

  console.log('\n6b) Búsqueda web real (el Live API no la ejecuta por sí solo)');
  const busqueda = await cdp.evaluate('(async function () { window.Onda.lastTool = null; window.Onda.session.sendTurn("Busca en la web qué noticias hay hoy y dime una con su fecha. Usa buscar_en_web."); for (var i = 0; i < 90; i++) { if (window.Onda.lastTool) return window.Onda.lastTool; await new Promise(function (r) { setTimeout(r, 500); }); } return null; })()');
  ok = check('El modelo llama a buscar_en_web', busqueda && busqueda.name === 'buscar_en_web', busqueda ? JSON.stringify(busqueda.args).slice(0, 80) : 'no la llamó') && ok;
  const datos = busqueda && busqueda.result ? JSON.stringify(busqueda.result) : '';
  ok = check('La búsqueda devuelve datos actuales con fuentes', /2026/.test(datos) || (busqueda && busqueda.result && busqueda.result.fuentes && busqueda.result.fuentes.length > 0), datos.slice(0, 160)) && ok;

  console.log('\n6b2) Memoria entre sesiones (el Live API no la tiene: la pone la app)');
  const dato = 'la clave del armario es 9987';
  await cdp.evaluate('localStorage.removeItem("onda.memoria.v1"); window.Onda.transcript.length = 0; "ok"');
  await cdp.evaluate('(function () { var i = document.getElementById("composerInput"); i.value = ' + JSON.stringify('Recuerda este dato: ' + dato + '.') + '; document.getElementById("composer").dispatchEvent(new Event("submit", { cancelable: true })); return "ok"; })()');
  await new Promise((r) => setTimeout(r, 9000));
  await cdp.evaluate('window.Onda.stop(); "ok"');
  await new Promise((r) => setTimeout(r, 2500));
  const guardada = await cdp.evaluate('(function () { var m = JSON.parse(localStorage.getItem("onda.memoria.v1") || "{}"); return { mensajes: (m.crudo || []).length, sesiones: m.sesiones }; })()');
  ok = check('Lo hablado se guarda al parar la sesión', guardada.mensajes >= 1, JSON.stringify(guardada)) && ok;
  await cdp.evaluate('window.Onda.transcript.length = 0; window.Onda.start(); "ok"');
  for (let i = 0; i < 40; i++) { if (await cdp.evaluate('window.Onda.session && window.Onda.session.ready')) break; await new Promise((r) => setTimeout(r, 500)); }
  await new Promise((r) => setTimeout(r, 1200));
  const setupMem = await cdp.evaluate('JSON.stringify(window.Onda.session.buildSetup())');
  ok = check('Al abrir de nuevo, el contexto lleva lo anterior', /CONVERSACIONES ANTERIORES/.test(setupMem) && setupMem.includes('9987'), setupMem.includes('9987') ? 'el dato viaja en el contexto' : 'el dato NO viaja') && ok;
  await cdp.evaluate('window.Onda.stop(); setTimeout(function () { window.Onda.start(); }, 1500); "ok"');
  for (let i = 0; i < 40; i++) { if (await cdp.evaluate('window.Onda.session && window.Onda.session.ready')) break; await new Promise((r) => setTimeout(r, 500)); }
  ok = check('La sesión se recupera tras el ciclo de memoria', await cdp.evaluate('Boolean(window.Onda.session && window.Onda.session.ready)'), 'sesión lista') && ok;

  console.log('\n6c) Apartado «Investiga»: consulta y enlaces a la vista');
  const investiga = await cdp.evaluate('(function () { var n = document.querySelectorAll("#researchList .investigacion").length; var t = document.getElementById("researchList").textContent; var enlaces = document.querySelectorAll("#researchList .fuentes a").length; var href = enlaces ? document.querySelector("#researchList .fuentes a").href : ""; return { tarjetas: n, enlaces: enlaces, href: href, texto: t.slice(0, 120) }; })()');
  ok = check('La búsqueda aparece en «Investiga»', investiga.tarjetas >= 1, investiga.texto) && ok;
  ok = check('Se ven los enlaces de las fuentes', investiga.enlaces >= 1 && /^https?:/.test(investiga.href), investiga.href) && ok;

  console.log('\n6d) Apartado «Panel»: resúmenes y diagramas');
  const panel = await cdp.evaluate('(async function () { document.getElementById("btnResumen").click(); for (var i = 0; i < 60; i++) { if (document.querySelectorAll("#boardList .tarjeta").length >= 1) break; await new Promise(function (r) { setTimeout(r, 500); }); } return { tarjetas: document.querySelectorAll("#boardList .tarjeta").length, texto: document.getElementById("boardList").textContent.slice(0, 100) }; })()');
  ok = check('«Resumir lo hablado» añade una tarjeta', panel.tarjetas >= 1, panel.texto) && ok;
  const nota = await cdp.evaluate('(async function () { var i = document.getElementById("boardInput"); i.value = "**Prueba** de nota pegada"; document.getElementById("boardComposer").dispatchEvent(new Event("submit", { cancelable: true })); await new Promise(function (r) { setTimeout(r, 400); }); return { tarjetas: document.querySelectorAll("#boardList .tarjeta").length, negrita: document.querySelectorAll("#boardList .cuerpo strong").length }; })()');
  ok = check('Se puede pegar una nota y se formatea', nota.tarjetas >= 2 && nota.negrita >= 1, JSON.stringify(nota)) && ok;

  console.log('\n7) Ventana flotante');
  await cdp.goto(URL_APP);
  const pip = await cdp.evaluate('(async function () { if (!("documentPictureInPicture" in window)) return { soportado: false }; document.getElementById("btnFloat").click(); await new Promise(function (r) { setTimeout(r, 1500); }); var w = documentPictureInPicture.window; return { soportado: true, abierta: Boolean(w), nodos: w ? w.document.body.children.length : 0 }; })()');
  ok = check('Abre la ventana flotante', pip.soportado && pip.abierta) && ok;
  const vuelta = await cdp.evaluate('(async function () { var w = documentPictureInPicture.window; if (!w) return false; w.document.getElementById("btnFloat").click(); await new Promise(function (r) { setTimeout(r, 1200); }); return !documentPictureInPicture.window && Boolean(document.getElementById("btnMic")); })()');
  ok = check('Al cerrarla la app vuelve entera', vuelta === true) && ok;

  const errores = cdp.console.filter((l) => /EXCEPTION|Uncaught/.test(l));
  ok = check('Sin excepciones en consola', errores.length === 0, errores.slice(0, 2).join(' | ')) && ok;
} catch (err) {
  ok = false;
  check('Ejecución completa', false, err.message);
} finally {
  try { chrome.kill('SIGKILL'); } catch { /* cerrado */ }
}

const resumen = { ok, checks: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.name) };
console.log('\n' + JSON.stringify(resumen, null, 2));
process.exit(ok ? 0 : 1);
