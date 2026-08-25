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

const finalErrors = errors.length;
check('still no errors after interaction', finalErrors === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(failures === 0 ? '\nsmoke: all good ✓' : `\nsmoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
