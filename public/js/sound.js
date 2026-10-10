// Tiny WebAudio chiptune SFX — no assets needed.
export class Sound {
  constructor() {
    this.ac = null;
    this.muted = false;
    this.lastShot = 0;
    try {
      this.muted = localStorage.getItem("tank.muted") === "1";
    } catch {}
  }

  unlock() {
    if (!this.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ac.destination);
    }
    if (this.ac.state === "suspended") this.ac.resume();
  }

  toggle() {
    this.muted = !this.muted;
    try {
      localStorage.setItem("tank.muted", this.muted ? "1" : "0");
    } catch {}
    return this.muted;
  }

  tone(freq, dur, { type = "square", vol = 0.1, slide = 0, delay = 0 } = {}) {
    if (this.muted || !this.ac) return;
    const t = this.ac.currentTime + delay;
    const o = this.ac.createOscillator();
    const g = this.ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(dur, vol = 0.2, freq = 1200) {
    if (this.muted || !this.ac) return;
    const t = this.ac.currentTime;
    const len = Math.floor(this.ac.sampleRate * dur);
    const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    const f = this.ac.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(80, t + dur);
    const g = this.ac.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  shoot(mine) {
    const now = performance.now();
    if (!mine && now - this.lastShot < 60) return;
    this.lastShot = now;
    this.tone(mine ? 900 : 700, 0.07, { vol: mine ? 0.06 : 0.025, slide: -500 });
  }
  hit() {
    this.noise(0.12, 0.18, 2500);
  }
  boom() {
    this.noise(0.6, 0.4, 900);
    this.tone(120, 0.4, { type: "sawtooth", vol: 0.08, slide: -80 });
  }
  pick() {
    [660, 880, 1320].forEach((f, i) => this.tone(f, 0.08, { vol: 0.06, delay: i * 0.06 }));
  }
  beep() {
    this.tone(440, 0.12, { vol: 0.07 });
  }
  go() {
    this.tone(880, 0.25, { vol: 0.08 });
  }
  win() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.16, { vol: 0.07, delay: i * 0.12 }));
  }
}
