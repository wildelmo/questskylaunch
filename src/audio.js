// Sound, entirely synthesised — no audio files to ship, and nothing that has to
// loop seamlessly.
//
// The arc is the point: a field has a floor of wind and insects, the wind
// climbs as you do and then thins out with the air that carries it, and
// somewhere past eighty kilometres there is nothing left to carry sound at all.
// The silence lands much harder if you have spent a minute listening to it go.

function noiseBuffer(context, seconds, brown) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else {
      data[i] = white;
    }
  }
  // Cross-fade the tail into the head so the loop point is inaudible.
  const fade = Math.min(Math.floor(context.sampleRate * 0.25), Math.floor(length / 4));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[i] = data[i] * t + data[length - fade + i] * (1 - t);
  }
  return buffer;
}

export function createAudio() {
  let context = null;
  let started = false;
  const nodes = {};

  function build() {
    const master = context.createGain();
    master.gain.value = 0.0;
    master.connect(context.destination);

    // --- wind ---------------------------------------------------------------
    const wind = context.createBufferSource();
    wind.buffer = noiseBuffer(context, 6, false);
    wind.loop = true;
    const windFilter = context.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 500;
    windFilter.Q.value = 0.6;
    const windGain = context.createGain();
    windGain.gain.value = 0.12;
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();

    // --- the low end of moving fast through thick air -----------------------
    const rumble = context.createBufferSource();
    rumble.buffer = noiseBuffer(context, 6, true);
    rumble.loop = true;
    const rumbleFilter = context.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 120;
    const rumbleGain = context.createGain();
    rumbleGain.gain.value = 0.0;
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(master);
    rumble.start();

    // --- the engine ----------------------------------------------------------
    // A rocket is mostly broadband noise with a hard low-frequency shelf, so
    // this is brown noise through a steep lowpass with two resonances sitting
    // on top: one down where you feel it rather than hear it, one in the chest
    // register that gives it a throat.  It follows the throttle, not the
    // airspeed, so it is there the instant you pull and it does not vanish when
    // the atmosphere does.
    const engine = context.createBufferSource();
    engine.buffer = noiseBuffer(context, 7, true);
    engine.loop = true;
    const engineLow = context.createBiquadFilter();
    engineLow.type = 'lowpass';
    engineLow.frequency.value = 260;
    engineLow.Q.value = 0.4;
    const engineBody = context.createBiquadFilter();
    engineBody.type = 'peaking';
    engineBody.frequency.value = 62;
    engineBody.Q.value = 1.4;
    engineBody.gain.value = 11;
    const engineSub = context.createBiquadFilter();
    engineSub.type = 'peaking';
    engineSub.frequency.value = 31;
    engineSub.Q.value = 2.2;
    engineSub.gain.value = 9;
    const engineGain = context.createGain();
    engineGain.gain.value = 0.0;
    engine.connect(engineLow).connect(engineBody).connect(engineSub).connect(engineGain).connect(master);
    engine.start();

    // --- a field at four in the afternoon ------------------------------------
    const meadow = context.createBufferSource();
    meadow.buffer = noiseBuffer(context, 6, false);
    meadow.loop = true;
    const meadowFilter = context.createBiquadFilter();
    meadowFilter.type = 'bandpass';
    meadowFilter.frequency.value = 4200;
    meadowFilter.Q.value = 6.0;
    const meadowGain = context.createGain();
    meadowGain.gain.value = 0.05;
    meadow.connect(meadowFilter).connect(meadowGain).connect(master);
    meadow.start();

    // --- the drone that arrives when the air runs out ------------------------
    const padGain = context.createGain();
    padGain.gain.value = 0.0;
    padGain.connect(master);
    const partials = [55, 82.5, 110, 164.66];
    const oscillators = partials.map((frequency, index) => {
      const osc = context.createOscillator();
      osc.type = index === 0 ? 'sine' : 'triangle';
      osc.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.value = 0.28 / (index + 1);
      // A slow, prime-ish detune per partial so the chord never quite settles.
      const lfo = context.createOscillator();
      lfo.frequency.value = 0.03 + index * 0.017;
      const lfoGain = context.createGain();
      lfoGain.gain.value = 0.35 + index * 0.2;
      lfo.connect(lfoGain).connect(osc.detune);
      lfo.start();
      osc.connect(gain).connect(padGain);
      osc.start();
      return osc;
    });

    Object.assign(nodes, {
      master, windFilter, windGain, rumbleGain, rumbleFilter, meadowGain, padGain, oscillators,
      engineGain, engineLow, engineBody,
    });
  }

  function ramp(param, value, seconds = 0.25) {
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, Math.max(seconds, 0.01) / 3);
  }

  return {
    get started() {
      return started;
    },

    /** Must be called from a user gesture; browsers will not start audio otherwise. */
    async resume() {
      if (!context) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return false;
        context = new Ctor();
        build();
      }
      if (context.state === 'suspended') await context.resume();
      started = true;
      ramp(nodes.master.gain, 0.9, 1.5);
      return true;
    },

    setMuted(muted) {
      if (!context) return;
      ramp(nodes.master.gain, muted ? 0 : 0.9, 0.4);
    },

    /**
     * @param altitudeKm  height above the launch site
     * @param climbKmPerSecond how fast that is changing
     * @param throttle how hard the trigger is pulled, 0..1
     * @param buffet how hard the air is shaking you, 0..1
     */
    update(altitudeKm, climbKmPerSecond, throttle = 0, buffet = 0) {
      if (!started || !context) return;

      // Air density, roughly, from the same scale height the sky shader uses.
      const density = Math.exp(-Math.max(altitudeKm, 0) / 8.0);
      const speed = Math.abs(climbKmPerSecond);
      // Dynamic pressure is what you actually hear.
      const pressure = Math.min(density * speed * speed * 0.02, 1.4);

      ramp(nodes.windGain.gain, Math.min(0.10 + pressure * 0.85, 0.85), 0.35);
      ramp(nodes.windFilter.frequency, 380 + Math.min(speed, 3) * 900, 0.35);
      ramp(nodes.rumbleGain.gain, Math.min(pressure * 0.75 + buffet * 0.35, 0.7), 0.4);
      ramp(nodes.rumbleFilter.frequency, 70 + Math.min(speed, 4) * 45, 0.4);

      // The engine follows the throttle rather than the air, so it arrives the
      // instant you pull.  In vacuum there is nothing to carry it to you except
      // the structure you are riding, so it drops to a third and the top end
      // closes right down -- felt rather than heard.  That handover happening
      // on its own, while you are still accelerating hard, is the moment the
      // climb stops being loud.
      const carriedByAir = Math.min(density * 1.4, 1);
      ramp(nodes.engineGain.gain, throttle * (0.16 + carriedByAir * 0.42), 0.25);
      ramp(nodes.engineLow.frequency, 90 + carriedByAir * 230, 0.5);
      ramp(nodes.engineBody.gain, 6 + carriedByAir * 7, 0.5);

      // Insects and the sound of a field stay behind almost immediately.
      const onTheGround = Math.max(0, 1 - altitudeKm / 0.25);
      ramp(nodes.meadowGain.gain, 0.055 * onTheGround, 0.5);

      // The drone comes up as the wind dies, so there is never a silent gap --
      // just a handover from something physical to something that is not.
      const vacuum = Math.min(Math.max((altitudeKm - 55) / 90, 0), 1);
      ramp(nodes.padGain.gain, vacuum * 0.18, 3.0);
    },

    dispose() {
      if (context) context.close();
      context = null;
      started = false;
    },
  };
}
