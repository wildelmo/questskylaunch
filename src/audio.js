import { SCALE_HZ } from './config.js';

// Everything you hear is synthesized here — there are no audio files in this
// project. Sounds that belong to a place in the garden (orbit notes, merges,
// the sun) go through PannerNodes, and main.js feeds the listener the camera
// pose every frame, so the music box is truly spatial in the headset.

export class GardenAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.started = false;
  }

  // Must be called from a user gesture (pointer down / session start).
  start() {
    if (this.started) return;
    this.started = true;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(comp);

    this.startAmbient();
    if (ctx.state === 'suspended') ctx.resume();
  }

  resume() {
    this.ctx?.resume();
  }

  // ---- listener -----------------------------------------------------------

  updateListener(pos, forward, up) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(forward.x, t, 0.02);
      l.forwardY.setTargetAtTime(forward.y, t, 0.02);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else if (l.setPosition) {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  panner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 0.6;
    p.rolloffFactor = 1.2;
    p.positionX?.setValueAtTime(pos.x, this.ctx.currentTime);
    p.positionY?.setValueAtTime(pos.y, this.ctx.currentTime);
    p.positionZ?.setValueAtTime(pos.z, this.ctx.currentTime);
    if (!p.positionX) p.setPosition(pos.x, pos.y, pos.z);
    p.connect(this.master);
    return p;
  }

  // ---- ambient bed --------------------------------------------------------

  startAmbient() {
    const ctx = this.ctx;

    // Two barely-detuned low sines: a slow, breathing interference beat.
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    droneGain.connect(lp).connect(this.master);
    for (const f of [55, 55.35, 110.2]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = f > 100 ? 0.35 : 1;
      o.connect(g).connect(droneGain);
      o.start();
    }

    // Solar wind: looped noise, bandpassed, gain swelling on a slow LFO.
    const noise = this.noiseSource(true);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.6;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.012;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.007;
    lfo.connect(lfoGain).connect(windGain.gain);
    lfo.start();
    noise.connect(bp).connect(windGain).connect(this.master);
    noise.start();
  }

  noiseSource(loop) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = !!loop;
    return src;
  }

  // ---- one-shots ----------------------------------------------------------

  grab() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(620, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.06);
    const g = this.envelope(0.1, 0.005, 0.09, t);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.12);
  }

  throw_(speed) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const noise = this.noiseSource(false);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.Q.value = 1.2;
    hp.frequency.setValueAtTime(500, t);
    hp.frequency.exponentialRampToValueAtTime(3800, t + 0.22);
    const g = this.envelope(Math.min(0.3, 0.07 + speed * 0.07), 0.01, 0.26, t);
    noise.connect(hp).connect(g).connect(this.master);
    noise.start(t);
    noise.stop(t + 0.3);
  }

  // The generative part: a soft pluck each time a planet completes an orbit.
  // Bigger planets sing lower; the note comes from where the planet is.
  orbitNote(pos, radius) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const idx = Math.max(0, Math.min(SCALE_HZ.length - 1,
      Math.round((1 - (radius - 0.018) / 0.09) * (SCALE_HZ.length - 1))));
    const freq = SCALE_HZ[idx] * (1 + (Math.random() - 0.5) * 0.004);

    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(freq * 5, t);
    lp.frequency.exponentialRampToValueAtTime(freq * 1.4, t + 0.9);
    const g = this.envelope(0.13, 0.008, 1.1, t);
    o.connect(lp).connect(g).connect(this.panner(pos));
    o.start(t);
    o.stop(t + 1.2);

    // A quiet octave shimmer above.
    const o2 = this.ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 2;
    const g2 = this.envelope(0.03, 0.01, 0.7, t);
    o2.connect(g2).connect(this.panner(pos));
    o2.start(t);
    o2.stop(t + 0.8);
  }

  // FM bell for two planets merging.
  merge(pos, radius) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 520 - radius * 3200;
    const carrier = this.ctx.createOscillator();
    carrier.frequency.value = Math.max(140, base);
    const mod = this.ctx.createOscillator();
    mod.frequency.value = Math.max(140, base) * 1.42;
    const modGain = this.ctx.createGain();
    modGain.gain.setValueAtTime(240, t);
    modGain.gain.exponentialRampToValueAtTime(2, t + 1.1);
    mod.connect(modGain).connect(carrier.frequency);
    const g = this.envelope(0.22, 0.004, 1.3, t);
    carrier.connect(g).connect(this.panner(pos));
    carrier.start(t); mod.start(t);
    carrier.stop(t + 1.4); mod.stop(t + 1.4);
  }

  // Deep swallow when the sun eats a planet.
  sunEat(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(105, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.7);
    const g = this.envelope(0.4, 0.01, 0.85, t);
    o.connect(g).connect(this.panner(pos));
    o.start(t);
    o.stop(t + 0.9);

    const noise = this.noiseSource(false);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 300;
    const g2 = this.envelope(0.2, 0.005, 0.3, t);
    noise.connect(lp).connect(g2).connect(this.panner(pos));
    noise.start(t);
    noise.stop(t + 0.35);
  }

  nova(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 1.6);
    const g = this.envelope(0.55, 0.01, 1.8, t);
    o.connect(g).connect(this.panner(pos));
    o.start(t);
    o.stop(t + 1.9);

    const noise = this.noiseSource(false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(7000, t + 1.4);
    const g2 = this.envelope(0.32, 0.02, 1.5, t);
    noise.connect(bp).connect(g2).connect(this.master);
    noise.start(t);
    noise.stop(t + 1.6);

    // A rising major arpeggio riding the shockwave.
    [0, 4, 7, 12].forEach((semi, i) => {
      const oo = this.ctx.createOscillator();
      oo.type = 'sine';
      oo.frequency.value = 330 * Math.pow(2, semi / 12);
      const gg = this.envelope(0.09, 0.01, 0.9, t + 0.12 * i);
      oo.connect(gg).connect(this.master);
      oo.start(t + 0.12 * i);
      oo.stop(t + 0.12 * i + 1);
    });
  }

  sweepAway() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const noise = this.noiseSource(false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1;
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(240, t + 0.6);
    const g = this.envelope(0.16, 0.01, 0.65, t);
    noise.connect(bp).connect(g).connect(this.master);
    noise.start(t);
    noise.stop(t + 0.7);
  }

  click() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 1900;
    const g = this.envelope(0.04, 0.001, 0.03, t);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.04);
  }

  envelope(peak, attack, release, t) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    return g;
  }
}
