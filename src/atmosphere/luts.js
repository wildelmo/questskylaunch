import * as THREE from 'three';
import { PLANET } from '../config.js';
import { TRANSMITTANCE_FRAGMENT, MULTISCATTER_FRAGMENT, SKY_IRRADIANCE_FRAGMENT } from './glsl.js';

const FULLSCREEN_VERTEX = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// A single oversized triangle covers the target with no diagonal seam and no
// duplicated fragment work along it.
function fullscreenGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

function makeTarget(width, height) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

/**
 * Bakes the three tables the rest of the renderer reads: transmittance,
 * multiple scattering, and the irradiance the sky lays on the ground.  All
 * three depend only on the medium, so this runs exactly once, and together they
 * come to under 100 kB of texture.
 */
export function bakeAtmosphereLuts(renderer) {
  const transmittance = makeTarget(256, 64);
  const multiScatter = makeTarget(32, 32);
  const skyIrradiance = makeTarget(64, 32);

  const geometry = fullscreenGeometry();
  const camera = new THREE.Camera();
  const scene = new THREE.Scene();

  const shared = {
    uPlanetRadius: { value: PLANET.radius },
    uAtmosphereRadius: { value: PLANET.atmosphereTop },
  };

  const transmittanceMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: TRANSMITTANCE_FRAGMENT,
    uniforms: shared,
    depthTest: false,
    depthWrite: false,
  });

  const multiScatterMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: MULTISCATTER_FRAGMENT,
    uniforms: { ...shared, uTransmittanceLut: { value: transmittance.texture } },
    depthTest: false,
    depthWrite: false,
  });

  const skyIrradianceMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: SKY_IRRADIANCE_FRAGMENT,
    uniforms: {
      ...shared,
      uTransmittanceLut: { value: transmittance.texture },
      uMultiScatterLut: { value: multiScatter.texture },
    },
    depthTest: false,
    depthWrite: false,
  });

  const quad = new THREE.Mesh(geometry, transmittanceMaterial);
  quad.frustumCulled = false;
  scene.add(quad);

  const previousTarget = renderer.getRenderTarget();

  renderer.setRenderTarget(transmittance);
  renderer.render(scene, camera);

  quad.material = multiScatterMaterial;
  renderer.setRenderTarget(multiScatter);
  renderer.render(scene, camera);

  quad.material = skyIrradianceMaterial;
  renderer.setRenderTarget(skyIrradiance);
  renderer.render(scene, camera);

  renderer.setRenderTarget(previousTarget);

  geometry.dispose();
  transmittanceMaterial.dispose();
  multiScatterMaterial.dispose();
  skyIrradianceMaterial.dispose();

  return {
    transmittance: transmittance.texture,
    multiScatter: multiScatter.texture,
    skyIrradiance: skyIrradiance.texture,
    targets: { transmittance, multiScatter, skyIrradiance },
  };
}

/** Decodes an IEEE half float, for reading the baked tables back on the CPU. */
function halfToFloat(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}

/**
 * Reads one texel out of a baked table.  Used by tools/smoke.mjs to check the
 * absolute magnitudes: a sky-irradiance table that is off by a factor of ten
 * looks like "everything is a bit bright" rather than like a bug, so it needs
 * to be checked against a number rather than against an opinion.
 */
export function probeLut(renderer, target, x, y) {
  const buffer = new Uint16Array(4);
  renderer.readRenderTargetPixels(target, x, y, 1, 1, buffer);
  return [halfToFloat(buffer[0]), halfToFloat(buffer[1]), halfToFloat(buffer[2])];
}
