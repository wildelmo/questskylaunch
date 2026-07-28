import * as THREE from 'three';
import { OUTPUT_GLSL } from '../render/output.js';

// The night sky is the real one: ~8,900 naked-eye stars from the HYG catalogue
// at their true right ascension and declination, coloured from their B-V index,
// with a procedural Milky Way laid in behind them in galactic coordinates.  Get
// this right and Orion is where Orion should be; get it wrong and every space
// scene looks like a screensaver.
//
// Both objects live in a group whose orientation is the launch frame times the
// Greenwich sidereal angle, and whose position tracks the camera so everything
// in it sits at infinity.

const STAR_VERTEX = /* glsl */ `
uniform float uViewHeight;
uniform float uSizeScale;
uniform float uVisibility;
out vec3 vColour;
out float vBrightness;

// The colour attribute carries the star's tint, flux its relative brightness.
attribute float flux;

void main() {
  vColour = color;
  vBrightness = flux * uVisibility;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // Bright stars are not physically larger, but every optical system --
  // including an eye -- spreads them, and without it magnitude differences
  // vanish into a single-pixel dot.
  float px = 1.35 + 2.9 * pow(clamp(vBrightness, 0.0, 1.0), 0.42);
  gl_PointSize = px * uSizeScale * max(uViewHeight / 1100.0, 0.6);
}
`;

const STAR_FRAGMENT = /* glsl */ `
precision highp float;
in vec3 vColour;
in float vBrightness;
layout(location = 0) out vec4 fragColor;
${OUTPUT_GLSL}
uniform float uIntensity;

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  // Airy-ish: a tight core inside a soft halo.
  float core = exp(-r2 * 7.0);
  float halo = exp(-r2 * 1.6) * 0.22;
  fragColor = encodeOutput(vColour * vBrightness * uIntensity * (core + halo), 1.0);
}
`;

const GALAXY_VERTEX = /* glsl */ `
out vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GALAXY_FRAGMENT = /* glsl */ `
precision highp float;
in vec3 vDirection;
layout(location = 0) out vec4 fragColor;

${OUTPUT_GLSL}
uniform vec3 uGalacticPole;
uniform vec3 uGalacticCentre;
uniform float uIntensity;
uniform float uVisibility;

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i + vec3(0, 0, 0)), hash31(i + vec3(1, 0, 0)), f.x),
        mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
        mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * valueNoise(p);
    p *= 2.07;
    a *= 0.52;
  }
  return s;
}

void main() {
  vec3 d = normalize(vDirection);

  float sinB = clamp(dot(d, uGalacticPole), -1.0, 1.0);
  float towardCentre = dot(d, uGalacticCentre);

  // The band: a narrow ridge about the galactic equator, brightest and widest
  // toward Sagittarius and thinning away toward the anticentre.
  float width = mix(0.055, 0.115, clamp(towardCentre * 0.5 + 0.5, 0.0, 1.0));
  float band = exp(-(sinB * sinB) / (2.0 * width * width));
  float lengthwise = 0.34 + 0.66 * pow(clamp(towardCentre * 0.5 + 0.5, 0.0, 1.0), 2.2);

  float clumps = fbm(d * 9.0) * 0.7 + fbm(d * 31.0) * 0.45;
  // Dust lanes cut the band almost in half where they cross it.
  float dust = smoothstep(0.30, 0.72, fbm(d * 14.0 + vec3(11.3, 4.7, 21.9)));
  float density = band * lengthwise * (0.35 + clumps) * (1.0 - dust * 0.62);

  // Unresolved stars are slightly warm; the dust reddens what is behind it.
  vec3 tint = mix(vec3(0.72, 0.78, 1.0), vec3(1.0, 0.86, 0.66), dust * 0.8);
  fragColor = encodeOutput(tint * density * uIntensity * uVisibility, 1.0);
}
`;

const DEG = Math.PI / 180;

/** B-V colour index to a linear RGB tint, normalised to roughly equal luminance. */
function colourFromIndex(bv) {
  const clamped = Math.min(Math.max(bv, -0.4), 2.0);
  // Ballesteros' relation, then a crude Planckian locus.
  const t = 4600 * (1 / (0.92 * clamped + 1.7) + 1 / (0.92 * clamped + 0.62));
  const x = Math.min(Math.max(t, 1000), 40000) / 100;
  let r;
  let g;
  let b;
  if (x <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(x) - 161.1195681661;
    b = x <= 19 ? 0 : 138.5177312231 * Math.log(x - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(x - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(x - 60, -0.0755148492);
    b = 255;
  }
  const c = new THREE.Color(
    Math.min(Math.max(r, 0), 255) / 255,
    Math.min(Math.max(g, 0), 255) / 255,
    Math.min(Math.max(b, 0), 255) / 255
  );
  c.convertSRGBToLinear();
  // Keep total energy in the flux attribute, not smuggled into the tint.
  const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return c.multiplyScalar(1 / Math.max(luminance, 1e-3));
}

export async function loadStarCatalogue(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`star catalogue: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const header = new Uint8Array(buffer, 0, 4);
  const magic = String.fromCharCode(...header);
  if (magic !== 'SKY1') throw new Error('star catalogue: bad magic');
  const count = new Uint32Array(buffer.slice(4, 8))[0];
  const data = new Float32Array(buffer, 8, count * 5);
  return { count, data };
}

export function createStarfield(catalogue, { radius = 1.0 } = {}) {
  const group = new THREE.Group();
  group.name = 'starfield';
  group.matrixAutoUpdate = true;

  // --- Milky Way ------------------------------------------------------------
  const galacticPole = equatorialUnit(192.85948 * DEG, 27.12825 * DEG);
  const galacticCentre = equatorialUnit(266.40498 * DEG, -28.93617 * DEG);

  const galaxyMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: GALAXY_VERTEX,
    fragmentShader: GALAXY_FRAGMENT,
    uniforms: {
      uGalacticPole: { value: galacticPole },
      uGalacticCentre: { value: galacticCentre },
      uIntensity: { value: 0.0045 },
      uVisibility: { value: 1.0 },
    },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const galaxy = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), galaxyMaterial);
  galaxy.frustumCulled = false;
  galaxy.renderOrder = -2100;
  group.add(galaxy);

  // --- stars ----------------------------------------------------------------
  const { count, data } = catalogue;
  const positions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  const flux = new Float32Array(count);

  const starRadius = radius * 0.98;
  for (let i = 0; i < count; i++) {
    const o = i * 5;
    positions[i * 3 + 0] = data[o + 0] * starRadius;
    positions[i * 3 + 1] = data[o + 1] * starRadius;
    positions[i * 3 + 2] = data[o + 2] * starRadius;

    const magnitude = data[o + 3];
    // A compressed magnitude scale.  The true 2.512-per-magnitude ratio makes
    // everything below third magnitude disappear on a headset display; 10^-0.3
    // keeps the hierarchy legible without flattening it.
    flux[i] = Math.pow(10, -0.3 * magnitude);

    const c = colourFromIndex(data[o + 4]);
    colours[i * 3 + 0] = c.r;
    colours[i * 3 + 1] = c.g;
    colours[i * 3 + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setAttribute('flux', new THREE.BufferAttribute(flux, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);

  const starMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    uniforms: {
      uViewHeight: { value: 1100 },
      uSizeScale: { value: 1.0 },
      uVisibility: { value: 1.0 },
      uIntensity: { value: 0.17 },
    },
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    // Same reasoning as the space pass: the sky has to be laid down before
    // anything solid, so it stays out of the transparent queue.
    transparent: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const points = new THREE.Points(geometry, starMaterial);
  points.frustumCulled = false;
  points.renderOrder = -2000;
  group.add(points);

  return {
    group, points, galaxy, starMaterial, galaxyMaterial,

    /**
     * How much of the star field survives the sky in front of it.
     *
     * (The absolute brightness is set to survive the orbital exposure, which is
     * about a stop and a half below the ground one.  Astronauts will tell you
     * that you cannot see stars at all while looking at a sunlit Earth, and
     * they are right, but a black sky with nothing in it is not what anyone
     * came here for.)
     *
     * A star's true radiance would put it several orders of magnitude below a
     * daylit sky, and several orders above what a headset panel can show at
     * night; there is no single scale that works for both.  So the brightness
     * is artistic, and this is the term that keeps the artistic value honest:
     * how much air is still above you, times how lit that air is.  On the
     * ground at four in the afternoon it is effectively zero.  Stars start
     * appearing around forty kilometres and are all there by eighty, which is
     * roughly where a real ascent hands them to you.
     */
    setSkyGlow(altitudeKm, sunElevationSine) {
      const airAbove = Math.exp(-Math.max(altitudeKm, 0) / 8.0);
      const lit = Math.min(Math.max(sunElevationSine + 0.12, 0), 1);
      const visibility = 1 / (1 + airAbove * lit * 400);
      starMaterial.uniforms.uVisibility.value = visibility;
      galaxyMaterial.uniforms.uVisibility.value = visibility;
      return visibility;
    },
  };
}

function equatorialUnit(ra, dec) {
  const cd = Math.cos(dec);
  return new THREE.Vector3(cd * Math.cos(ra), Math.sin(dec), cd * Math.sin(ra));
}
