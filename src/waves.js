import { INVASION } from './config.js';

// The invasion's arithmetic, kept pure so `npm test` can prove the game is
// fair without a headset: what each wave sends, how combos build, how the
// blaster heats, whether a bolt's flight crossed a ship. No three.js, no DOM
// — just numbers in, numbers out.

// What wave `n` (1-based) sends through the rifts. Stingers swarm harder
// every wave, harvesters join from wave 2, and every fourth wave a marauder
// comes to bombard the garden from a distance. The later silhouettes arrive
// once the player has learned the first three: wraiths from wave 5, wardens
// escorting the barges from wave 6, and a siphon every third wave from 7.
export function waveComposition(n) {
  return {
    stingers: Math.min(12, 2 + n),
    harvesters: n >= 2 ? Math.min(4, Math.floor(n / 2)) : 0,
    marauders: n > 0 && n % 4 === 0 ? 1 : 0,
    wraiths: n >= 5 ? Math.min(4, 1 + Math.floor((n - 5) / 3)) : 0,
    wardens: n >= 6 ? Math.min(2, Math.floor((n - 3) / 3)) : 0,
    siphons: n >= 7 && (n - 7) % 3 === 0 ? 1 : 0,
  };
}

// The order a wave's ships come through, from a composition. Heavies lead
// (a marauder or siphon announces itself before the swarm), then raiders
// interleave so the sky never fills with one silhouette — and each warden
// arrives right behind a harvester, because it exists to shield one.
export function buildQueue(mix) {
  const queue = [];
  for (let i = 0; i < (mix.marauders ?? 0); i++) queue.push('marauder');
  for (let i = 0; i < (mix.siphons ?? 0); i++) queue.push('siphon');
  let wardensLeft = mix.wardens ?? 0;
  const rounds = Math.max(mix.stingers ?? 0, mix.harvesters ?? 0, mix.wraiths ?? 0);
  for (let i = 0; i < rounds; i++) {
    if (i < (mix.stingers ?? 0)) queue.push('stinger');
    if (i < (mix.harvesters ?? 0)) {
      queue.push('harvester');
      if (wardensLeft > 0) { queue.push('warden'); wardensLeft--; }
    }
    if (i < (mix.wraiths ?? 0)) queue.push('wraith');
  }
  while (wardensLeft-- > 0) queue.push('warden'); // no barge to guard: fly anyway
  return queue;
}

// Which open rift the next ship comes through. Picking "the first open one"
// meant every ship of a siege poured out of a single hole while the other
// rifts hummed empty; this walks the open rifts in turn. `cursor` counts
// spawns; returns an index into `rifts`, or -1 if none is ready.
export function nextRiftIndex(rifts, cursor) {
  const open = [];
  for (let i = 0; i < rifts.length; i++) {
    if (rifts[i].k > 0.8 && !rifts[i].closing) open.push(i);
  }
  if (!open.length) return -1;
  return open[((cursor % open.length) + open.length) % open.length];
}

// A wraith's cloak, as a function of its own clock: 1 = fully hidden.
// Visible for `visibleFor` seconds at the start of each cycle, with short
// ramps either side so it shimmers in and out rather than popping.
export function cloakAmount(t, cfg) {
  const cycle = cfg.cloakCycle;
  const vis = cfg.visibleFor;
  const phase = ((t % cycle) + cycle) % cycle;
  const ramp = 0.3;
  if (phase < vis) {
    // Visible window: fade in at its start, fade out at its end.
    return Math.max(1 - phase / ramp, 1 - (vis - phase) / ramp, 0);
  }
  return 1;
}

// Steer a unit heading toward a target direction, bending at most
// `turnRate * dt` radians. Plain scalars: [x, y, z] out. This is the whole
// homing model — a seeker is a point that always turns, never a rocket
// that reasons.
export function steerHeading(hx, hy, hz, tx, ty, tz, maxTurn) {
  const dot = Math.max(-1, Math.min(1, hx * tx + hy * ty + hz * tz));
  const angle = Math.acos(dot);
  if (angle <= maxTurn || angle < 1e-6) return [tx, ty, tz];
  if (angle > Math.PI - 1e-3) {
    // Dead astern: no unique shortest turn, so pick any perpendicular and
    // start the turn that way. Next frame the geometry is well-posed again.
    let px = -hy, py = hx, pz = 0;
    if (Math.abs(hx) + Math.abs(hy) < 1e-6) { px = 1; py = 0; pz = 0; }
    const len = Math.hypot(px, py, pz);
    px /= len; py /= len; pz /= len;
    const c = Math.cos(maxTurn), s = Math.sin(maxTurn);
    return [hx * c + px * s, hy * c + py * s, hz * c + pz * s];
  }
  const k = maxTurn / angle;
  // Slerp between the two unit vectors.
  const s = Math.sin(angle);
  const a = Math.sin((1 - k) * angle) / s;
  const b = Math.sin(k * angle) / s;
  const x = hx * a + tx * b, y = hy * a + ty * b, z = hz * a + tz * b;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
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

// Where an attack run ends: a point `overshoot` metres past the mark along
// the dive line, pushed `graze` metres sideways (side = ±1) so the ship
// slices past the mark instead of ramming it. Plain scalars in, [x,y,z] out.
export function strafeThrough(sx, sy, sz, mx, my, mz, graze, overshoot, side) {
  let dx = mx - sx, dy = my - sy, dz = mz - sz;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) { dx = 0; dy = 0; dz = -1; } else { dx /= len; dy /= len; dz /= len; }
  // Lateral = dive direction × up; if the dive is vertical, fall back to x.
  let lx = -dz, ly = 0, lz = dx;
  const lateralLen = Math.hypot(lx, lz);
  if (lateralLen < 1e-6) { lx = 1; ly = 0; lz = 0; }
  else { lx /= lateralLen; lz /= lateralLen; }
  return [
    mx + dx * overshoot + lx * graze * side,
    my + dy * overshoot + ly * graze * side,
    mz + dz * overshoot + lz * graze * side,
  ];
}
