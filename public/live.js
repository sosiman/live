/**
 * Onda Live — cliente del Gemini Live API (BYOK, 100 % navegador).
 *
 * Endpoint oficial (documentación: ai.google.dev/api/live):
 *   wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
 *
 * Configuración tomada de la GUÍA DE BUENAS PRÁCTICAS oficial:
 *  · Detección de voz del servidor (AAD) activada: es lo que permite
 *    interrumpir al modelo en cualquier momento, sin montar nada en el cliente.
 *  · «Interruption Handling»: al llegar serverContent.interrupted se descarta el
 *    búfer local de inmediato (lo hace app.js con flushPlayback).
 *  · Compresión de contexto: los tokens de audio crecen ~25/s; sin esto la
 *    sesión se corta en 15 minutos.
 *  · Reanudación de sesión: se guarda el handle y se reabre sin perder contexto.
 */

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const REST_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const VOICES = ['Puck', 'Kore', 'Aoede', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Zephyr', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel'];

export function modelCapabilities(id = '') {
  const translate = /translate/.test(id);
  const extended = /extended-thinking/.test(id);
  return {
    canUseTools: !translate,
    needsThinkingLevel: extended,
    audioOut: !/transcribe|robotics/.test(id),
    translate,
    extended,
  };
}

async function rest(path, apiKey, init = {}) {
  const response = await fetch(REST_BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, ...(init.headers || {}) },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no JSON */ }
  if (!response.ok) {
    const error = new Error(json?.error?.message || text || ('HTTP ' + response.status));
    error.status = response.status;
    throw error;
  }
  return json;
}

export async function fetchModels(apiKey) {
  if (!apiKey) throw new Error('Falta la clave de API.');
  const data = await rest('/models?pageSize=1000', apiKey, { method: 'GET' });
  const models = (data.models || []).map((m) => {
    const id = (m.name || '').replace('models/', '');
    const methods = m.supportedGenerationMethods || [];
    return {
      id, name: m.displayName || id, methods,
      live: methods.includes('bidiGenerateContent'),
      inputTokenLimit: m.inputTokenLimit || null,
      outputTokenLimit: m.outputTokenLimit || null,
    };
  });
  return { all: models, live: models.filter((m) => m.live) };
}

/**
 * Búsqueda web REAL. Medido: el Live API acepta el tool googleSearch pero no
 * devuelve groundingMetadata (contesta de memoria, con datos viejos). Por REST
 * con generateContent + googleSearch sí grounded y devuelve consultas y
 * fuentes. El resultado se le pasa al modelo en vivo como respuesta de tool.
 */
export async function searchWeb({ apiKey, model = 'gemini-3.8-flash', query, sitio, maxResultados = 5 }) {
  if (!apiKey) throw new Error('Falta la clave de API.');
  // `sitio` limita la busqueda a una web concreta (site:). Sirve para dirigir la
  // investigacion a las fuentes que usa la comunidad (wowhead, icy-veins, murlok...).
  const consulta = sitio ? query + ' site:' + sitio : query;
  const body = {
    contents: [{ role: 'user', parts: [{ text: consulta }] }],
    tools: [{ googleSearch: {} }],
    systemInstruction: { parts: [{ text:
      'Responde con datos concretos y verificables: nombres exactos, cifras, zonas, coordenadas, ' +
      'porcentajes y fechas si los hay. Se breve (4-6 lineas), sin Markdown y sin listas largas.' }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };
  const json = await rest('/models/' + model + ':generateContent', apiKey, { method: 'POST', body: JSON.stringify(body) });
  const cand = json?.candidates?.[0];
  const resumen = (cand?.content?.parts || []).map((p) => p.text || '').join(' ').trim();
  const meta = cand?.groundingMetadata || {};
  const fuentes = (meta.groundingChunks || []).map((c) => c?.web?.uri).filter(Boolean).slice(0, maxResultados);
  return { resumen: resumen || '(sin resultados)', consultas: meta.webSearchQueries || [], fuentes, fecha: new Date().toISOString().slice(0, 10) };
}

export async function generateText({ apiKey, model = 'gemini-flash-lite-latest', prompt, systemInstruction, temperature = 0.2 }) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens: 2048 } };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  const json = await rest('/models/' + model + ':generateContent', apiKey, { method: 'POST', body: JSON.stringify(body) });
  return (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

export class LiveSession extends EventTarget {
  constructor(opts) {
    super();
    this.opts = opts;
    this.ws = null;
    this.ready = false;
    this.closedByUs = false;
    this.resumeHandle = null;
    this.stats = { inputAudioBytes: 0, outputAudioBytes: 0, toolCalls: 0, wsEnviados: 0, wsRecibidos: 0 };
  }

  /** Mensaje de configuración: solo lo que la documentación recomienda. */
  buildSetup() {
    const { model, config = {} } = this.opts;
    const caps = modelCapabilities(model);
    const setup = {
      model: 'models/' + model,
      generationConfig: { responseModalities: ['AUDIO'] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Detección de voz del servidor: turnos naturales e interrupción libre.
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          prefixPaddingMs: 100,
          silenceDurationMs: Number(config.silenceMs) || 700,
        },
        // El usuario puede interrumpir hablando en cualquier momento.
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
      },
      // Los tokens de audio crecen ~25/s: sin compresión la sesión muere a los 15 min.
      contextWindowCompression: { slidingWindow: {} },
    };
    if (config.voice) setup.generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } };
    if (caps.needsThinkingLevel) setup.generationConfig.thinkingConfig = { thinkingLevel: config.thinkingLevel || 'MEDIUM' };
    if (config.systemInstruction) setup.systemInstruction = { parts: [{ text: config.systemInstruction }] };
    if (config.tools?.length) setup.tools = config.tools;
    if (config.resumption !== false) {
      setup.sessionResumption = this.resumeHandle ? { handle: this.resumeHandle } : {};
    }
    return setup;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.opts.apiKey) return reject(new Error('Falta la clave de API.'));
      let ws;
      try { ws = new WebSocket(WS_BASE + '?key=' + encodeURIComponent(this.opts.apiKey)); } catch (err) { return reject(err); }
      this.ws = ws;
      this.closedByUs = false;
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const timer = setTimeout(() => finish(reject, new Error('El servidor no confirmó la sesión (20 s).')), 20000);
      ws.onopen = () => this.#send({ setup: this.buildSetup() });
      ws.onmessage = async (event) => {
        let raw = event.data;
        if (raw instanceof Blob) raw = await raw.text();
        else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        this.stats.wsRecibidos += 1;
        if (msg.setupComplete) {
          this.ready = true;
          this.dispatchEvent(new CustomEvent('ready'));
          finish(resolve, this);
          return;
        }
        this.#handle(msg);
      };
      ws.onerror = () => {
        const err = new Error('Error de conexión con el Live API. Revisa la clave y la red.');
        this.dispatchEvent(new CustomEvent('error', { detail: err }));
        finish(reject, err);
      };
      ws.onclose = (event) => {
        this.ready = false;
        if (this.closedByUs) return;
        const reason = event.reason || ('código ' + event.code);
        finish(reject, new Error(explainLiveError(reason)));
        this.dispatchEvent(new CustomEvent('closed', { detail: { code: event.code, reason } }));
      };
    });
  }

  #handle(msg) {
    if (msg.error) { this.dispatchEvent(new CustomEvent('apierror', { detail: msg.error })); return; }
    if (msg.sessionResumptionUpdate) {
      if (msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
      return;
    }
    if (msg.goAway) this.dispatchEvent(new CustomEvent('goaway', { detail: msg.goAway }));
    if (msg.toolCall) {
      this.stats.toolCalls += (msg.toolCall.functionCalls || []).length;
      this.dispatchEvent(new CustomEvent('toolcall', { detail: msg.toolCall.functionCalls || [] }));
    }
    if (msg.usageMetadata) {
      // promptTokenCount es el TAMAÑO del contexto acumulado, no lo que sumas.
      const u = msg.usageMetadata;
      this.stats.contexto = u.promptTokenCount || 0;
      const detalles = u.promptTokensDetails || [];
      const porModalidad = (nombre) => detalles.filter((d) => (d.modality || '').includes(nombre)).reduce((a, d) => a + (d.tokenCount || 0), 0);
      this.stats.contextoAudio = porModalidad('AUDIO');
      this.stats.contextoTexto = porModalidad('TEXT');
      this.stats.salidaTokens = (this.stats.salidaTokens || 0) + (u.responseTokenCount || 0);
      this.stats.pensados = (this.stats.pensados || 0) + (u.thoughtsTokenCount || 0);
      this.stats.limite = this.opts.tokenLimit || this.stats.limite || 131072;
      this.dispatchEvent(new CustomEvent('usage'));
    }
    if (msg.serverContent) {
      const sc = msg.serverContent;
      if (sc.interrupted) this.dispatchEvent(new CustomEvent('interrupted'));
      if (sc.inputTranscription?.text) {
        this.dispatchEvent(new CustomEvent('inputtranscript', { detail: { text: sc.inputTranscription.text, final: true } }));
      }
      if (sc.interimInputTranscription?.text) {
        this.dispatchEvent(new CustomEvent('inputtranscript', { detail: { text: sc.interimInputTranscription.text, final: false } }));
      }
      if (sc.outputTranscription?.text) {
        this.dispatchEvent(new CustomEvent('outputtranscript', { detail: { text: sc.outputTranscription.text } }));
      }
      if (sc.modelTurn?.parts) {
        const audio = [];
        const text = [];
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) { this.stats.outputAudioBytes += Math.floor(part.inlineData.data.length * 0.75); audio.push(part.inlineData.data); }
          if (part.text) text.push(part.text);
        }
        if (audio.length || text.length) this.dispatchEvent(new CustomEvent('modelturn', { detail: { audio, text: text.join('') } }));
      }
      if (sc.turnComplete) this.dispatchEvent(new CustomEvent('turncomplete'));
      if (sc.generationComplete) this.dispatchEvent(new CustomEvent('generationcomplete'));
    }
  }

  #send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      this.stats.wsEnviados += 1;
    }
  }

  /** Audio PCM16 ya remuestreado a 16 kHz (bloques de 32 ms). */
  sendAudio(pcm16) {
    if (!this.ready) return;
    const view = ArrayBuffer.isView(pcm16) ? new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength) : new Uint8Array(pcm16);
    this.stats.inputAudioBytes += view.byteLength;
    let binary = '';
    for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
    this.#send({ realtimeInput: { audio: { data: btoa(binary), mimeType: 'audio/pcm;rate=16000' } } });
  }

  sendText(text) { this.#send({ realtimeInput: { text } }); }
  sendTurn(text) { this.#send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }); }
  sendToolResponse(responses) { this.#send({ toolResponse: { functionResponses: responses } }); }
  endAudioStream() { this.#send({ realtimeInput: { audioStreamEnd: true } }); }

  close() {
    this.closedByUs = true;
    try { this.ws?.close(1000, 'cliente'); } catch { /* ya cerrado */ }
    this.ws = null;
    this.ready = false;
  }
}

export function explainLiveError(reason = '') {
  if (/API key not valid|API_KEY_INVALID|401/.test(reason)) return 'La clave de API no es válida para el Live API.';
  if (/not supported|not found|404/.test(reason)) return 'Ese modelo no está disponible para tu clave.';
  if (/thinking level/i.test(reason)) return 'Ese modelo exige nivel de pensamiento LOW, MEDIUM o HIGH.';
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(reason)) return 'Cuota agotada para ese modelo.';
  return reason;
}
