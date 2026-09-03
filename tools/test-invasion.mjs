// Headless sanity checks for the invasion's arithmetic — run with `npm test`.
// If these pass, the waves escalate fairly, combos pay what they promise,
// the blaster overheats and recovers, and a bolt can't tunnel through a ship.

import {
  waveComposition, spawnIntervalFor, waveSpeedMul, comboAdvance, comboMultiplier,
  heatAfterShot, heatCool, canFire, segmentSphereHit, waveClearBonus, strafeThrough,
  buildQueue, nextRiftIndex, cloakAmount, steerHeading,
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

  // The late arrivals wait until the first three silhouettes are learned.
  check('no wraiths, wardens or siphons in the opening waves',
    [1, 2, 3, 4].every((n) => {
      const w = waveComposition(n);
      return w.wraiths === 0 && w.wardens === 0 && w.siphons === 0;
    }));
  check('wraiths arrive at wave 5', waveComposition(5).wraiths === 1);
  check('wardens arrive at wave 6', waveComposition(6).wardens === 1);
  check('a siphon every third wave from 7',
    waveComposition(7).siphons === 1 && waveComposition(8).siphons === 0
    && waveComposition(10).siphons === 1 && waveComposition(13).siphons === 1);
  check('late-wave escorts are capped',
    waveComposition(40).wraiths <= 4 && waveComposition(40).wardens <= 2);
  let monotoneAll = true;
  let lastAll = 0;
  for (let n = 1; n <= 14; n++) {
    const w = waveComposition(n);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    if (total < lastAll) monotoneAll = false;
    lastAll = total;
  }
  check('total ship count never shrinks through wave 14', monotoneAll);
}

// ---- 1b. queue order: heavies lead, wardens follow their barges ---------------

{
  const q = buildQueue(waveComposition(8));
  const mix = waveComposition(8);
  const count = (type) => q.filter((s) => s === type).length;
  check('queue carries the whole composition',
    count('stinger') === mix.stingers && count('harvester') === mix.harvesters
    && count('marauder') === mix.marauders && count('wraith') === mix.wraiths
    && count('warden') === mix.wardens && count('siphon') === mix.siphons, q.join(','));
  check('the marauder leads the wave', q[0] === 'marauder');
  const firstWarden = q.indexOf('warden');
  const firstHarvester = q.indexOf('harvester');
  check('a warden never arrives before the first harvester', firstWarden > firstHarvester);
  check('a warden arrives right behind a harvester', q[firstWarden - 1] === 'harvester');
  check('wardens with no barge still fly',
    buildQueue({ wardens: 2 }).filter((s) => s === 'warden').length === 2);
}

// ---- 1c. ships come out of EVERY open rift, not just the first ----------------

{
  const rifts = [{ k: 1, closing: false }, { k: 1, closing: false }, { k: 1, closing: false }];
  const picks = [0, 1, 2, 3, 4, 5].map((c) => nextRiftIndex(rifts, c));
  check('spawns walk the open rifts in turn', picks.join('') === '012012', picks.join(''));
  check('every open rift gets used', new Set(picks).size === 3);
  rifts[1].closing = true;
  const picks2 = [0, 1, 2, 3].map((c) => nextRiftIndex(rifts, c));
  check('a closing rift is skipped', !picks2.includes(1) && picks2.includes(0) && picks2.includes(2),
    picks2.join(''));
  rifts[2].k = 0.3;
  check('a rift still tearing open is skipped', [0, 1, 2].every((c) => nextRiftIndex(rifts, c) === 0));
  check('no open rift means no spawn', nextRiftIndex([{ k: 0.2, closing: false }], 0) === -1);
}

// ---- 1d. the wraith's cloak has a fair, readable window -----------------------

{
  const cfg = INVASION.wraith;
  let visibleTime = 0;
  const step = 0.01;
  for (let t = 0; t < cfg.cloakCycle; t += step) if (cloakAmount(t, cfg) < 0.5) visibleTime += step;
  check('wraith is visible for a real share of each cycle',
    visibleTime > 0.8 && visibleTime < cfg.cloakCycle * 0.7, `${visibleTime.toFixed(2)}s`);
  check('mid-window it is fully visible', cloakAmount(cfg.visibleFor / 2, cfg) === 0);
  check('out of window it is fully cloaked', cloakAmount(cfg.visibleFor + 0.5, cfg) === 1);
  check('the cloak ramps rather than pops', cloakAmount(0.1, cfg) > 0 && cloakAmount(0.1, cfg) < 1);
  check('cycles repeat', cloakAmount(0.7, cfg) === cloakAmount(0.7 + cfg.cloakCycle * 3, cfg));
}

// ---- 1e. seeker steering bends, but only so far per frame ----------------------

{
  // Heading -z, target +x: with a small turn budget the heading moves only
  // that far; with a big one it snaps to the target.
  const [x, , z] = steerHeading(0, 0, -1, 1, 0, 0, 0.1);
  const turned = Math.atan2(x, -z);
  check('a seeker turns at most its budget', Math.abs(turned - 0.1) < 1e-6, `${turned.toFixed(4)} rad`);
  check('steered heading stays unit length', Math.abs(Math.hypot(x, z) - 1) < 1e-9);
  const snap = steerHeading(0, 0, -1, 1, 0, 0, 3);
  check('a generous budget reaches the target', Math.abs(snap[0] - 1) < 1e-9 && Math.abs(snap[2]) < 1e-9);
  const same = steerHeading(0, 1, 0, 0, 1, 0, 0.05);
  check('already on target: unchanged', same.every(Number.isFinite) && Math.abs(same[1] - 1) < 1e-9);
  const opposite = steerHeading(0, 0, 1, 0, 0, -1, 0.2);
  check('a dead-astern target still yields a finite turn', opposite.every(Number.isFinite)
    && Math.abs(Math.hypot(...opposite) - 1) < 1e-6, JSON.stringify(opposite));
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

// ---- 5. attack-run geometry: past the mark, off to one side --------------------

{
  // Ship at origin, mark 2 m ahead on -z: the run ends beyond the mark,
  // shifted sideways so the ship grazes rather than rams.
  const [x, y, z] = strafeThrough(0, 1.5, 0, 0, 1.5, -2, 0.14, 0.8, 1);
  check('run overshoots the mark', z < -2.5, `z=${z.toFixed(2)}`);
  check('run stays level with a level dive', Math.abs(y - 1.5) < 1e-9);
  check('run misses to the side by the graze distance', Math.abs(Math.abs(x) - 0.14) < 1e-9,
    `x=${x.toFixed(2)}`);

  const left = strafeThrough(0, 1.5, 0, 0, 1.5, -2, 0.14, 0.8, -1);
  check('side sign flips the miss direction', Math.sign(left[0]) !== Math.sign(x));

  // A vertical dive can't cross with 'up': the lateral fallback still
  // produces a finite, offset point.
  const vert = strafeThrough(0, 3, 0, 0, 1, 0, 0.14, 0.8, 1);
  check('vertical dive still yields a finite offset point',
    vert.every(Number.isFinite) && Math.abs(vert[0]) > 0.1, JSON.stringify(vert));

  // Degenerate: ship exactly on the mark — still finite.
  const deg = strafeThrough(1, 1, 1, 1, 1, 1, 0.14, 0.8, 1);
  check('coincident ship and mark still yields a finite point', deg.every(Number.isFinite));
}

console.log(failures === 0 ? '\ninvasion: all good ✓' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
