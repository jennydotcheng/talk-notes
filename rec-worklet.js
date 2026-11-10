// Turns microphone audio into 16 kHz mono and hands it to the page in half-second pieces.
class Rec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;      // fractional read position carried between blocks
    this.acc = 0;      // running sum for the current output sample
    this.cnt = 0;
    this.out = new Float32Array(8000);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += input[c][i];
      v /= ch;
      this.acc += v; this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.out[this.n++] = this.acc / this.cnt;
        this.acc = 0; this.cnt = 0;
        if (this.n === this.out.length) {
          this.port.postMessage(this.out, [this.out.buffer]);
          this.out = new Float32Array(8000);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('rec', Rec);
