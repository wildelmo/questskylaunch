// The terrain you stand on is the real one plus invented detail.
//
// Large scale comes straight out of the packed surface map — 10 km per texel of
// genuine topography, so the Sierra Nevada is where the satellite imagery says
// it is and the valley floor is flat because it really is flat.  Everything
// finer than that texel is fabricated here.
//
// The integer hash below is duplicated in GLSL and JavaScript on purpose: the
// GPU displaces the mesh with it and the CPU uses it to drop trees and
// buildings onto the surface, and the two have to agree exactly or the props
// float.  Bit operations on 32-bit integers give the same answer on both, which
// is why this is not a sin()-based hash.

export const TERRAIN_OCTAVES = 10;
export const TERRAIN_BASE_FREQUENCY = 0.125; // cycles per km -> 8 km wavelength
export const TERRAIN_BASE_AMPLITUDE = 0.15; // km

export const HEIGHTFIELD_GLSL = /* glsl */ `
uint terrainHashU(uvec3 v) {
  uint h = v.x * 0x9E3779B1u ^ v.y * 0x85EBCA77u ^ v.z * 0xC2B2AE3Du;
  h ^= h >> 15; h *= 0x2545F491u; h ^= h >> 13;
  return h;
}

float terrainHash(ivec3 p) {
  uvec3 u = uvec3(p + ivec3(1 << 20));
  return float(terrainHashU(u) & 0xFFFFFFu) / 16777216.0;
}

float terrainValueNoise(vec2 p, int octave) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  ivec2 ii = ivec2(i);
  float a = terrainHash(ivec3(ii + ivec2(0, 0), octave));
  float b = terrainHash(ivec3(ii + ivec2(1, 0), octave));
  float c = terrainHash(ivec3(ii + ivec2(0, 1), octave));
  float d = terrainHash(ivec3(ii + ivec2(1, 1), octave));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Ridged multifractal for the high octaves, plain fBm underneath: the first
// gives believable ridge lines, the second keeps the low frequencies rounded.
float terrainDetail(vec2 pKm, float roughness) {
  float frequency = ${TERRAIN_BASE_FREQUENCY.toFixed(4)};
  float amplitude = ${TERRAIN_BASE_AMPLITUDE.toFixed(4)};
  float sum = 0.0;
  float ridgeMix = clamp(roughness, 0.0, 1.0);
  for (int o = 0; o < ${TERRAIN_OCTAVES}; o++) {
    float n = terrainValueNoise(pKm * frequency, o);
    float smoothed = n - 0.5;
    float ridged = 0.5 - abs(smoothed) * 2.0;
    sum += amplitude * mix(smoothed, ridged * 0.7, ridgeMix);
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  return sum;
}
`;

function hashU(x, y, z) {
  let h = (Math.imul(x >>> 0, 0x9e3779b1) ^ Math.imul(y >>> 0, 0x85ebca77) ^ Math.imul(z >>> 0, 0xc2b2ae3d)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

function terrainHash(x, y, z) {
  const bias = 1 << 20;
  return (hashU((x + bias) >>> 0, (y + bias) >>> 0, (z + bias) >>> 0) & 0xffffff) / 16777216;
}

function valueNoise(px, py, octave) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let fx = px - ix;
  let fy = py - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = terrainHash(ix, iy, octave);
  const b = terrainHash(ix + 1, iy, octave);
  const c = terrainHash(ix, iy + 1, octave);
  const d = terrainHash(ix + 1, iy + 1, octave);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Kilometres of invented relief at a local tangent-plane position, in km. */
export function terrainDetail(xKm, zKm, roughness) {
  let frequency = TERRAIN_BASE_FREQUENCY;
  let amplitude = TERRAIN_BASE_AMPLITUDE;
  let sum = 0;
  const ridgeMix = Math.min(Math.max(roughness, 0), 1);
  for (let o = 0; o < TERRAIN_OCTAVES; o++) {
    const n = valueNoise(xKm * frequency, zKm * frequency, o);
    const smoothed = n - 0.5;
    const ridged = 0.5 - Math.abs(smoothed) * 2;
    sum += amplitude * (smoothed + (ridged * 0.7 - smoothed) * ridgeMix);
    frequency *= 2;
    amplitude *= 0.5;
  }
  return sum;
}
