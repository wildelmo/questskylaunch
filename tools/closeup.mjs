// Beauty check: load the built app, park the desktop orbit camera close to
// each starter planet on its sunlit side, and screenshot. Run `npm run build`
// first, then:
//   node tools/closeup.mjs <outdir>
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
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__gg?.renderer.info.render.frame > 10, null, { timeout: 60000 });

await page.evaluate(() => {
  window.__gg.sim.paused = true;
  document.getElementById('overlay').style.display = 'none';
});

for (let i = 0; i < 3; i++) {
  await page.evaluate((idx) => {
    const { sim, interactions } = window.__gg;
    const body = sim.bodies[idx];
    const p = body.mesh.getWorldPosition(body.pos.clone());
    const s = sim.sun.pos.clone().sub(p).normalize(); // toward the sun
    const o = interactions.orbit;
    o.pivot.copy(p);
    o.radius = body.radius * 7;
    o.theta = Math.atan2(s.x, s.z);
    o.phi = Math.acos(Math.max(-1, Math.min(1, s.y)));
  }, i);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, `closeup-${i}.png`) });
}

await browser.close();
server.close();
console.log('done');
