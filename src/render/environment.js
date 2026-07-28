import * as THREE from 'three';
import { PLANET } from '../config.js';
import { GROUND_EXPOSURE } from './output.js';

/**
 * The uniforms every shader in the scene shares by reference: the atmosphere
 * tables, where the planet is, where the sun is, and how hard we are currently
 * willing to work.  Updating one object updates the sky, the terrain, the grass
 * and the trees together, which is the only way they stay in agreement about
 * what colour the air is.
 */
export function createSharedUniforms(luts) {
  return {
    uPlanetRadius: { value: PLANET.radius },
    uAtmosphereRadius: { value: PLANET.atmosphereTop },
    uTransmittanceLut: { value: luts.transmittance },
    uMultiScatterLut: { value: luts.multiScatter },
    uSkyIrradianceLut: { value: luts.skyIrradiance },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) }, // planet frame
    uSunIrradiance: { value: new THREE.Vector3(1.0, 0.985, 0.955) },
    uPlanetCentre: { value: new THREE.Vector3(0, -PLANET.radius, 0) }, // world frame
    uWorldToPlanet: { value: new THREE.Matrix3() },
    uSkySteps: { value: 28 },
    uExposure: { value: GROUND_EXPOSURE },
  };
}

/** GLSL every surface shader needs to place itself on the planet. */
export const WORLD_TO_PLANET_GLSL = /* glsl */ `
uniform vec3 uPlanetCentre;
uniform mat3 uWorldToPlanet;

vec3 worldToPlanetPoint(vec3 world) {
  return uWorldToPlanet * (world - uPlanetCentre);
}

vec3 worldToPlanetDir(vec3 world) {
  return uWorldToPlanet * world;
}
`;
