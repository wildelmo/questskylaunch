import { FLIGHT } from './config.js';

// The ascent profile.
//
// Altitude is interpolated through the configured waypoints with monotone cubic
// Hermite (Fritsch-Carlson).  Plain Catmull-Rom overshoots between unevenly
// spaced knots, and an overshoot here means going briefly backwards down the
// sky, which is both wrong and — because you are inside it — nauseating.
// Monotone splines cannot do that, and they still give continuous velocity, so
// there is never a visible change of gear.

function monotoneTangents(times, values) {
  const n = times.length;
  const slopes = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    slopes[i] = (values[i + 1] - values[i]) / (times[i + 1] - times[i]);
  }

  const tangents = new Array(n);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) tangents[i] = 0;
    else tangents[i] = (slopes[i - 1] + slopes[i]) / 2;
  }

  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const s = a * a + b * b;
    if (s > 9) {
      const scale = 3 / Math.sqrt(s);
      tangents[i] = scale * a * slopes[i];
      tangents[i + 1] = scale * b * slopes[i];
    }
  }
  return tangents;
}

/** @param keyframes [{t, value}] in increasing t. */
function createSpline(keyframes) {
  const times = keyframes.map((k) => k.t);
  const values = keyframes.map((k) => k.value);
  const tangents = monotoneTangents(times, values);
  const last = times.length - 1;

  return {
    duration: times[last],
    /** Returns [value, derivative] at time t. */
    at(t) {
      if (t <= times[0]) return [values[0], tangents[0]];
      if (t >= times[last]) return [values[last], tangents[last]];

      let i = 0;
      while (i < last && times[i + 1] < t) i++;
      const h = times[i + 1] - times[i];
      const s = (t - times[i]) / h;
      const s2 = s * s;
      const s3 = s2 * s;

      const h00 = 2 * s3 - 3 * s2 + 1;
      const h10 = s3 - 2 * s2 + s;
      const h01 = -2 * s3 + 3 * s2;
      const h11 = s3 - s2;
      const value = h00 * values[i] + h10 * h * tangents[i] + h01 * values[i + 1] + h11 * h * tangents[i + 1];

      const d00 = 6 * s2 - 6 * s;
      const d10 = 3 * s2 - 4 * s + 1;
      const d01 = -6 * s2 + 6 * s;
      const d11 = 3 * s2 - 2 * s;
      const slope =
        (d00 * values[i] + d01 * values[i + 1]) / h + d10 * tangents[i] + d11 * tangents[i + 1];

      return [value, slope];
    },
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

export function createFlight() {
  const spline = createSpline(FLIGHT.keyframes.map(({ t, alt }) => ({ t, value: alt })));
  const pitchSpline = createSpline(
    FLIGHT.pitch.map(({ t, deg }) => ({ t, value: (deg * Math.PI) / 180 }))
  );

  const MAX_PITCH_RATE = (FLIGHT.maxPitchRate * Math.PI) / 180;

  const state = {
    /** Seconds along the profile.  Not wall-clock: the throttle changes the rate. */
    clock: 0,
    running: false,
    rate: 1,
    /** Commanded and actual throttle, 0..1.  The gap between them is the spool. */
    throttleInput: 0,
    throttle: 0,
    brakeInput: 0,
    brake: 0,
    altitude: 0,
    climbRate: 0,
    pitch: 0,
    pitchRate: 0,
    duration: spline.duration,
    finished: false,
  };

  function sampleAltitude() {
    const [altitude, climbRate] = spline.at(state.clock);
    state.altitude = altitude;
    state.climbRate = climbRate * state.rate;
  }

  function sample() {
    sampleAltitude();
    state.pitch = pitchSpline.at(state.clock)[0];
    state.pitchRate = 0;
  }

  sample();

  /** Exponential approach with separate rise and fall constants. */
  function approach(current, target, dt, attack, release) {
    const tau = target > current ? attack : release;
    return current + (target - current) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));
  }

  return {
    state,

    start() {
      state.running = true;
    },

    pause() {
      state.running = false;
    },

    toggle() {
      state.running = !state.running;
    },

    restart() {
      state.clock = 0;
      state.rate = 1;
      state.throttle = 0;
      state.throttleInput = 0;
      state.brake = 0;
      state.brakeInput = 0;
      state.finished = false;
      state.running = true;
      sample();
    },

    /**
     * Throttle and brake, each 0..1, from whatever the user is holding.
     * Applied on the next update so the spool-up is framerate independent.
     */
    setControl(throttle, brake) {
      state.throttleInput = Math.min(Math.max(throttle, 0), 1);
      state.brakeInput = Math.min(Math.max(brake, 0), 1);
    },

    /** Direct rate override, used by the inspection hook. */
    setRate(rate) {
      state.rate = Math.min(Math.max(rate, -FLIGHT.maxBrake), FLIGHT.maxThrottle);
    },

    update(dt) {
      state.throttle = approach(
        state.throttle, state.throttleInput, dt, FLIGHT.throttleAttack, FLIGHT.throttleRelease);
      state.brake = approach(
        state.brake, state.brakeInput, dt, FLIGHT.throttleRelease, FLIGHT.throttleRelease);

      // Hands off sits at 1: the ride runs itself at the pace it was composed
      // for, and the throttle is something you add to it rather than something
      // you have to hold down to make anything happen at all.
      state.rate = 1
        + state.throttle * (FLIGHT.maxThrottle - 1)
        - state.brake * (1 + FLIGHT.maxBrake);

      if (state.running) {
        state.clock = Math.min(Math.max(state.clock + dt * state.rate, 0), spline.duration);
        state.finished = state.clock >= spline.duration;
      }
      sampleAltitude();

      // Attitude follows the profile but is rate limited, so no amount of
      // throttle can spin you faster than is comfortable.  It lags and catches
      // up instead, which reads as the nose swinging round a moment late.
      const target = pitchSpline.at(state.clock)[0];
      const step = Math.min(Math.max(target - state.pitch, -MAX_PITCH_RATE * dt), MAX_PITCH_RATE * dt);
      state.pitch += step;
      state.pitchRate = dt > 0 ? step / dt : 0;
    },

    /**
     * Aerodynamic buffet, 0..1 — how hard the air is hitting you.
     *
     * Proportional to speed times the square root of air density, which is the
     * usual proxy for how much the airframe is being shaken.  It is what drives
     * the shake, the roar and the haptics, and it means all three peak together
     * around fourteen kilometres and then die away as the air runs out, which
     * is where a real launch has max Q and why the ride there genuinely does go
     * quiet.  Nothing about that had to be arranged: it falls out of the
     * profile and the scale height.
     */
    buffet() {
      const density = Math.exp(-Math.max(state.altitude, 0) / 8.0);
      return Math.min((Math.abs(state.climbRate) * Math.sqrt(density)) / 8.0, 1);
    },

    /**
     * How far the comfort vignette should close, as a single hump in altitude.
     *
     * This used to be built from the climb rate divided by the altitude, plus a
     * term for how fast you were being rotated.  That is a defensible model of
     * where vection comes from and a terrible thing to look at.  Both of those
     * inputs are derivatives of splines, so every kink in the ascent profile
     * arrived amplified: it shut hard at ten seconds, sprang back open at
     * fourteen, held a shelf to eighteen, stepped down at twenty and then
     * reopened slightly at twenty-five.  A vignette you can watch moving is
     * worse than no vignette at all -- it draws the eye to precisely the
     * periphery it exists to quieten.
     *
     * Altitude only ever increases while you are climbing, so an envelope built
     * from altitude alone can rise once and fall once and do nothing else.  It
     * arrives as you leave the grass behind and is gone by the time the ground
     * is too far away to stream past you.
     */
    comfort() {
      const arrive = smoothstep(0.02, 0.15, state.altitude);
      const depart = 1 - smoothstep(1.5, 7.0, state.altitude);
      return arrive * depart;
    },
  };
}
