/**
 * Onda Live — motor de audio.
 *
 * Decisiones tomadas con la documentación oficial del Live API delante:
 *  · Fragmentos de 32 ms (la doc recomienda 20-40 ms; con 100 ms se nota).
 *  · Remuestreo a 16 kHz mono antes de enviar.
 *  · El micrófono NUNCA se silencia: la doc dice que el usuario puede
 *    interrumpir en cualquier momento y que el servidor avisa con
 *    "interrupted". Silenciar el micro era un invento mío que rompía la
 *    conversación.
 *  · La voz del modelo se reproduce a través de un <audio> alimentado por el
 *    AudioContext, que es lo que Chrome usa como referencia para CANCELAR el
 *    eco: así el modelo no se oye a sí mismo por el altavoz.
 *  · Al recibir una interrupción se descarta el búfer al instante (lo pide la
 *    doc explícitamente) en vez de seguir hablando encima del usuario.
 */

const TARGET_RATE = 16000;   // entrada que pide el Live API
const OUTPUT_RATE = 24000;   // salida que entrega el Live API
const CHUNK_MS = 32;         // 20-40 ms según la documentación

export class AudioEngine {
  constructor({ onChunk, onLevel, onError, onNotice } = {}) {
    this.onChunk = onChunk || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onError = onError || (() => {});
    this.onNotice = onNotice || (() => {});
    this.ctx = null;
    this.mixer = null;
    this.playGain = null;
    this.playerNode = null;
    this.playerState = { playing: false, queuedMs: 0 };
    this.captureRunning = false;
    this.playbackVolume = 1;
    this._nextTime = 0;
    this._playing = new Set();
    this.source = null;
  }

  /** Crea el AudioContext (tras un gesto del usuario). */
  async ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Este navegador no soporta Web Audio.');
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.mixer = this.ctx.createGain();
    this.mixer.gain.value = 1;

    // Cadena de salida: reproductor → limitador → volumen → altavoz.
    this.playGain = this.ctx.createGain();
    this.playGain.gain.value = this.playbackVolume;
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -8;
    this.compressor.knee.value = 8;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.25;
    this.compressor.connect(this.playGain);

    // La voz se entrega como flujo a un <audio>: Chrome lo usa como referencia
    // para la cancelación de eco del micrófono.
    try {
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.playGain.connect(this.streamDest);
      this.audioEl = document.createElement('audio');
      this.audioEl.srcObject = this.streamDest.stream;
      this.audioEl.autoplay = true;
      this.audioEl.playsInline = true;
      this.audioEl.style.display = 'none';
      document.body.appendChild(this.audioEl);
      this.audioEl.play().catch(() => {});
    } catch {
      this.playGain.connect(this.ctx.destination);
    }

    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* Safari antiguo */ }
    await this._ensurePlayer();
    this.ctx.addEventListener('statechange', () => {
      this.onNotice('AudioContext: ' + this.ctx.state);
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    });
    return this.ctx;
  }

  async _ensurePlayer() {
    if (this.playerNode || this._playerFailed) return;
    try {
      await this.ctx.audioWorklet.addModule('pcm-player-worklet.js');
      const node = new AudioWorkletNode(this.ctx, 'pcm-player', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { sourceRate: OUTPUT_RATE },
      });
      node.connect(this.compressor);
      node.port.onmessage = (event) => {
        if (event.data && event.data.type === 'state') {
          this.playerState = { playing: Boolean(event.data.playing), queuedMs: event.data.queuedMs || 0 };
        }
      };
      this.playerNode = node;
    } catch (err) {
      console.warn('[onda] reproductor por worklet no disponible:', err);
      this._playerFailed = true;
    }
  }

  /** Captura del micrófono: mezcla → worklet de 16 kHz. */
  async startCapture() {
    if (this.captureRunning) return;
    const ctx = await this.ensureContext();
    try {
      await ctx.audioWorklet.addModule('pcm-worklet.js');
      this.workletNode = new AudioWorkletNode(ctx, 'pcm-capture', {
        numberOfInputs: 1, numberOfOutputs: 0,
        processorOptions: { targetRate: TARGET_RATE, chunkMs: CHUNK_MS },
      });
      this.workletNode.port.onmessage = (event) => {
        this.onLevel(event.data.level || 0);
        this.onChunk(new Int16Array(event.data.buffer));
      };
      this.mixer.connect(this.workletNode);
    } catch (err) {
      throw new Error('No se pudo preparar la captura de audio: ' + err.message);
    }
    this.captureRunning = true;
  }

  /**
   * Micrófono con la cancelación de eco del navegador activada: es lo que
   * permite hablar mientras el modelo responde sin que se oiga a sí mismo.
   */
  async addMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    const ctx = await this.ensureContext();
    const node = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    node.connect(analyser);
    analyser.connect(this.mixer);
    this.source = { stream, node, analyser, label: stream.getAudioTracks()[0]?.label || 'Micrófono' };
    await this.startCapture();
    return this.source;
  }

  /** Nivel del micrófono (vúmetro y nada más: no decide turnos). */
  level() {
    if (!this.source) return 0;
    const buf = new Uint8Array(this.source.analyser.frequencyBinCount);
    this.source.analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  setPlaybackVolume(value) {
    this.playbackVolume = value;
    if (this.playGain) this.playGain.gain.value = value;
  }

  /** ¿Queda voz sonando? Se pregunta al reloj del AudioContext. */
  get speaking() {
    if (!this.ctx) return false;
    if (this.playerNode) {
      const s = this.playerState || { playing: false, queuedMs: 0 };
      return s.playing || s.queuedMs > 40;
    }
    return this._nextTime > this.ctx.currentTime + 0.02;
  }

  /** Encola un bloque PCM16 de 24 kHz que llega en base64 desde el Live API. */
  playBase64(b64) {
    if (!this.ctx || !this.playGain) return;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (bytes.byteLength < 2) return;
    const count = Math.floor(bytes.byteLength / 2);
    if (this.playerNode) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const floats = new Float32Array(count);
      for (let i = 0; i < count; i++) floats[i] = view.getInt16(i * 2, true) / 32768;
      this.playerNode.port.postMessage({ type: 'push', samples: floats }, [floats.buffer]);
      return;
    }
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, count);
    const buffer = this.ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.compressor);
    const now = this.ctx.currentTime;
    if (this._nextTime < now + 0.03) this._nextTime = now + 0.08;
    node.start(this._nextTime);
    this._nextTime += buffer.duration;
    this._playing.add(node);
    node.onended = () => this._playing.delete(node);
  }

  /** Descarta la voz en curso: lo que pide la doc al recibir «interrupted». */
  flushPlayback() {
    if (this.playerNode) {
      this.playerNode.port.postMessage({ type: 'flush' });
      this.playerState = { playing: false, queuedMs: 0 };
    }
    for (const node of this._playing) { try { node.stop(); } catch { /* ya parada */ } }
    this._playing.clear();
    this._nextTime = 0;
  }
}

export { TARGET_RATE, OUTPUT_RATE, CHUNK_MS };
