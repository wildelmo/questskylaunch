// Browser smoke test: serve the built bundle, load it in headless Chromium,
// and make sure the garden is actually alive — rendering frames, planets
// orbiting, mouse grab-and-throw working. Run `npm run build` first, then:
//   node tools/smoke.mjs [--shots <dir>]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const dist = new URL('../dist', import.meta.url).pathname;
const shotsDir = process.argv.includes('--shots')
  ? process.argv[process.argv.indexOf('--shots') + 1] : null;

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const data = await readFile(join(dist, path));
    res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url);
// Software GL can be slow; wait on rendered frames, not wall-clock time.
await page.waitForFunction(() => window.__gg?.renderer.info.render.frame > 15, null, { timeout: 60000 });

check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

const state = await page.evaluate(() => {
  const { sim, renderer } = window.__gg;
  return {
    bodies: sim.bodies.length,
    finite: sim.bodies.every((b) =>
      Number.isFinite(b.pos.x) && Number.isFinite(b.vel.x)),
    calls: renderer.info.render.calls,
  };
});
check('starter system present', state.bodies === 3, `${state.bodies} bodies`);
check('all positions/velocities finite', state.finite);
check('scene has draw calls', state.calls > 10, `${state.calls} calls`);

// Fast-forward until a revolution completes — proves gravity, orbit tracking,
// and the note trigger path all run in the real page.
await page.evaluate(() => { window.__gg.sim.timeScale = 6; });
await page.waitForFunction(
  () => window.__gg.sim.bodies.reduce((n, b) => n + b.orbits, 0) >= 1,
  null, { timeout: 60000 });
await page.evaluate(() => { window.__gg.sim.timeScale = 1; });
check('a planet completed an orbit under time acceleration', true);

if (shotsDir) await page.screenshot({ path: join(shotsDir, 'garden-1-load.png') });

// Grab the inner planet with the mouse and hurl it: body count must hold and
// nothing may be left stuck to the pointer afterwards. Projecting the MESH's
// world position keeps this valid under any garden transform.
async function dragThrow() {
  const screenPos = await page.evaluate(() => {
    const { sim, camera } = window.__gg;
    const v = sim.bodies[0].mesh.getWorldPosition(sim.bodies[0].pos.clone()).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    };
  });
  await page.mouse.move(screenPos.x, screenPos.y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(screenPos.x + i * 40, screenPos.y - i * 6);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  return page.evaluate(() => ({
    bodies: window.__gg.sim.bodies.length,
    held: window.__gg.sim.bodies.some((b) => b.held),
    finite: window.__gg.sim.bodies.every((b) => Number.isFinite(b.pos.x)),
  }));
}

const after = await dragThrow();
check('throw kept the garden intact', after.bodies >= 2 && after.finite, `${after.bodies} bodies`);
check('nothing left stuck in hand', !after.held);

// Same again with the garden scaled, shifted and turned — the world-grip
// coordinate path. Grabbing must still work, then '0' resets the view.
await page.evaluate(() => {
  const g = window.__gg.gardenGroup;
  g.scale.setScalar(0.6);
  g.position.set(0.25, -0.1, 0.15);
  g.rotation.y = 0.5;
  g.updateMatrixWorld(true);
});
const scaled = await dragThrow();
check('grab-throw works in a transformed garden', scaled.bodies >= 2 && scaled.finite && !scaled.held,
  `${scaled.bodies} bodies`);
await page.keyboard.press('0');
const viewReset = await page.evaluate(() => {
  const g = window.__gg.gardenGroup;
  return g.scale.x === 1 && g.position.length() === 0;
});
check("'0' reset the garden view", viewReset);

// Mixed-reality scenery switch: passthrough mode hides the space scenery and
// clears to transparent. Headless can't start an AR session, but the wiring
// it flips is directly testable.
const arScenery = await page.evaluate(() => {
  const gg = window.__gg;
  gg.setSpaceScenery(false);
  const hidden = !gg.starfield.visible && !gg.platform.visible
    && gg.starfield.parent.background === null;
  gg.setSpaceScenery(true);
  const restored = gg.starfield.visible && gg.platform.visible
    && gg.starfield.parent.background !== null;
  return { hidden, restored };
});
check('AR mode hides space scenery and clears to transparent', arScenery.hidden);
check('leaving AR restores the sky', arScenery.restored);

// Keyboard toggles.
await page.keyboard.press('t');
await page.keyboard.press('2');
await page.keyboard.press('2');
const toggles = await page.evaluate(() => ({
  trails: window.__gg.garden.trailsOn,
  ts: window.__gg.sim.timeScale,
}));
check('T toggled trails off', toggles.trails === false);
check('2 sped up time', toggles.ts > 2, `×${toggles.ts.toFixed(2)}`);

await page.waitForTimeout(1200);
if (shotsDir) await page.screenshot({ path: join(shotsDir, 'garden-2-after-throw.png') });

// ---- the invasion, end to end ------------------------------------------------
// Press G to light the beacon, let the alarm run, then use the debug hooks to
// spawn a stinger at a known spot and shoot it — proving the whole kill path
// (bolt flight, swept collision, scoring, explosion) in the real page.

await page.keyboard.press('g');
const invState = await page.evaluate(() => window.__gg.invasion.state);
check('beacon starts the invasion', invState === 'alarm', invState);

await page.waitForFunction(
  () => window.__gg.invasion.state === 'wave' && window.__gg.invasion.rifts.length > 0,
  null, { timeout: 30000 });
check('alarm gives way to wave 1 with a rift open', true);

// Ships arrive on their own; wait for the first natural spawn.
await page.waitForFunction(
  () => window.__gg.invasion.ships.length > 0, null, { timeout: 30000 });
check('ships come through the rift', true);

// Watch the wave behave for a while. This guards the two ways the AI has
// actually failed: ships sharing one velocity object (they all drifted
// skyward in lockstep), and ships never engaging with anything.
const behavior = await page.evaluate(async () => {
  const inv = window.__gg.invasion;
  const out = { sharedVel: false, maxDist: 0, engaged: false, phases: new Set() };
  const seen = new Set();
  for (let i = 0; i < 60; i++) { // ~15 s of observation
    for (const s of inv.ships) {
      if (seen.has(s.vel) && !seen.has(s)) out.sharedVel = true;
      seen.add(s.vel);
      seen.add(s);
      out.maxDist = Math.max(out.maxDist, Math.hypot(s.pos.x, s.pos.y - 1.5, s.pos.z));
      out.phases.add(s.phase);
      if (['hunt', 'grab', 'strafe', 'tractor', 'flee'].includes(s.phase)) out.engaged = true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ...out, phases: [...out.phases] };
});
check('every ship owns its own velocity vector', !behavior.sharedVel);
check('no ship drifts away from the room', behavior.maxDist < 10,
  `max ${behavior.maxDist.toFixed(1)}m, phases: ${behavior.phases.join(',')}`);
check('ships engage the garden (hunt/grab/strafe/tow/flee)', behavior.engaged,
  behavior.phases.join(','));

if (shotsDir) await page.screenshot({ path: join(shotsDir, 'garden-3-invasion.png') });

// Deterministic kill: park a stinger clear of the garden (an unknown phase
// runs no AI, so it hovers) and fire bolts straight at it.
const killResult = await page.evaluate(async () => {
  const inv = window.__gg.invasion;
  const before = { score: inv.score, kills: inv.kills };
  const ship = inv.debugSpawn('stinger', [0.8, 1.9, -2.5]);
  ship.phase = 'hold';
  for (let i = 0; i < 40 && ship.hp > 0; i++) {
    inv.debugFireAt(ship);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    dead: ship.hp <= 0,
    scored: inv.score > before.score,
    counted: inv.kills > before.kills,
  };
});
check('a bolt kills a stinger', killResult.dead);
check('the kill scores', killResult.scored && killResult.counted);

// A harvester must be able to CATCH an orbiting planet — planets are faster
// than the barge, so this only works while lead pursuit + beam-range latch
// work. Then killing it must hand the planet back.
const towResult = await page.evaluate(async () => {
  const inv = window.__gg.invasion;
  const { sim, garden } = window.__gg;
  // The wave so far may have stolen or eaten everything; the barge needs a
  // planet in orbit to hunt.
  if (!sim.bodies.length) {
    const r = 0.6;
    const pos = sim.sun.pos.clone();
    pos.x += r;
    garden.addPlanet(pos, pos.clone().set(0, 0, sim.circularSpeed(r)), 0.04, 2);
  }
  const h = inv.debugSpawn('harvester', [1.8, 1.9, 0.6]);
  h.phase = 'enter';
  const t0 = performance.now();
  while (performance.now() - t0 < 35000) {
    await new Promise((r) => setTimeout(r, 300));
    if (!inv.ships.includes(h)) return { latched: false, gone: true };
    if (h.phase === 'tractor') break;
  }
  const body = h.target?.body;
  const latched = h.phase === 'tractor' && !!body?.abducted && !!h.beam?.visible;
  let released = false;
  if (latched) {
    inv.killShip(h, 'shot', null);
    released = !body.held && !body.abducted && body.alive;
  }
  return { latched, released };
});
check('a harvester intercepts an orbiting planet and tows it',
  towResult.latched, JSON.stringify(towResult));
check('killing the harvester frees the planet', towResult.released);

// Mouse fire: hold the pointer down on empty sky and wait for a stream —
// a fixed sleep undercounts when software GL drops to a few frames a second.
await page.mouse.move(200, 200);
await page.mouse.down();
let boltsAlive = 0;
try {
  await page.waitForFunction(() => window.__gg.invasion.bolts.bolts.length >= 2,
    null, { timeout: 8000 });
  boltsAlive = await page.evaluate(() => window.__gg.invasion.bolts.bolts.length);
} catch { /* boltsAlive stays under 2 and the check below fails */ }
await page.mouse.up();
check('holding the mouse hoses out bolts', boltsAlive >= 2, `${boltsAlive} bolts`);

// Rifts share the load: jump to a two-rift wave and record which rift each
// ship comes out of. Before the round-robin fix every ship used rift #0.
const riftSpread = await page.evaluate(async () => {
  const inv = window.__gg.invasion;
  for (const s of [...inv.ships]) inv.removeShip(s);
  inv.startWave(4);
  const used = new Set();
  const seen = new Set();
  const t0 = performance.now();
  while (performance.now() - t0 < 40000 && used.size < 2) {
    await new Promise((r) => setTimeout(r, 200));
    for (const s of inv.ships) {
      if (seen.has(s)) continue;
      seen.add(s);
      // A fresh ship is still at (or a step from) its rift.
      let best = null, bestD = Infinity;
      for (let i = 0; i < inv.rifts.length; i++) {
        const d = s.pos.distanceTo(inv.rifts[i].pos);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (bestD < 1.0) used.add(best);
    }
  }
  return { rifts: inv.rifts.filter((r) => !r.closing).length, used: [...used], spawned: seen.size };
});
check('a wave-4 siege opens two rifts', riftSpread.rifts === 2, JSON.stringify(riftSpread));
check('ships come out of more than one rift', riftSpread.used.length >= 2, JSON.stringify(riftSpread));

// The late arrivals exist as real hulls and run their AI without throwing.
const lateTypes = await page.evaluate(async () => {
  const inv = window.__gg.invasion;
  for (const s of [...inv.ships]) inv.removeShip(s);
  inv.queue.length = 0;
  const w = inv.debugSpawn('wraith', [1.5, 1.8, -1.5]);
  const h = inv.debugSpawn('harvester', [-1.5, 1.8, -1.5]);
  const g = inv.debugSpawn('warden', [-1.6, 1.9, -1.4]);
  const sp = inv.debugSpawn('siphon', [0, 2.2, -2.5]);
  for (const s of [w, h, g, sp]) s.phase = 'enter';
  window.__gg.sim.sun.meals = 3;
  const t0 = performance.now();
  const out = { cloakedOnce: false, shieldedOnce: false, drained: false, phases: new Set() };
  while (performance.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 200));
    if (w.cloak > 0.5) out.cloakedOnce = true;
    if (h.shielded === g) out.shieldedOnce = true;
    if (window.__gg.sim.sun.meals < 3) out.drained = true;
    for (const s of [w, g, sp]) out.phases.add(`${s.type}:${s.phase}`);
    if (out.cloakedOnce && out.shieldedOnce && out.drained) break;
  }
  return { ...out, phases: [...out.phases], alive: inv.ships.length };
});
check('a wraith cloaks', lateTypes.cloakedOnce, lateTypes.phases.join(','));
check('a warden shields the barge it escorts', lateTypes.shieldedOnce, lateTypes.phases.join(','));
check('a siphon drains the sun', lateTypes.drained, lateTypes.phases.join(','));

// Seeker pods: drop one, pick it up with the mouse shooter, and confirm the
// trigger now launches a seeker that homes in and kills.
const seekerResult = await page.evaluate(async () => {
  const inv = window.__gg.invasion;
  for (const s of [...inv.ships]) inv.removeShip(s);
  const pod = inv.debugDropPod([0.3, 1.4, -0.4]);
  const picked = inv.pickupPod(pod, 2);
  const loaded = inv.shooters[2].seekers;
  // A parked stinger 2.5 m out, and a shooter aimed roughly at it.
  const ship = inv.debugSpawn('stinger', [0.6, 1.9, -2.6]);
  ship.phase = 'hold';
  ship.spawnK = 1;
  const origin = ship.pos.clone().add(new ship.pos.constructor(0.4, 0.2, 2.2));
  const dir = ship.pos.clone().sub(origin).normalize();
  const lock = inv.seekerLock(origin, dir);
  inv.fireSeeker(2, null, lock);
  const t0 = performance.now();
  while (performance.now() - t0 < 8000 && ship.hp > 0) await new Promise((r) => setTimeout(r, 100));
  return { picked, loaded, locked: lock === ship, dead: ship.hp <= 0, left: inv.shooters[2].seekers };
});
check('grabbing a pod loads seekers', seekerResult.picked && seekerResult.loaded === 6,
  JSON.stringify(seekerResult));
check('a seeker locks on and kills its target', seekerResult.locked && seekerResult.dead,
  JSON.stringify(seekerResult));
check('firing spends a seeker', seekerResult.left === 5, `${seekerResult.left} left`);

// The exit hatch: a mouse hold on it fills the ring and fires the exit
// action; a released hold cancels. Headless has no XR session to end, so
// the action is a no-op here — the wiring is what's under test.
const hatchScreen = await page.evaluate(() => {
  const { hatch, camera, actions } = window.__gg;
  window.__exitCalls = 0;
  const orig = actions.exitXR;
  actions.exitXR = () => { window.__exitCalls++; return orig(); };
  window.__gg.interactions.onExit = () => actions.exitXR();
  const v = hatch.getWorldPosition(hatch.position.clone()).project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
});
await page.mouse.move(hatchScreen.x, hatchScreen.y);
await page.mouse.down();
await page.waitForTimeout(400);
const heldEarly = await page.evaluate(() => !!window.__gg.interactions.exitHold);
await page.mouse.up();
await page.waitForTimeout(100);
const cancelled = await page.evaluate(() => !window.__gg.interactions.exitHold && window.__exitCalls === 0);
check('a hand on the hatch starts a hold', heldEarly);
check('letting go early cancels it', cancelled);
await page.mouse.down();
try {
  await page.waitForFunction(() => window.__exitCalls > 0, null, { timeout: 25000 });
} catch { /* the check below reports it */ }
await page.mouse.up();
const exited = await page.evaluate(() => window.__exitCalls);
check('holding the hatch fires the exit', exited === 1, `${exited} exit calls`);

// End the siege: ships retreat, rifts close, the mode goes idle.
await page.keyboard.press('g');
await page.waitForFunction(
  () => window.__gg.invasion.state === 'idle', null, { timeout: 30000 });
const cleaned = await page.evaluate(() => ({
  ships: window.__gg.invasion.ships.length,
  rifts: window.__gg.invasion.rifts.filter((r) => !r.closing).length,
}));
check('beacon again ends the invasion and clears the sky',
  cleaned.ships === 0 && cleaned.rifts === 0, JSON.stringify(cleaned));

const finalErrors = errors.length;
check('still no errors after interaction', finalErrors === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(failures === 0 ? '\nsmoke: all good ✓' : `\nsmoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
