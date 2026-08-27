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
  smoothFrames: 8,         // frames of position history for release velocity
};

// Orbit assist: a bare hand is fast, and untuned throws all escaped. The
// throw's direction is always yours, but its speed is softly capped just
// under the local escape speed — so a casual toss bends into an orbit, and
// only a deliberate hurl (over `yeet` × escape speed) actually leaves.
export const ASSIST = {
  cap: 0.9,
  yeet: 2.0,
};

// Two-handed world grip: pinch or grip empty space with both hands to scale,
// pan, and turn the whole garden. Your platform stays put under your feet.
export const GRIP = {
  minScale: 0.35,
  maxScale: 2.5,
};

export const MOONS = {
  minRadius: 0.03,
  chance: 0.4,
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

// The invasion: alien poachers rift in to steal your worlds. Distances are
// world-space metres — ships fly through the *room*, not the garden group, so
// in mixed reality they punch through your actual walls. Everything the
// player does (bolts, aim, heat) runs in real time, unaffected by the sim's
// timeScale: dodging and aiming are player skills, not garden physics.
export const INVASION = {
  beaconPos: [0.62, 1.02, -0.62], // mirrors the nursery, under the info panel

  // Where rifts tear open: a shell around the garden, biased above the floor.
  spawnRadiusVR: [3.2, 5.2],
  spawnRadiusAR: [2.2, 3.4],      // passthrough rooms are smaller than space
  spawnHeight: [0.7, 2.4],
  maxShips: 6,                    // Quest GPU budget; the queue trickles in
  maxRifts: 3,

  alarmTime: 2.6,                 // klaxon + first rift tearing open
  intermission: 7,                // breather between waves
  spawnInterval: [1.1, 2.6],      // seconds between ships, shrinks with waves

  blaster: {
    rate: 9,                      // bolts per second while the trigger is down
    boltSpeed: 7,
    boltLife: 1.3,                // seconds; ~9 m of range
    maxBolts: 64,
    spread: 0.021,                // radians of jitter — a hose, not a rifle
    assistCone: 0.14,             // radians; bolts bend toward ships this close
    assistBend: 0.6,              // fraction of the aim error corrected
    heatPerShot: 0.030,           // ~3.7 s of continuous fire before overheat
    coolRate: 0.34,               // heat shed per second when not firing
    resumeBelow: 0.35,            // after an overheat, fire again under this
  },

  ships: {
    stinger:   { hp: 1,  hitRadius: 0.11, speed: 1.15, turnRate: 3.4, score: 100 },
    harvester: { hp: 6,  hitRadius: 0.16, speed: 0.55, turnRate: 1.6, score: 400 },
    marauder:  { hp: 14, hitRadius: 0.22, speed: 0.45, turnRate: 1.2, score: 1500 },
  },
  fleeSpeed: 1.9,                 // couriers sprint once they have your world
  tractorReel: 1.4,               // seconds to reel a caught planet to the keel
  stealRadiusMax: 0.036,          // stingers only snatch worlds this small (m)
  marauderOrbitRadius: 2.1,
  orbSpeed: 0.55,                 // marauder plasma drifts in slowly — shootable
  orbEverySeconds: 6.5,
  orbHitRadius: 0.09,
  orbKnock: 0.9,                  // impulse a plasma hit gives a planet (m/s)

  score: {
    orb: 50, swat: 250, rescue: 150,
    waveClearBase: 200, waveClearPerWave: 50,
    comboWindow: 2.5,             // seconds between kills to keep a combo alive
    comboMax: 5,
  },
};

// Pastel-vivid planet palette; a hue is picked at random per seed.
export const PLANET_COLORS = [
  0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xb980f0,
  0xff9f68, 0x5ad1cd, 0xf473b9, 0xc9d64f, 0x8ea6ff,
];

// A-minor pentatonic, low to high — small planets sing higher.
export const SCALE_HZ = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 659.26];
