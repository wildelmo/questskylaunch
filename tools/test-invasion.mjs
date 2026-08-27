// Headless sanity checks for the invasion's arithmetic — run with `npm test`.
// If these pass, the waves escalate fairly, combos pay what they promise,
// the blaster overheats and recovers, and a bolt can't tunnel through a ship.

import {
  waveComposition, spawnIntervalFor, waveSpeedMul, comboAdvance, comboMultiplier,
  heatAfterShot, heatCool, canFire, segmentSphereHit, waveClearBonus,
} from '../src/waves.js';
import { INVASION } from '../src/config.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// ---- 1. waves escalate, and every fourth brings a marauder ---------------------

{
  const w1 = waveComposition(1);
  check('wave 1 is stingers only', w1.stingers === 3 && w1.harvesters === 0 && w1.marauders === 0,
    JSON.stringify(w1));
  const w2 = waveComposition(2);
  check('harvesters join at wave 2', w2.harvesters >= 1);
  check('marauder every fourth wave',
    waveComposition(4).marauders === 1 && waveComposition(5).marauders === 0
    && waveComposition(8).marauders === 1);

  let last = 0;
  let monotone = true;
  for (let n = 1; n <= 12; n++) {
    const w = waveComposition(n);
    const total = w.stingers + w.harvesters + w.marauders;
    if (total < last) monotone = false;
    last = total;
  }
  check('wave size never shrinks', monotone);
  const w30 = waveComposition(30);
  check('late waves are capped', w30.stingers <= 12 && w30.harvesters <= 4,
    JSON.stringify(w30));
  check('spawn gaps shrink but stay humane',
    spawnIntervalFor(1) > spawnIntervalFor(6)
    && spawnIntervalFor(50) >= INVASION.spawnInterval[0]);
  check('ship speed growth is capped', waveSpeedMul(99) <= 1.5 && waveSpeedMul(1) === 1);
}

// ---- 2. combos build inside the window and break outside it --------------------

{
  let kills = 0;
  kills = comboAdvance(kills, Infinity);   // first kill
  check('first kill starts at ×1', kills === 1 && comboMultiplier(kills) === 1);
  kills = comboAdvance(kills, 1.0);
  kills = comboAdvance(kills, 1.0);
  check('quick kills build the multiplier', comboMultiplier(kills) === 3);
  for (let i = 0; i < 20; i++) kills = comboAdvance(kills, 0.5);
  check('multiplier is capped', comboMultiplier(kills) === INVASION.score.comboMax);
  kills = comboAdvance(kills, INVASION.score.comboWindow + 0.01);
  check('a slow kill resets the streak', kills === 1);
  check('wave-clear bonus grows with the wave',
    waveClearBonus(5) > waveClearBonus(1));
}

// ---- 3. the blaster heats, locks, cools, and unlocks ---------------------------

{
  let hs = { heat: 0, overheated: false };
  let shots = 0;
  while (canFire(hs) && shots < 1000) {
    hs = heatAfterShot(hs);
    shots++;
  }
  check('sustained fire eventually overheats', hs.overheated, `${shots} shots`);
  check('overheat takes a few seconds of fire, not one burst',
    shots > 20 && shots < 60, `${shots} shots @ ${INVASION.blaster.rate}/s`);

  // While overheated the trigger stays dead until heat drops below the
  // resume threshold.
  hs = heatCool(hs, 0.1);
  check('still locked right after overheating', !canFire(hs));
  let t = 0;
  while (!canFire(hs) && t < 60) {
    hs = heatCool(hs, 1 / 72);
    t += 1 / 72;
  }
  check('blaster recovers on its own', canFire(hs), `${t.toFixed(2)}s to recover`);
  check('recovery lands at the resume threshold',
    Math.abs(hs.heat - INVASION.blaster.resumeBelow) < 0.02, `heat ${hs.heat.toFixed(3)}`);
}

// ---- 4. swept bolt collision: no tunnelling ------------------------------------

{
  // A bolt crossing straight through a ship between frames must still hit.
  check('segment through the centre hits',
    segmentSphereHit(0, 0, -1, 0, 0, 1, 0, 0, 0, 0.1));
  check('segment passing wide misses',
    !segmentSphereHit(0, 0, -1, 0, 0, 1, 0.5, 0, 0, 0.1));
  check('grazing segment inside the radius hits',
    segmentSphereHit(0, 0, -1, 0, 0, 1, 0.09, 0, 0, 0.1));
  check('endpoint proximity counts',
    segmentSphereHit(0, 0, 0, 1, 0, 0, 1.05, 0, 0, 0.1));
  check('short segment far away misses',
    !segmentSphereHit(0, 0, 0, 0.01, 0, 0, 3, 3, 3, 0.2));
  // Degenerate segment (paused frame): behaves like a point test.
  check('zero-length segment still tests the point',
    segmentSphereHit(1, 1, 1, 1, 1, 1, 1, 1.05, 1, 0.1));
}

console.log(failures === 0 ? '\ninvasion: all good ✓' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
