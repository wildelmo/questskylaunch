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

  const state = {
    /** Seconds along the profile.  Not wall-clock: scrubbing changes the rate. */
    clock: 0,
    running: false,
    rate: 1,
    altitude: 0,
    climbRate: 0,
    pitch: 0,
    pitchRate: 0,
    duration: spline.duration,
    finished: false,
  };

  function sample() {
    const [altitude, climbRate] = spline.at(state.clock);
    state.altitude = altitude;
    state.climbRate = climbRate * state.rate;

    const [pitch, pitchSlope] = pitchSpline.at(state.clock);
    state.pitch = pitch;
    state.pitchRate = pitchSlope * state.rate;
  }

  sample();

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
      state.finished = false;
      state.running = true;
      sample();
    },

    /** Thumbstick scrubbing: forward speeds up, back slows and can reverse. */
    setRate(rate) {
      state.rate = Math.min(Math.max(rate, -3), 6);
    },

    update(dt) {
      if (state.running) {
        state.clock = Math.min(Math.max(state.clock + dt * state.rate, 0), spline.duration);
        state.finished = state.clock >= spline.duration;
      }
      sample();
    },

    /**
     * How hard the vignette should close in.  Vection sickness in a passive
     * ascent comes from two places: optical flow past nearby objects, and being
     * rotated without having asked to be.  Both are strongest early on, near
     * the ground, so the vignette is at its tightest exactly then and is gone
     * by the time there is nothing left to stream past you.
     */
    comfort() {
      // Standing still is not uncomfortable, so gate everything on actually
      // moving before scaling by how fast the near field is streaming past.
      const moving = smoothstep(0.01, 0.06, Math.abs(state.climbRate));
      const flowNearGround = Math.min(
        Math.abs(state.climbRate) / Math.max(state.altitude * 0.35 + 0.02, 0.02), 1);
      const rotation = Math.min(Math.abs(state.pitchRate) / 0.045, 1);
      const groundProximity = 1 - smoothstep(0.5, 12, state.altitude);
      return Math.min(moving * flowNearGround * groundProximity * 0.8 + rotation * 0.35, 1);
    },
  };
}
