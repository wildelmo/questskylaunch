// Behavior probe: run a real invasion in headless Chromium for ~70 seconds
// and narrate what every ship actually does — phase changes, positions,
// distance to target, thefts, kills. Run `npm run build` first, then:
//   node tools/probe-behavior.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const dist = new URL('../dist', import.meta.url).pathname;
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
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.on('pageerror', (e) => console.log('pageerror:', String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__gg?.renderer.info.render.frame > 10, null, { timeout: 60000 });

await page.evaluate(() => {
  const inv = window.__gg.invasion;
  inv.start();
  window.__log = [];
  window.__shipIds = new Map();
  let nextId = 1;
  const id = (s) => {
    if (!window.__shipIds.has(s)) window.__shipIds.set(s, `${s.type[0]}${nextId++}`);
    return window.__shipIds.get(s);
  };
  const fmt = (v) => `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;
  window.__probe = setInterval(() => {
    const t = inv.time.toFixed(1);
    for (const s of inv.ships) {
      const tgt = s.target
        ? s.target.kind + (s.target.body ? `(r${s.target.body.radius.toFixed(3)})` : '')
        : '-';
      const aim = new window.__gg.gardenGroup.position.constructor();
      inv.targetAimPoint(s, aim);
      window.__log.push(
        `${t}s ${id(s)} ${s.phase} hp${s.hp} pos${fmt(s.pos)} vel${fmt(s.vel)} tgt=${tgt} dAim=${s.pos.distanceTo(aim).toFixed(2)}${s.cargo ? ' CARGO' : ''}`);
    }
  }, 1000);
  // Also narrate one-shot events by wrapping key methods.
  for (const name of ['snatch', 'latchTractor', 'escapeThroughRift', 'killShip', 'dropCargo']) {
    const orig = inv[name].bind(inv);
    inv[name] = (...a) => {
      const s = a[0];
      window.__log.push(`${inv.time.toFixed(1)}s EVENT ${name} ${s?.type ?? ''} phase=${s?.phase ?? ''}`);
      return orig(...a);
    };
  }
});

console.log('running invasion for 70s of wall time...');
await page.waitForTimeout(70000);

const { log, stats } = await page.evaluate(() => {
  clearInterval(window.__probe);
  const inv = window.__gg.invasion;
  return {
    log: window.__log,
    stats: {
      state: inv.state, wave: inv.wave, ships: inv.ships.length,
      kills: inv.kills, worldsLost: inv.worldsLost, score: inv.score,
      bodies: window.__gg.sim.bodies.length,
      nurserySeeds: window.__gg.garden.nursery.slots.filter((s) => s.mesh).length,
    },
  };
});
console.log(log.join('\n'));
console.log('\nFINAL:', JSON.stringify(stats));

await browser.close();
server.close();
