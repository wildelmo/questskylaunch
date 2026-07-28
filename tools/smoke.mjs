// Headless smoke test.  Serves the built site in a real Chromium with a real
// (software) GL driver, drives the flight to a list of altitudes and saves a
// frame at each one.  Shader compile errors, NaNs and black frames all show up
// here, which beats discovering them with a headset on your face.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const OUT = process.env.SMOKE_OUT || '/tmp/skylaunch-smoke';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.bin': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const problems = [];
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error' || /ERROR|error:|undeclared|not found|failed/i.test(text)) {
    problems.push(`[${message.type()}] ${text}`);
  }
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url()}`); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__skylaunch !== undefined, { timeout: 180000 });
await page.waitForFunction(() => window.__skylaunch.ready === true, { timeout: 180000 });

const shots = process.env.SMOKE_SHOTS
  ? JSON.parse(process.env.SMOKE_SHOTS)
  : [
      { name: '00-ground', alt: 0, pitch: 0, look: [0, 0] },
      { name: '01-ground-up', alt: 0, pitch: 0, look: [0, 0.35] },
      { name: '02-120m', alt: 0.12, pitch: 0.25 },
      { name: '03-2km', alt: 2.0, pitch: 0.55 },
      { name: '04-14km', alt: 14, pitch: 0.9 },
      { name: '05-45km', alt: 45, pitch: 1.1 },
      { name: '06-110km', alt: 110, pitch: 1.2 },
      { name: '07-400km', alt: 400, pitch: 1.256 },
      { name: '08-1200km', alt: 1200, pitch: 1.256 },
      { name: '09-6000km', alt: 6000, pitch: 1.256 },
      { name: '10-30000km', alt: 30000, pitch: 1.256 },
    ];

for (const shot of shots) {
  if (shot.uniform) console.log('  setUniform ->', await page.evaluate((u) => window.__skylaunch.setUniform(u[0], u[1]), shot.uniform));
  if (shot.debug) await page.evaluate((n) => window.__skylaunch.debugMaterial(n), shot.debug);
  if (shot.hide) console.log('  hide ->', await page.evaluate((names) => names.map((n) => window.__skylaunch.show(n, false)), shot.hide));
  if (shot.showAgain) await page.evaluate((names) => names.forEach((n) => window.__skylaunch.show(n, true)), shot.showAgain);
  await page.evaluate((s) => window.__skylaunch.pose(s), shot);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  const s = await page.evaluate(() => window.__skylaunch.stats());
  console.log(`${shot.name.padEnd(14)} draws=${s.drawCalls} tris=${s.triangles}`);
}

const stats = await page.evaluate(() => window.__skylaunch.stats());
console.log('stats:', JSON.stringify(stats));
console.log('props:', JSON.stringify(await page.evaluate(() => window.__skylaunch.inspect()), null, 1));
const probe = await page.evaluate(() => window.__skylaunch.probe());
console.log('luts:', JSON.stringify(probe, (k, v) => typeof v === 'number' ? Number(v.toPrecision(4)) : v));

await browser.close();
server.close();

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of [...new Set(problems)].slice(0, 40)) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log('\nno console errors');
}
