import { INVASION } from './config.js';

// The invasion's arithmetic, kept pure so `npm test` can prove the game is
// fair without a headset: what each wave sends, how combos build, how the
// blaster heats, whether a bolt's flight crossed a ship. No three.js, no DOM
// — just numbers in, numbers out.

// What wave `n` (1-based) sends through the rifts. Stingers swarm harder
// every wave, harvesters join from wave 2, and every fourth wave a marauder
// comes to bombard the garden from a distance.
export function waveComposition(n) {
  return {
    stingers: Math.min(12, 2 + n),
    harvesters: n >= 2 ? Math.min(4, Math.floor(n / 2)) : 0,
    marauders: n > 0 && n % 4 === 0 ? 1 : 0,
  };
}

// Seconds between ship arrivals: waves get denser, never instant.
export function spawnIntervalFor(n) {
  const [min, max] = INVASION.spawnInterval;
  return Math.max(min, max - (n - 1) * 0.18);
}

// Ships get a touch faster as waves climb, capped so wave 20 is still human.
export function waveSpeedMul(n) {
  return 1 + Math.min(0.5, (n - 1) * 0.045);
}

// Combo scoring: kills within `comboWindow` seconds of each other build a
// multiplier. Returns the new consecutive-kill count; the multiplier a kill
// pays at is `comboMultiplier(kills)`.
export function comboAdvance(kills, secondsSinceLastKill) {
  return secondsSinceLastKill <= INVASION.score.comboWindow ? kills + 1 : 1;
}

export function comboMultiplier(kills) {
  return Math.max(1, Math.min(INVASION.score.comboMax, kills));
}

// The blaster's heat model. One object per hand: { heat: 0..1+, overheated }.
// Each shot adds heat; crossing 1 locks the trigger until heat cools below
// `resumeBelow`. Cooling runs every frame, firing or not.
export function heatAfterShot(state) {
  const heat = state.heat + INVASION.blaster.heatPerShot;
  return { heat, overheated: state.overheated || heat >= 1 };
}

export function heatCool(state, dt) {
  const heat = Math.max(0, state.heat - INVASION.blaster.coolRate * dt);
  return {
    heat,
    overheated: state.overheated && heat > INVASION.blaster.resumeBelow,
  };
}

export function canFire(state) {
  return !state.overheated;
}

// Did the segment a→b pass within `r` of point c? Bolts cover ~10 cm per
// frame — faster than a stinger is wide — so hits test the swept segment,
// never just the endpoint. Plain scalars: this runs for every bolt × ship
// pair every frame.
export function segmentSphereHit(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? (acx * abx + acy * aby + acz * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = acx - abx * t, dy = acy - aby * t, dz = acz - abz * t;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

// Wave-clear bonus grows with the wave survived.
export function waveClearBonus(n) {
  return INVASION.score.waveClearBase + INVASION.score.waveClearPerWave * n;
}
