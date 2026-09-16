/**
 * Captura: mezcla a mono, remuestrea a 16 kHz y entrega bloques PCM16 de 32 ms
 * (la documentación recomienda 20-40 ms para no añadir latencia).
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.chunkSamples = Math.round((o.chunkMs || 32) * this.targetRate / 1000);
    this.acc = new Float32Array(this.chunkSamples);
    this.accLen = 0;
    this.pos = 0;
    this.prev = 0;
    this.level = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const frames = input[0].length;
    const mono = new Float32Array(frames);
    for (let c = 0; c < input.length; c++) {
      const data = input[c];
      if (!data) continue;
      for (let i = 0; i < frames; i++) mono[i] += data[i];
    }
    if (input.length > 1) for (let i = 0; i < frames; i++) mono[i] /= input.length;
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += mono[i] * mono[i];
    this.level = Math.max(this.level * 0.8, Math.sqrt(sum / frames));
    let pos = this.pos;
    while (pos < frames) {
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, frames - 1);
      const t = pos - i0;
      const a = i0 < 0 ? this.prev : mono[i0];
      const b = mono[i1];
      this.acc[this.accLen++] = a + (b - a) * t;
      if (this.accLen >= this.chunkSamples) {
        const pcm = new Int16Array(this.chunkSamples);
        for (let i = 0; i < this.chunkSamples; i++) {
          let v = this.acc[i];
          if (v > 1) v = 1; else if (v < -1) v = -1;
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        this.port.postMessage({ buffer: pcm.buffer, level: this.level }, [pcm.buffer]);
        this.accLen = 0;
      }
      pos += this.ratio;
    }
    this.pos = pos - frames;
    this.prev = mono[frames - 1] || 0;
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
