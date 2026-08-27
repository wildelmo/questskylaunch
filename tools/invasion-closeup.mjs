// Beauty check for the invasion: park each ship type, a rift, and the beacon
// in front of the desktop camera and screenshot them. Run after `npm run build`:
//   node tools/invasion-closeup.mjs <outdir>
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const dist = new URL('../dist', import.meta.url).pathname;
const outDir = process.argv[2] ?? '.';

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

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.on('pageerror', (e) => console.log('pageerror:', String(e)));
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__gg?.renderer.info.render.frame > 10, null, { timeout: 60000 });

await page.evaluate(() => {
  document.getElementById('overlay').style.display = 'none';
  const inv = window.__gg.invasion;
  inv.start();
});
// Let the alarm elapse so state machinery is in 'wave'.
await page.waitForFunction(() => window.__gg.invasion.state === 'wave', null, { timeout: 30000 });

// Kill natural spawns and park one of each type on a viewing line.
await page.evaluate(() => {
  const inv = window.__gg.invasion;
  inv.queue.length = 0;
  for (const s of [...inv.ships]) inv.removeShip(s);
  const specs = [
    ['stinger', [-0.55, 1.95, -2.2]],
    ['harvester', [0, 1.95, -2.2]],
    ['marauder', [0.75, 1.95, -2.2]],
  ];
  for (const [type, pos] of specs) {
    const ship = inv.debugSpawn(type, pos);
    ship.phase = 'hold';
    ship.vel.set(0, 0, 1); // face the camera-ish
    ship.spawnK = 1;
  }
  // A rift on the left for the portrait.
  const rift = inv.openRift();
  rift.pos.set(-1.6, 1.7, -2.6);
  rift.mesh.position.copy(rift.pos);
  rift.k = 1;

  const o = window.__gg.interactions.orbit;
  o.pivot.set(0, 1.95, -2.2);
  o.radius = 1.6;
  o.theta = 0;
  o.phi = Math.PI / 2;
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(outDir, 'inv-lineup.png') });

// Close-up per ship.
for (const [i, name] of [['-0.55', 'stinger'], ['0', 'harvester'], ['0.75', 'marauder']].map((v, i) => [i, v[1]])) {
  await page.evaluate((idx) => {
    const xs = [-0.55, 0, 0.75];
    const o = window.__gg.interactions.orbit;
    o.pivot.set(xs[idx], 1.95, -2.2);
    o.radius = 0.55;
    o.theta = 0.5;
    o.phi = 1.35;
  }, i);
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(outDir, `inv-${name}.png`) });
}

// The rift, big.
await page.evaluate(() => {
  const o = window.__gg.interactions.orbit;
  o.pivot.set(-1.6, 1.7, -2.6);
  o.radius = 1.2;
  o.theta = 0.25;
  o.phi = 1.5;
});
await page.waitForTimeout(350);
await page.screenshot({ path: join(outDir, 'inv-rift.png') });

// The beacon.
await page.evaluate(() => {
  const o = window.__gg.interactions.orbit;
  o.pivot.set(0.62, 1.0, -0.62);
  o.radius = 0.45;
  o.theta = 0.4;
  o.phi = 1.3;
});
await page.waitForTimeout(350);
await page.screenshot({ path: join(outDir, 'inv-beacon.png') });

// Action: a harvester tractoring the ringed planet + bolts flying.
await page.evaluate(() => {
  const inv = window.__gg.invasion;
  const { sim } = window.__gg;
  const harv = inv.ships.find((s) => s.type === 'harvester');
  const target = sim.bodies.reduce((a, b) => (b.radius > (a?.radius ?? 0) ? b : a), null);
  if (harv && target) {
    inv.worldOfBody(target, harv.pos);
    harv.pos.y += 0.45;
    harv.target = { kind: 'planet', body: target };
    inv.latchTractor(harv);
    harv.phase = 'hold-tractor';
  }
  // Spray some bolts through the scene.
  for (let i = 0; i < 10; i++) {
    inv.bolts.fire(
      new window.__gg.gardenGroup.position.constructor(0.4 - i * 0.05, 1.1, 0.4),
      new window.__gg.gardenGroup.position.constructor(-0.25 + i * 0.05, 0.25, -1).normalize(),
      null);
  }
  const o = window.__gg.interactions.orbit;
  o.pivot.copy(harv ? harv.pos : { x: 0, y: 1.3, z: -1 });
  o.pivot.y -= 0.2;
  o.radius = 1.1;
  o.theta = 0.3;
  o.phi = 1.35;
});
// Step tractor manually a few frames since phase 'hold-tractor' skips AI.
await page.evaluate(async () => {
  const inv = window.__gg.invasion;
  const harv = inv.ships.find((s) => s.type === 'harvester');
  if (harv?.target?.body) {
    for (let i = 0; i < 40; i++) {
      inv.dragWorldAway.call(inv, harv, 1 / 60);
      await new Promise((r) => setTimeout(r, 16));
    }
  }
});
await page.screenshot({ path: join(outDir, 'inv-tractor.png') });

await browser.close();
server.close();
console.log('done');
