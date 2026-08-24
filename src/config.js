// Every number worth arguing about lives here.
//
// Units are real-world metres and seconds — the garden is a tabletop system
// about a metre across, hanging in front of you at chest height. Masses are
// stored premultiplied by G (so `gm` is in m³/s²) and gravity is just
// a = gm / d². The sun's gm is tuned so a gentle underhand toss at half a
// metre out gives a stable orbit with a period of a few seconds, and a hard
// throw escapes.

export const SUN = {
  pos: [0, 1.25, -1.05],  // tabletop height, just out of arm's reach
  radius: 0.13,
  gm: 0.45,               // circular speed at r=0.5 m ≈ 0.95 m/s
  growPerMeal: 1.035,     // gm multiplier each time it eats a planet
  radiusPerMeal: 1.022,
  mealsToNova: 8,
};

export const PHYSICS = {
  substep: 1 / 240,        // fixed integration step (seconds, sim time)
  maxSubsteps: 24,         // cap per rendered frame so slow frames can't spiral
  soften: 0.02,            // gravitational softening length (m)
  escapeRadius: 7,         // beyond this a body has left the garden
  maxBodies: 42,
  planetDensity: 25,       // gm = density * radius³ — subtle planet-planet pull
};

// The three seed sizes on the nursery stand.
export const SEED_RADII = [0.021, 0.034, 0.052];

export const THROW = {
  velocityScale: 0.95,     // released velocity = smoothed hand velocity * this
  grabRadius: 0.13,        // how close a hand must be to pick something up
  smoothFrames: 6,         // frames of position history for release velocity
};

export const TIME = {
  min: 0.15,
  max: 6,
  stickRate: 2.2,          // exponential rate for thumbstick time control
};

export const TRAIL = {
  points: 220,             // ring buffer length per planet
  minStep: 0.008,          // metres moved before a new point is recorded
};

export const PREDICT = {
  steps: 340,              // how far ahead the held-planet ghost arc looks
  dt: 0.02,                // seconds of sim time per prediction step
};

export const NURSERY = {
  pos: [-0.62, 1.0, -0.62],
  spacing: 0.16,
  respawnDelay: 1.4,       // seconds before a taken seed grows back
};

export const LAYOUT = {
  platformRadius: 1.5,
  panelPos: [0.92, 1.42, -0.72],
  panelTilt: -0.55,        // radians of yaw toward the player
};

// Pastel-vivid planet palette; a hue is picked at random per seed.
export const PLANET_COLORS = [
  0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xb980f0,
  0xff9f68, 0x5ad1cd, 0xf473b9, 0xc9d64f, 0x8ea6ff,
];

// A-minor pentatonic, low to high — small planets sing higher.
export const SCALE_HZ = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 659.26];
