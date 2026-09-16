/**
 * Reproductor: cola FIFO continua de PCM16 a 24 kHz con interpolación entre
 * fragmentos (sin microcortes, que es lo que sonaba áspero en Android).
 */
class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.sourceRate = o.sourceRate || 24000;
    this.ratio = this.sourceRate / sampleRate;
    this.queue = [];
    this.srcPos = 0;
    this.playing = false;
    this.dropped = 0;
    this._n = 0;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'push' && data.samples) {
        this.queue.push(data.samples);
        let total = 0;
        for (const c of this.queue) total += c.length;
        while (total > this.sourceRate * 60 && this.queue.length > 1) {
          total -= this.queue.shift().length;
          this.dropped += 1;
        }
      } else if (data.type === 'flush') {
        this.queue.length = 0;
        this.srcPos = 0;
        this.playing = false;
        this.port.postMessage({ type: 'state', playing: false, queuedMs: 0 });
      }
    };
  }
  queuedMs() {
    let samples = -this.srcPos;
    for (const c of this.queue) samples += c.length;
    return Math.max(0, (samples / this.sourceRate) * 1000);
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      while (this.queue.length && Math.floor(this.srcPos) >= this.queue[0].length) {
        this.srcPos -= this.queue[0].length;
        this.queue.shift();
      }
      if (!this.queue.length) { out[i] = 0; this.playing = false; continue; }
      const chunk = this.queue[0];
      const i0 = Math.floor(this.srcPos);
      const i1 = i0 + 1 < chunk.length ? i0 + 1 : i0;
      const t = this.srcPos - i0;
      out[i] = chunk[i0] * (1 - t) + chunk[i1] * t;
      this.srcPos += this.ratio;
      this.playing = true;
    }
    if (++this._n >= 8) {
      this._n = 0;
      this.port.postMessage({ type: 'state', playing: this.playing, queuedMs: Math.round(this.queuedMs()), dropped: this.dropped });
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
