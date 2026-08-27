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

  // ---- the invasion --------------------------------------------------------
  // The garden sings in A-minor pentatonic; the invasion leans on the notes
  // that scale leaves out. The alarm is a tritone against A, kills climb the
  // garden's own ladder, and a stolen world falls out of key entirely.

  // The beacon lit: two swells of a low A-against-Eb dyad. Menace in tune.
  alarm() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      for (const f of [110, 155.56]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(300, t + i * 0.5);
        lp.frequency.exponentialRampToValueAtTime(1400, t + i * 0.5 + 0.3);
        const g = this.envelope(0.09, 0.05, 0.42, t + i * 0.5);
        o.connect(lp).connect(g).connect(this.master);
        o.start(t + i * 0.5);
        o.stop(t + i * 0.5 + 0.5);
      }
    }
  }

  // The beacon put out: the dyad resolves to a clean open fifth.
  standDown() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [110, 164.81, 220].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.envelope(0.09, 0.02, 1.1, t + i * 0.09);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 1.2);
    });
  }

  // One bolt. Fired nine times a second, so: short, small, slightly
  // different every time — a zap, not a gunshot.
  blasterShot() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f0 = 1250 * (1 + (Math.random() - 0.5) * 0.12);
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.42, t + 0.07);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3600;
    const g = this.envelope(0.055, 0.002, 0.07, t);
    o.connect(lp).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.09);
  }

  overheat() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const noise = this.noiseSource(false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(5200, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.8);
    const g = this.envelope(0.12, 0.01, 0.85, t);
    noise.connect(bp).connect(g).connect(this.master);
    noise.start(t);
    noise.stop(t + 0.9);

    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.5);
    const g2 = this.envelope(0.06, 0.005, 0.5, t);
    o.connect(g2).connect(this.master);
    o.start(t);
    o.stop(t + 0.55);
  }

  blasterReady() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(1320, t + 0.07);
    const g = this.envelope(0.07, 0.004, 0.12, t);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.15);
  }

  // Sky tearing: a rising shimmer over a sub drop, from where the rift is.
  riftOpen(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const pan = this.panner(pos);
    const noise = this.noiseSource(false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + 0.7);
    const g = this.envelope(0.22, 0.03, 0.8, t);
    noise.connect(bp).connect(g).connect(pan);
    noise.start(t);
    noise.stop(t + 0.9);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.6);
    const g2 = this.envelope(0.25, 0.01, 0.7, t);
    o.connect(g2).connect(pan);
    o.start(t);
    o.stop(t + 0.75);
  }

  riftClose(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const pan = this.panner(pos);
    const noise = this.noiseSource(false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(4200, t);
    bp.frequency.exponentialRampToValueAtTime(240, t + 0.45);
    const g = this.envelope(0.14, 0.01, 0.5, t);
    noise.connect(bp).connect(g).connect(pan);
    noise.start(t);
    noise.stop(t + 0.55);
  }

  // A rift's idle drone — the hole in the sky hums until it shuts.
  // Returns a handle: { stop() }.
  riftHum(pos) {
    if (!this.ctx) return null;
    const t = this.ctx.currentTime;
    const pan = this.panner(pos);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.022, t + 0.6);
    g.connect(pan);
    const oscs = [];
    for (const f of [64, 64.7, 96.3]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 240;
      o.connect(lp).connect(g);
      o.start(t);
      oscs.push(o);
    }
    return {
      stop: () => {
        const now = this.ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setTargetAtTime(0.0001, now, 0.15);
        for (const o of oscs) o.stop(now + 0.8);
      },
    };
  }

  // A bolt connecting without killing: a dry metallic tink.
  shipHit(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const carrier = this.ctx.createOscillator();
    carrier.frequency.value = 2200 * (1 + (Math.random() - 0.5) * 0.1);
    const mod = this.ctx.createOscillator();
    mod.frequency.value = 3170;
    const modGain = this.ctx.createGain();
    modGain.gain.setValueAtTime(900, t);
    modGain.gain.exponentialRampToValueAtTime(10, t + 0.08);
    mod.connect(modGain).connect(carrier.frequency);
    const g = this.envelope(0.08, 0.001, 0.09, t);
    carrier.connect(g).connect(this.panner(pos));
    carrier.start(t); mod.start(t);
    carrier.stop(t + 0.11); mod.stop(t + 0.11);
  }

  // A ship coming apart: crunch, boom, sizzle — bigger ships die lower.
  shipExplode(pos, size = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const pan = this.panner(pos);

    const noise = this.noiseSource(false);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5000 / size, t);
    lp.frequency.exponentialRampToValueAtTime(280, t + 0.4);
    const g = this.envelope(0.26 * Math.min(1.6, size), 0.004, 0.5, t);
    noise.connect(lp).connect(g).connect(pan);
    noise.start(t);
    noise.stop(t + 0.55);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150 / size, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.35);
    const g2 = this.envelope(0.3 * Math.min(1.6, size), 0.005, 0.4, t);
    o.connect(g2).connect(pan);
    o.start(t);
    o.stop(t + 0.45);
  }

  // Each combo kill climbs the garden's own pentatonic ladder — a hot streak
  // literally plays a rising melody.
  comboNote(pos, step) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const freq = SCALE_HZ[Math.min(SCALE_HZ.length - 1, 2 + step)];
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq * 2;
    const g = this.envelope(0.1, 0.005, 0.4, t);
    o.connect(g).connect(this.panner(pos));
    o.start(t);
    o.stop(t + 0.45);
  }

  // The harvester's beam: an ugly detuned throb that follows the theft.
  // Returns { move(pos), stop() }.
  tractorHum(pos) {
    if (!this.ctx) return null;
    const t = this.ctx.currentTime;
    const pan = this.panner(pos);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.4);
    g.connect(pan);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 7;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(g.gain);
    lfo.start(t);
    const oscs = [lfo];
    for (const f of [82, 82.9, 123.8]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 400;
      o.connect(lp).connect(g);
      o.start(t);
      oscs.push(o);
    }
    return {
      move: (p) => {
        const now = this.ctx.currentTime;
        pan.positionX?.setTargetAtTime(p.x, now, 0.06);
        pan.positionY?.setTargetAtTime(p.y, now, 0.06);
        pan.positionZ?.setTargetAtTime(p.z, now, 0.06);
      },
      stop: () => {
        const now = this.ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setTargetAtTime(0.0001, now, 0.1);
        for (const o of oscs) o.stop(now + 0.6);
      },
    };
  }

  // A world dragged through the rift: a falling minor phrase, out of key —
  // the one sound in the garden that is meant to hurt.
  worldStolen(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [466.16, 349.23, 233.08].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.envelope(0.16, 0.01, 1.1, t + i * 0.22);
      o.connect(g).connect(this.panner(pos));
      o.start(t + i * 0.22);
      o.stop(t + i * 0.22 + 1.2);
    });
  }

  // A world pried back out of a dead courier's claws.
  rescue(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [329.63, 440, 659.26].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = this.envelope(0.1, 0.008, 0.5, t + i * 0.07);
      o.connect(g).connect(this.panner(pos));
      o.start(t + i * 0.07);
      o.stop(t + i * 0.07 + 0.6);
    });
  }

  // A thrown planet swatting a ship out of the sky: thump, then a bell —
  // the garden's own physics as a weapon deserves applause.
  swat(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.25);
    const g = this.envelope(0.35, 0.004, 0.3, t);
    o.connect(g).connect(this.panner(pos));
    o.start(t);
    o.stop(t + 0.35);
    this.merge(pos, 0.05);
  }

  // Two dark horn notes announcing a wave.
  waveStart() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [110, 146.83].forEach((f, i) => {
      for (const detune of [1, 1.004]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f * detune;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 700;
        const g = this.envelope(0.07, 0.06, 0.5, t + i * 0.42);
        o.connect(lp).connect(g).connect(this.master);
        o.start(t + i * 0.42);
        o.stop(t + i * 0.42 + 0.6);
      }
    });
  }

  // The sky quiet again: a light pentatonic run, cousin to the nova's.
  waveClear() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [0, 2, 4, 5, 7].forEach((idx, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = SCALE_HZ[idx] * 2;
      const g = this.envelope(0.08, 0.01, 0.6, t + i * 0.09);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.7);
    });
  }

  plasmaLaunch(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const carrier = this.ctx.createOscillator();
    carrier.frequency.setValueAtTime(90, t);
    carrier.frequency.exponentialRampToValueAtTime(180, t + 0.4);
    const mod = this.ctx.createOscillator();
    mod.frequency.value = 31;
    const modGain = this.ctx.createGain();
    modGain.gain.value = 60;
    mod.connect(modGain).connect(carrier.frequency);
    const g = this.envelope(0.16, 0.02, 0.5, t);
    carrier.connect(g).connect(this.panner(pos));
    carrier.start(t); mod.start(t);
    carrier.stop(t + 0.55); mod.stop(t + 0.55);
  }

  plasmaImpact(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const noise = this.noiseSource(false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(180, t + 0.3);
    const g = this.envelope(0.2, 0.005, 0.35, t);
    noise.connect(bp).connect(g).connect(this.panner(pos));
    noise.start(t);
    noise.stop(t + 0.4);
  }

  envelope(peak, attack, release, t) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    return g;
  }
}
