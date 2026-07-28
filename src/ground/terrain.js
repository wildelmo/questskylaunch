import * as THREE from 'three';
import { ATMOSPHERE_PARS, ATMOSPHERE_LOOKUPS, ATMOSPHERE_RAYMARCH } from '../atmosphere/glsl.js';
import { WORLD_TO_PLANET_GLSL } from '../render/environment.js';
import { HEIGHTFIELD_GLSL } from './heightfield.js';
import { OUTPUT_GLSL } from '../render/output.js';

// The ground is a polar mesh centred on you: rings of constant angular size, so
// vertex density falls off exactly as fast as it stops mattering.  It reaches
// 120 km, which is well past the 4.7 km horizon you have at eye height, and its
// outer edge relaxes into the sphere the space pass is already drawing — same
// height, same colour — so there is no rim to catch your eye when you climb
// high enough to see one.

export const TERRAIN_RADIUS = 120.0; // km
const RADIAL_STEPS = 128;
const ANGULAR_STEPS = 1024;
const INNER_RADIUS = 0.0006; // 60 cm

const MAX_ELEVATION = 8.85; // km, the range the packed elevation channel covers

export const TERRAIN_COMMON = /* glsl */ `
uniform sampler2D uSurface;
uniform sampler2D uAlbedo;
uniform float uDetailFade;      // invented detail: gone by ~25 km up
uniform float uReliefFade;      // real topography: gone by ~90 km up
uniform float uTerrainRadius;

const float MAX_ELEVATION = ${MAX_ELEVATION.toFixed(3)};

vec2 planetUv(vec3 dirPlanet) {
  return vec2(
    atan(-dirPlanet.z, dirPlanet.x) * (0.5 / PI) + 0.5,
    asin(clamp(dirPlanet.y, -1.0, 1.0)) / PI + 0.5
  );
}

// Direction from the planet centre to the point sitting offsetKm away from
// the launch site across the tangent plane.  Curvature falls out of the
// normalise, which is why the horizon drops as you climb without anyone having
// to fake it.
vec3 groundDirection(vec2 offsetKm) {
  vec3 world = vec3(offsetKm.x, uPlanetRadius, offsetKm.y);
  return normalize(uWorldToPlanet * world);
}

float realElevation(vec3 dirPlanet) {
  return texture(uSurface, planetUv(dirPlanet)).r * MAX_ELEVATION;
}

// How broken-up the real topography is here, which decides whether the invented
// detail behaves like a valley floor or like a mountainside.
float terrainRoughness(vec3 dirPlanet) {
  vec2 uv = planetUv(dirPlanet);
  vec2 t = vec2(1.0 / 4096.0, 1.0 / 2048.0);
  float hL = texture(uSurface, uv - vec2(t.x, 0.0)).r;
  float hR = texture(uSurface, uv + vec2(t.x, 0.0)).r;
  float hD = texture(uSurface, uv - vec2(0.0, t.y)).r;
  float hU = texture(uSurface, uv + vec2(0.0, t.y)).r;
  float grad = length(vec2(hR - hL, hU - hD)) * MAX_ELEVATION;
  return clamp(grad * 3.2, 0.04, 1.0);
}

float terrainHeight(vec2 offsetKm, out vec3 dirPlanet, out float roughness) {
  dirPlanet = groundDirection(offsetKm);
  roughness = terrainRoughness(dirPlanet);
  float base = realElevation(dirPlanet) * uReliefFade;
  float detail = terrainDetail(offsetKm, roughness) * (0.10 + 0.90 * roughness) * uDetailFade;
  // Everything the mesh adds relaxes to nothing at the rim, so its outer edge
  // is the analytic sphere to the millimetre.  The same two fades, driven by
  // altitude, let the whole mesh be switched off without a pop once it has
  // converged on what the space pass is already drawing.
  float rimFade = 1.0 - smoothstep(uTerrainRadius * 0.55, uTerrainRadius, length(offsetKm));
  return (base + detail) * rimFade;
}

// Wrapping a tangent-plane offset back onto the sphere is where planet-scale
// code quietly dies.  Writing it the obvious way --
//
//     planetCentre + normalize(x, R, z) * (R + height)
//
// -- is algebraically right and numerically hopeless: it builds a number near
// 6371 and then subtracts 6371 from it, and single-precision floats near 6371
// are half a metre apart.  The ground comes out terraced in half-metre
// plateaus and everything standing on it is buried or floating.
//
// The drop below the tangent plane is d^2/2R to first order.  What follows is
// that, exact to all orders, and it never forms an intermediate bigger than
// the distance actually travelled.
vec3 sphereWrap(vec2 offsetKm, float height) {
  float dd = dot(offsetKm, offsetKm);
  float q = sqrt(1.0 + dd / (uPlanetRadius * uPlanetRadius));
  float drop = -(dd / uPlanetRadius) / (q * (1.0 + q));
  vec2 xz = offsetKm * ((1.0 + height / uPlanetRadius) / q);
  return vec3(xz.x, drop + height / q, xz.y);
}

vec3 terrainPosition(vec2 offsetKm, out vec3 dirPlanet, out float height, out float roughness) {
  height = terrainHeight(offsetKm, dirPlanet, roughness);
  return sphereWrap(offsetKm, height);
}

// World point on the terrain surface directly above or below a tangent-plane
// offset.  Anything that stands on the ground calls this in its own vertex
// shader rather than being handed a height by the CPU: the elevation channel
// packs 8.85 km into 8 bits, so a single code value of disagreement between a
// canvas decode and a GL decode would bury a tree 35 metres deep.
vec3 terrainSurfacePoint(vec2 offsetKm) {
  vec3 dirPlanet;
  float roughness;
  float height = terrainHeight(offsetKm, dirPlanet, roughness);
  return sphereWrap(offsetKm, height);
}
`;

const VERTEX = /* glsl */ `
precision highp float;

${ATMOSPHERE_PARS}
${WORLD_TO_PLANET_GLSL}
${HEIGHTFIELD_GLSL}
${TERRAIN_COMMON}

out vec3 vWorldPosition;
out vec3 vNormal;
out vec3 vDirPlanet;
out float vHeight;
out float vRoughness;
out float vDistance;

void main() {
  // position.xy holds the polar sample: x is radius in km, y is the angle.
  float radius = position.x;
  float angle = position.y;
  vec2 offset = vec2(cos(angle), sin(angle)) * radius;

  vec3 dirPlanet;
  float height;
  float roughness;
  vec3 world = terrainPosition(offset, dirPlanet, height, roughness);

  // Central differences at a scale that tracks the local sample spacing, so
  // the normal describes the surface the mesh actually has.
  float eps = max(radius * 0.02, 0.0015);
  vec3 dummyDir;
  float dummyRough;
  float hx = terrainHeight(offset + vec2(eps, 0.0), dummyDir, dummyRough);
  float hz = terrainHeight(offset + vec2(0.0, eps), dummyDir, dummyRough);
  // Heights were sampled along world +x and +z, so the slope has to be resolved
  // against those same two directions projected onto the tangent plane.
  vec3 up = normalize(vec3(offset.x, uPlanetRadius, offset.y));
  vec3 tangentX = normalize(vec3(1.0, 0.0, 0.0) - up * up.x);
  vec3 tangentZ = normalize(vec3(0.0, 0.0, 1.0) - up * up.z);
  vNormal = normalize(up - tangentX * ((hx - height) / eps) - tangentZ * ((hz - height) / eps));

  vWorldPosition = world;
  vDirPlanet = dirPlanet;
  vHeight = height;
  vRoughness = roughness;
  vDistance = length(offset);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec3 vWorldPosition;
in vec3 vNormal;
in vec3 vDirPlanet;
in float vHeight;
in float vRoughness;
in float vDistance;

layout(location = 0) out vec4 fragColor;

${ATMOSPHERE_PARS}
${ATMOSPHERE_LOOKUPS}
${ATMOSPHERE_RAYMARCH}
${WORLD_TO_PLANET_GLSL}
${HEIGHTFIELD_GLSL}
${TERRAIN_COMMON}
${OUTPUT_GLSL}

uniform int uGroundSteps;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

float noise2(vec2 p, int octave) { return terrainValueNoise(p, octave); }

float fbm2(vec2 p, int octaves, int seed) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < octaves; i++) {
    s += a * noise2(p, seed + i);
    p *= 2.13;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 up = normalize(vWorldPosition - uPlanetCentre);
  float slope = 1.0 - clamp(dot(n, up), 0.0, 1.0);

  // --- fine normal detail -------------------------------------------------
  // Below the mesh's own resolution the surface is still not flat.  Two cheap
  // octaves of gradient, faded with distance so it never aliases.
  vec2 local = vWorldPosition.xz;
  float nearness = exp(-vDistance * 1.4) * uDetailFade;
  if (nearness > 0.004) {
    float e = 0.0009;
    float h0 = fbm2(local * 900.0, 3, 40);
    float hx = fbm2((local + vec2(e, 0.0)) * 900.0, 3, 40);
    float hz = fbm2((local + vec2(0.0, e)) * 900.0, 3, 40);
    vec3 tangentX = normalize(vec3(1.0, 0.0, 0.0) - up * up.x);
    vec3 tangentZ = normalize(vec3(0.0, 0.0, 1.0) - up * up.z);
    float k = 0.00035 * nearness;
    n = normalize(n - tangentX * ((hx - h0) * k / e) - tangentZ * ((hz - h0) * k / e));
  }

  // --- albedo -------------------------------------------------------------
  vec2 uv = planetUv(vDirPlanet);
  vec3 satellite = srgbToLinear(texture(uAlbedo, uv).rgb);
  vec4 surf = texture(uSurface, uv);
  float snowMask = surf.b;

  // Close in, break the 10 km-per-texel satellite colour with invented ground
  // cover, but keep it anchored to that colour so the two are the same thing at
  // the point they meet.
  float closeness = (1.0 - smoothstep(2.0, 30.0, vDistance)) * uDetailFade;
  vec3 albedo = satellite;
  if (closeness > 0.002) {
    // Frequencies are per kilometre, so anything you can see standing up needs
    // a coefficient in the thousands.  Field-sized patches, then metre-scale
    // clumping, then a centimetre grain that keeps the surface from reading as
    // a painted plane when your eyes are 1.7 m above it.
    float meadowPatch = fbm2(local * 0.9, 4, 70);
    float dust = fbm2(local * 3.4, 3, 110);
    float clump = fbm2(local * 240.0, 3, 90);
    float grain = fbm2(local * 2600.0, 2, 130);
    float fine = clump * 0.62 + grain * 0.38;

    vec3 dryGrass = vec3(0.196, 0.168, 0.086);
    vec3 greenGrass = vec3(0.078, 0.115, 0.045);
    vec3 soil = vec3(0.115, 0.082, 0.055);
    vec3 rock = vec3(0.135, 0.128, 0.118);

    // Fields, draws and bare patches, at the scale a field actually has them.
    float field = fbm2(local * 7.5, 3, 150);
    vec3 cover = mix(dryGrass, greenGrass, smoothstep(0.34, 0.70, meadowPatch * 0.55 + field * 0.45));
    cover = mix(cover, soil, smoothstep(0.52, 0.86, dust * 0.6 + field * 0.4) * 0.75);
    cover = mix(cover, rock, smoothstep(0.30, 0.72, slope));
    cover *= 0.55 + 0.90 * fine;

    // Snow above the line, and wherever the imagery says there already is some.
    float snowLine = smoothstep(2.1, 3.0, vHeight) * (1.0 - smoothstep(0.55, 0.85, slope));
    cover = mix(cover, vec3(0.70, 0.73, 0.78), clamp(max(snowLine, snowMask * 0.8), 0.0, 1.0));

    // Tie the overall level to what the satellite says this place looks like,
    // without flattening the variation just invented.  Dividing by this pixel's
    // own cover luminance would do exactly that -- it forces every pixel to the
    // satellite's brightness and the ground comes out a single uniform tone --
    // so the reference is the palette's mean instead.
    const float COVER_REFERENCE_LUMINANCE = 0.185;
    float satLum = dot(satellite, vec3(0.2126, 0.7152, 0.0722));
    cover *= clamp(satLum / COVER_REFERENCE_LUMINANCE, 0.55, 1.8);

    albedo = mix(satellite, cover, closeness);
  }

  // --- lighting -----------------------------------------------------------
  vec3 pPlanet = worldToPlanetPoint(vWorldPosition);
  vec3 nPlanet = worldToPlanetDir(n);
  float r = length(pPlanet);
  float muSun = dot(normalize(pPlanet), uSunDirection);

  vec3 sunTransmittance = transmittanceToSpace(r, muSun);
  float nDotL = max(dot(nPlanet, uSunDirection), 0.0);

  // A slope that faces away from the open sky sees less of it.
  float skyView = clamp(dot(n, up) * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambient = uSunIrradiance * skyIrradianceAt(r, muSun) * skyView;

  vec3 radiance = albedo * (1.0 / PI) * (uSunIrradiance * sunTransmittance * nDotL + ambient);

  // --- aerial perspective -------------------------------------------------
  vec3 toEye = cameraPosition - vWorldPosition;
  float dist = length(toEye);
  vec3 rdWorld = -toEye / max(dist, 1e-6);
  vec3 roPlanet = worldToPlanetPoint(cameraPosition);
  vec3 rdPlanet = worldToPlanetDir(rdWorld);

  vec3 transmittance;
  vec3 inScatter = atmosphereRayMarch(roPlanet, rdPlanet, dist, uGroundSteps, transmittance);
  vec3 colour = radiance * transmittance + inScatter;

  fragColor = encodeOutput(colour, 1.0);
}
`;

function buildPolarGeometry() {
  const vertexCount = (RADIAL_STEPS + 1) * ANGULAR_STEPS;
  const positions = new Float32Array(vertexCount * 3);

  const ratio = Math.pow(TERRAIN_RADIUS / INNER_RADIUS, 1 / RADIAL_STEPS);
  for (let i = 0; i <= RADIAL_STEPS; i++) {
    const radius = INNER_RADIUS * Math.pow(ratio, i);
    for (let j = 0; j < ANGULAR_STEPS; j++) {
      const index = (i * ANGULAR_STEPS + j) * 3;
      positions[index + 0] = radius;
      positions[index + 1] = (j / ANGULAR_STEPS) * Math.PI * 2;
      positions[index + 2] = 0;
    }
  }

  const indices = new Uint32Array(RADIAL_STEPS * ANGULAR_STEPS * 6);
  let k = 0;
  for (let i = 0; i < RADIAL_STEPS; i++) {
    for (let j = 0; j < ANGULAR_STEPS; j++) {
      const jNext = (j + 1) % ANGULAR_STEPS;
      const a = i * ANGULAR_STEPS + j;
      const b = i * ANGULAR_STEPS + jNext;
      const c = (i + 1) * ANGULAR_STEPS + j;
      const d = (i + 1) * ANGULAR_STEPS + jNext;
      // Wound so the geometric normal points away from the planet centre.  Get
      // this backwards and the entire terrain is back-face culled from above,
      // which does not look like a bug: the space pass keeps drawing its own
      // smooth 10-km-per-texel sphere in the same place, and you spend an
      // afternoon wondering why the ground has no detail.
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The vertex shader relocates every vertex, so the bounds have to be stated
  // rather than derived.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -TERRAIN_RADIUS, 0), TERRAIN_RADIUS * 2.2);
  return geometry;
}

export function createTerrain(textures, shared) {
  const uniforms = {
    ...shared,
    uSurface: { value: textures.surface },
    uAlbedo: { value: textures.albedo },
    uDetailFade: { value: 1.0 },
    uReliefFade: { value: 1.0 },
    uTerrainRadius: { value: TERRAIN_RADIUS },
    uGroundSteps: { value: 10 },
  };

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    side: THREE.FrontSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(buildPolarGeometry(), material);
  mesh.frustumCulled = false;
  mesh.name = 'terrain';
  mesh.renderOrder = 0;
  return { mesh, material, uniforms };
}

const PROBE_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${ATMOSPHERE_PARS}
${WORLD_TO_PLANET_GLSL}
${HEIGHTFIELD_GLSL}
${TERRAIN_COMMON}
void main() {
  vec3 dirPlanet;
  float roughness;
  fragColor = vec4(terrainHeight(vec2(0.0), dirPlanet, roughness), roughness, 0.0, 1.0);
}
`;

/**
 * Asks the GPU how high the ground is under the launch site, using the same
 * code path the terrain mesh uses.  One texel, read back once, and then the
 * rig can be placed on the surface instead of near it.
 */
export function probeTerrainHeight(renderer, uniforms) {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  );
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'precision highp float;\nin vec3 position;\nout vec2 vUv;\nvoid main(){vUv=position.xy*0.5+0.5;gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader: PROBE_FRAGMENT,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, new THREE.Camera());

  const pixel = new Uint16Array(4);
  renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
  renderer.setRenderTarget(previous);

  geometry.dispose();
  material.dispose();
  target.dispose();

  return halfToFloat(pixel[0]);
}

function halfToFloat(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}

export const TERRAIN_MAX_ELEVATION = MAX_ELEVATION;
