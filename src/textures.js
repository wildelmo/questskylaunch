import * as THREE from 'three';

// Procedural planet surfaces. Each archetype paints a 512×256 equirectangular
// canvas — oceans and continents, rust and maria, cloud bands, ice, lava —
// that wraps seamlessly around a sphere. A small pool is generated once at
// startup and shared by every planet, so spawning a seed never hitches.
//
// Nothing here is downloaded; the "satellite imagery" is invented on the spot.

const W = 512, H = 256;

// Deterministic lattice hash, periodic in x so the texture's left and right
// edges meet cleanly at the sphere's seam.
function makeNoise(seed) {
  const hash = (ix, iy) => {
    const s = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // Value noise with smoothstep interpolation; period = lattice cells in x.
  const noise = (x, y, period) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const x0 = ((ix % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const a = hash(x0, iy), b = hash(x1, iy);
    const c = hash(x0, iy + 1), d = hash(x1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (x, y, octaves, basePeriod) => {
    let sum = 0, amp = 0.5, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * f, y * f, basePeriod * f);
      amp *= 0.5;
      f *= 2;
    }
    return sum; // ~0..1
  };
  // Ridged variant for cracks and lava veins.
  const ridge = (x, y, octaves, basePeriod) => {
    let sum = 0, amp = 0.55, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * Math.abs(noise(x * f, y * f, basePeriod * f) * 2 - 1);
      amp *= 0.5;
      f *= 2;
    }
    return sum;
  };
  return { noise, fbm, ridge };
}

// Piecewise-linear colour ramp: stops are [t, r, g, b] with t ascending.
function ramp(stops) {
  return (t, out) => {
    if (t <= stops[0][0]) { [, out[0], out[1], out[2]] = stops[0]; return out; }
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, r0, g0, b0] = stops[i - 1];
        const [t1, r1, g1, b1] = stops[i];
        const k = (t - t0) / (t1 - t0);
        out[0] = r0 + (r1 - r0) * k;
        out[1] = g0 + (g1 - g0) * k;
        out[2] = b0 + (b1 - b0) * k;
        return out;
      }
    }
    [, out[0], out[1], out[2]] = stops[stops.length - 1];
    return out;
  };
}

function paint(painter) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const img = g.createImageData(W, H);
  const px = img.data;
  const rgb = [0, 0, 0];
  const P = 8; // base lattice cells across the equator

  for (let y = 0; y < H; y++) {
    const v = y / H;
    const lat = Math.abs(v - 0.5) * 2; // 0 at equator, 1 at poles
    for (let x = 0; x < W; x++) {
      const u = x / W;
      painter(u * P, v * P * 0.5 + 31, u, v, lat, rgb);
      const i = (y * W + x) * 4;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = rgb[3] ?? 255;
      rgb[3] = undefined;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 2;
  return tex;
}

const P = 8;
const smooth = (a, b, t) => {
  const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

// ---- archetypes ---------------------------------------------------------------

function terra(seed) {
  const { fbm } = makeNoise(seed);
  const sea = ramp([[0, 8, 28, 68], [0.5, 14, 52, 110], [1, 30, 96, 150]]);
  const land = ramp([
    [0, 190, 175, 120],   // shore sand
    [0.25, 92, 140, 66],  // lowland green
    [0.55, 56, 100, 48],  // forest
    [0.8, 120, 105, 85],  // mountain rock
    [1, 235, 235, 238],   // snow line
  ]);
  return paint((nx, ny, u, v, lat, rgb) => {
    const h = fbm(nx, ny, 5, P);
    const coast = 0.52;
    if (h < coast) {
      sea(h / coast, rgb);
    } else {
      land(Math.min(1, (h - coast) / (1 - coast) * 1.35), rgb);
    }
    // Ice caps with a ragged noisy edge.
    const cap = smooth(0.78, 0.9, lat + (h - 0.5) * 0.18);
    rgb[0] = rgb[0] * (1 - cap) + 240 * cap;
    rgb[1] = rgb[1] * (1 - cap) + 246 * cap;
    rgb[2] = rgb[2] * (1 - cap) + 250 * cap;
  });
}

function mars(seed) {
  const { fbm } = makeNoise(seed);
  const ground = ramp([
    [0, 84, 38, 22],
    [0.4, 152, 74, 38],
    [0.7, 196, 112, 62],
    [1, 226, 158, 102],
  ]);
  return paint((nx, ny, u, v, lat, rgb) => {
    const h = fbm(nx, ny, 5, P);
    const maria = smooth(0.62, 0.5, fbm(nx * 0.5, ny * 0.5 + 7, 3, P / 2)); // dark basins
    ground(h, rgb);
    const dark = 1 - maria * 0.45;
    rgb[0] *= dark; rgb[1] *= dark; rgb[2] *= dark;
    const cap = smooth(0.9, 0.97, lat + (h - 0.5) * 0.1);
    rgb[0] = rgb[0] * (1 - cap) + 248 * cap;
    rgb[1] = rgb[1] * (1 - cap) + 240 * cap;
    rgb[2] = rgb[2] * (1 - cap) + 232 * cap;
  });
}

function gasGiant(seed, cool) {
  const { fbm } = makeNoise(seed);
  const bands = cool
    ? ramp([[0, 40, 74, 148], [0.35, 92, 150, 205], [0.65, 165, 205, 235], [1, 60, 110, 180]])
    : ramp([[0, 150, 96, 54], [0.3, 216, 168, 118], [0.6, 244, 222, 186], [0.85, 190, 120, 70], [1, 235, 200, 160]]);
  const spotV = 0.6 + (seed % 1) * 0.15;
  return paint((nx, ny, u, v, lat, rgb) => {
    // Latitudinal bands, wobbled by turbulence so they look fluid.
    const warp = (fbm(nx, ny, 4, P) - 0.5) * 0.9;
    const t = 0.5 + 0.5 * Math.sin(v * 26 + warp * 3.2 + Math.sin(v * 9 + seed) * 1.1);
    bands(t, rgb);
    // A great oval storm.
    const du = Math.min(Math.abs(u - 0.68), 1 - Math.abs(u - 0.68)) / 0.09;
    const dv = (v - spotV) / 0.045;
    const spot = Math.exp(-(du * du + dv * dv));
    if (spot > 0.02) {
      const sc = cool ? [235, 245, 255] : [225, 110, 70];
      rgb[0] = rgb[0] * (1 - spot) + sc[0] * spot;
      rgb[1] = rgb[1] * (1 - spot) + sc[1] * spot;
      rgb[2] = rgb[2] * (1 - spot) + sc[2] * spot;
    }
  });
}

function iceWorld(seed) {
  const { fbm, ridge } = makeNoise(seed);
  const surface = ramp([[0, 155, 190, 215], [0.5, 205, 228, 242], [1, 245, 250, 255]]);
  return paint((nx, ny, u, v, lat, rgb) => {
    surface(fbm(nx, ny, 4, P), rgb);
    // Pressure cracks: thin dark ridge lines across the shell.
    const r = ridge(nx * 1.5, ny * 1.5, 3, P * 1.5);
    const crack = smooth(0.32, 0.2, r);
    const d = 1 - crack * 0.5;
    rgb[0] *= d; rgb[1] *= d * 0.98; rgb[2] *= 1 - crack * 0.28;
  });
}

function lavaWorld(seed) {
  const { fbm, ridge } = makeNoise(seed);
  return {
    map: paint((nx, ny, u, v, lat, rgb) => {
      const rock = 26 + fbm(nx, ny, 4, P) * 40;
      rgb[0] = rock * 1.15; rgb[1] = rock * 0.9; rgb[2] = rock * 0.82;
    }),
    emissiveMap: paint((nx, ny, u, v, lat, rgb) => {
      const r = ridge(nx * 1.5, ny * 1.5, 4, P * 1.5);
      const vein = smooth(0.3, 0.12, r);
      const hot = fbm(nx * 2 + 5, ny * 2, 3, P * 2);
      const k = vein * (0.55 + hot * 0.45);
      rgb[0] = 255 * k;
      rgb[1] = 120 * k * k * 1.6;
      rgb[2] = 30 * k * k;
    }),
  };
}

function clouds(seed) {
  const { fbm } = makeNoise(seed);
  return paint((nx, ny, u, v, lat, rgb) => {
    // Streaky, wind-sheared cumulus: squash noise in v, warp in u.
    const warp = fbm(nx * 0.75 + 3, ny * 0.75, 3, P * 0.75) * 2.2;
    const c = fbm(nx * 1.25 + warp, ny * 2.1, 4, P * 1.25);
    const a = smooth(0.52, 0.78, c);
    rgb[0] = rgb[1] = rgb[2] = 255;
    rgb[3] = Math.round(a * 235);
  });
}

function moonRock(seed) {
  const { fbm } = makeNoise(seed);
  return paint((nx, ny, u, v, lat, rgb) => {
    const g = 105 + fbm(nx * 1.5, ny * 1.5, 4, P * 1.5) * 90;
    rgb[0] = g; rgb[1] = g * 0.98; rgb[2] = g * 0.94;
  });
}

// ---- the pool ----------------------------------------------------------------

// Built once at startup (~a quarter second) and reused by every planet.
export const ARCHETYPES = [];   // {kind, map, emissiveMap?, atmo, atmoStrength, cloudy, roughness}
export let CLOUD_MAPS = [];
export let MOON_MAP = null;

export function buildTexturePool() {
  if (ARCHETYPES.length) return;
  const A = ARCHETYPES;
  A.push(
    { kind: 'terra', map: terra(11), atmo: 0x6ab7ff, atmoStrength: 0.55, cloudy: true, roughness: 0.72 },
    { kind: 'terra', map: terra(47), atmo: 0x74c2ff, atmoStrength: 0.55, cloudy: true, roughness: 0.72 },
    { kind: 'terra', map: terra(83), atmo: 0x5fb0f5, atmoStrength: 0.55, cloudy: true, roughness: 0.72 },
    { kind: 'mars', map: mars(29), atmo: 0xff9a66, atmoStrength: 0.28, cloudy: false, roughness: 0.9 },
    { kind: 'mars', map: mars(61), atmo: 0xffab72, atmoStrength: 0.28, cloudy: false, roughness: 0.9 },
    { kind: 'gas', map: gasGiant(19, false), atmo: 0xffd9a0, atmoStrength: 0.45, cloudy: false, roughness: 0.6 },
    { kind: 'gas', map: gasGiant(53, true), atmo: 0x9fdcff, atmoStrength: 0.45, cloudy: false, roughness: 0.6 },
    { kind: 'ice', map: iceWorld(37), atmo: 0xcfeaff, atmoStrength: 0.4, cloudy: false, roughness: 0.55 },
  );
  const lava = lavaWorld(71);
  A.push({
    kind: 'lava', map: lava.map, emissiveMap: lava.emissiveMap,
    atmo: 0xff5a2a, atmoStrength: 0.5, cloudy: false, roughness: 0.95,
  });
  CLOUD_MAPS = [clouds(13), clouds(59)];
  MOON_MAP = moonRock(23);
}

// Weighted pick: terra worlds are the stars of the show.
export function pickArchetype() {
  const roll = Math.random();
  let kind;
  if (roll < 0.34) kind = 'terra';
  else if (roll < 0.54) kind = 'gas';
  else if (roll < 0.74) kind = 'mars';
  else if (roll < 0.87) kind = 'ice';
  else kind = 'lava';
  const options = ARCHETYPES.filter((a) => a.kind === kind);
  return options[(Math.random() * options.length) | 0];
}
