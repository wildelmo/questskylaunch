import * as THREE from 'three';
import { ATMOSPHERE_PARS, ATMOSPHERE_LOOKUPS, ATMOSPHERE_RAYMARCH } from '../atmosphere/glsl.js';
import { OUTPUT_GLSL } from '../render/output.js';

// One fullscreen triangle draws the entire planet and its air.  There is no
// Earth mesh: the sphere is intersected analytically, which means the horizon
// is a mathematically exact circle at every altitude — no silhouette faceting
// as it grows to fill your view, and no LOD popping on the way there.
//
// The pass is composited over the already-drawn star field with premultiplied
// alpha, where alpha is how much of the background the atmosphere swallows.

const VERTEX = /* glsl */ `
out vec3 vRayWorld;

void main() {
  gl_Position = vec4(position.xy, 1.0, 1.0);
  vec4 viewPos = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vRayWorld = mat3(inverse(viewMatrix)) * (viewPos.xyz / viewPos.w);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec3 vRayWorld;
layout(location = 0) out vec4 fragColor;

${ATMOSPHERE_PARS}
${ATMOSPHERE_LOOKUPS}
${ATMOSPHERE_RAYMARCH}
${OUTPUT_GLSL}

uniform vec3 uPlanetCentre;      // world space
uniform mat3 uWorldToPlanet;
uniform int  uSkySteps;

uniform sampler2D uAlbedo;
uniform sampler2D uNight;
uniform sampler2D uClouds;
uniform sampler2D uSurface;      // R elevation, G land, B snow/ice
uniform vec2  uAlbedoTexel;
uniform float uCloudHeight;
uniform float uNightIntensity;
uniform float uSurfaceDetail;    // faded out when the ground scene takes over

const float SUN_ANGULAR_RADIUS = 0.004654;   // radians

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

// Equirectangular lookup with hand-built gradients.  Taking dFdx of the raw
// longitude puts a band of maximally blurred texels down the anti-meridian,
// because atan wraps there; evaluating a second branch that is smooth exactly
// where the first is not, and keeping the smaller derivative, removes it.
vec2 dirToUv(vec3 n) {
  return vec2(atan(-n.z, n.x) * (0.5 / PI) + 0.5, asin(clamp(n.y, -1.0, 1.0)) / PI + 0.5);
}

vec4 sampleSphere(sampler2D tex, vec3 n) {
  vec2 uv = dirToUv(n);
  float uShift = atan(-n.z, -n.x) * (0.5 / PI) + 0.5;
  vec2 dx = vec2(min(abs(dFdx(uv.x)), abs(dFdx(uShift))), dFdx(uv.y));
  vec2 dy = vec2(min(abs(dFdy(uv.x)), abs(dFdy(uShift))), dFdy(uv.y));
  return textureGrad(tex, uv, dx, dy);
}

// Value noise, three octaves, used to put high-frequency life back into the
// albedo when you are close enough for 8k of equirectangular texture to look
// like a smear.
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

float fbm3(vec3 p) {
  return valueNoise(p) * 0.55 + valueNoise(p * 2.31) * 0.28 + valueNoise(p * 5.13) * 0.17;
}

float ggx(float nDotH, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-8);
}

// Cloud coverage where the ray crosses the deck, plus the shadow that deck
// casts on whatever is underneath it.
float cloudCoverAt(vec3 pointOnShell) {
  float c = sampleSphere(uClouds, normalize(pointOnShell)).r;
  return clamp(c, 0.0, 1.0);
}

vec3 shadeSurface(vec3 p, vec3 rd) {
  vec3 n = normalize(p);
  vec4 surf = sampleSphere(uSurface, n);
  float elevation = surf.r;
  float land = surf.g;
  float snow = surf.b;

  vec3 albedo = srgbToLinear(sampleSphere(uAlbedo, n).rgb);

  // --- perturb the normal with real topography ---------------------------
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float cosLat = max(cos(lat), 0.08);
  vec3 east = normalize(vec3(n.z, 0.0, -n.x) + vec3(1e-6, 0.0, 0.0));
  vec3 north = cross(n, east);
  vec2 t = uAlbedoTexel;
  vec2 uv = dirToUv(n);
  float hL = texture(uSurface, uv - vec2(t.x, 0.0)).r;
  float hR = texture(uSurface, uv + vec2(t.x, 0.0)).r;
  float hD = texture(uSurface, uv - vec2(0.0, t.y)).r;
  float hU = texture(uSurface, uv + vec2(0.0, t.y)).r;
  float spanX = 2.0 * PI * uPlanetRadius * t.x * cosLat;
  float spanY = PI * uPlanetRadius * t.y;
  float relief = 9.0 * land;
  vec3 nWorld = normalize(n
    - east * ((hR - hL) * relief / max(2.0 * spanX, 1e-4))
    - north * ((hU - hD) * relief / max(2.0 * spanY, 1e-4)));

  // --- close-range detail -------------------------------------------------
  // Sampled off the unit normal, not off the surface point.  A point on this
  // sphere has a magnitude of 6371, where a float32 has about a millimetre of
  // resolution per unit -- feed that to a lattice noise and the lattice
  // collapses into a handful of distinguishable values, which shows up as
  // enormous pastel blotches smeared across half the planet.
  if (uSurfaceDetail > 0.001) {
    float grain = fbm3(n * 26000.0) - 0.5;   // ~240 m features
    float coarse = fbm3(n * 3400.0) - 0.5;   // ~1.9 km features
    float amount = uSurfaceDetail * land;
    albedo *= 1.0 + (grain * 0.30 + coarse * 0.22) * amount;
    albedo = max(albedo, vec3(0.0));
  }

  float muSun = dot(n, uSunDirection);
  vec3 sunTransmittance = transmittanceToSpace(uPlanetRadius, muSun);
  float nDotL = max(dot(nWorld, uSunDirection), 0.0);

  // --- shadow of the cloud deck ------------------------------------------
  float shellRadius = uPlanetRadius + uCloudHeight;
  float toShell = raySphereNear(p + uSunDirection * 0.001, uSunDirection, shellRadius);
  float shadow = 1.0;
  if (toShell > 0.0) {
    float cover = cloudCoverAt(p + uSunDirection * toShell);
    shadow = 1.0 - cover * 0.72;
  }

  // --- direct + ambient ---------------------------------------------------
  vec3 direct = uSunIrradiance * sunTransmittance * nDotL * shadow;
  vec3 ambient = uSunIrradiance * skyIrradianceAt(uPlanetRadius, muSun);

  vec3 material = albedo;
  material = mix(material, material * vec3(0.96, 0.98, 1.06), snow * 0.5);
  vec3 radiance = material * (1.0 / PI) * (direct + ambient);

  // --- sun glint off water ------------------------------------------------
  float water = 1.0 - land;
  if (water > 0.01) {
    vec3 h = normalize(uSunDirection - rd);
    // Sun glint off the sea is a glitter path tens of degrees wide, not a
    // mirror: it is the statistics of a million wave facets, so the lobe has to
    // be broad or it collapses into a white sticker.  Wind roughens it further
    // toward the poles, and a slow modulation keeps the path from reading as a
    // painted-on ellipse.
    float wind = 0.11 + 0.09 * clamp(abs(n.y), 0.0, 1.0);
    float roughness = wind * (0.85 + 0.30 * fbm3(n * 40.0));
    float spec = ggx(max(dot(nWorld, h), 0.0), roughness);
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-rd, nWorld), 0.0), 5.0);
    radiance += uSunIrradiance * sunTransmittance * spec * fresnel * water * nDotL * shadow * 0.055;
  }

  // --- night side ---------------------------------------------------------
  float night = 1.0 - smoothstep(-0.14, 0.10, muSun);
  if (night > 0.0) {
    vec3 lights = srgbToLinear(sampleSphere(uNight, n).rgb);
    radiance += lights * night * uNightIntensity;
    // Nothing on Earth is truly black from orbit; there is always starlight
    // and airglow on the terrain.
    radiance += material * night * vec3(0.00035, 0.00042, 0.00068);
  }

  return radiance;
}

vec3 shadeClouds(vec3 pShell, vec3 rd, out float alpha) {
  vec3 n = normalize(pShell);
  float cover = cloudCoverAt(pShell);
  // Break up the source composite's soft edges so the deck reads as weather
  // rather than as a texture.
  float detail = fbm3(n * 260.0) * 0.62 + fbm3(n * 900.0) * 0.38;
  cover = clamp(cover * (0.78 + detail * 0.44) + (detail - 0.5) * 0.08, 0.0, 1.0);
  alpha = smoothstep(0.12, 0.66, cover);

  float muSun = dot(n, uSunDirection);
  vec3 sunT = transmittanceToSpace(uPlanetRadius + uCloudHeight, muSun);
  // Thick water cloud: strongly forward scattering, and lit well past the
  // geometric terminator because light wraps through the droplets.
  float wrap = clamp((muSun + 0.22) / 1.22, 0.0, 1.0);
  float lit = pow(wrap, 0.75);
  float forward = 0.55 + 0.45 * pow(max(dot(rd, uSunDirection), 0.0), 6.0);

  // A cloud top sees the sky above it and the bright deck around it, so its
  // ambient is generous compared with the ground's.
  vec3 ambient = uSunIrradiance * skyIrradianceAt(uPlanetRadius + uCloudHeight, muSun);
  vec3 colour = uSunIrradiance * sunT * lit * forward * 0.62 + ambient * 0.75;

  // Seen from underneath, a deck is its own shadow: the sunlit face is the one
  // you cannot see, and what reaches you has been through the whole thickness.
  float fromBelow = clamp(dot(n, rd), 0.0, 1.0);
  colour *= mix(1.0, 0.34, fromBelow);

  float night = 1.0 - smoothstep(-0.16, 0.06, muSun);
  colour += vec3(0.00025, 0.00030, 0.00048) * night;
  return colour;
}

void main() {
  vec3 rdWorld = normalize(vRayWorld);
  vec3 ro = uWorldToPlanet * (cameraPosition - uPlanetCentre);
  vec3 rd = uWorldToPlanet * rdWorld;

  float tGround = raySphereNear(ro, rd, uPlanetRadius);
  float shellRadius = uPlanetRadius + uCloudHeight;

  vec3 background = vec3(0.0);
  float backgroundAlpha = 0.0;
  float tMax = 1.0e9;

  if (tGround > 0.0) {
    tMax = tGround;
    background = shadeSurface(ro + rd * tGround, rd);
    backgroundAlpha = 1.0;

    // Composite the cloud deck where the ray pierces it on the way down.
    float tShell = raySphereNear(ro, rd, shellRadius);
    if (tShell > 0.0 && tShell < tGround) {
      float cloudAlpha;
      vec3 cloud = shadeClouds(ro + rd * tShell, rd, cloudAlpha);
      background = mix(background, cloud, cloudAlpha);
    }
  } else {
    // Looking past the planet: the sun, and anything the star pass drew.
    float cosSun = dot(rd, uSunDirection);
    if (cosSun > cos(SUN_ANGULAR_RADIUS * 1.6)) {
      float edge = acos(clamp(cosSun, -1.0, 1.0)) / SUN_ANGULAR_RADIUS;
      float disc = 1.0 - smoothstep(0.985, 1.02, edge);
      // Limb darkening, so the disc is not a flat white sticker.
      float mu = sqrt(max(1.0 - min(edge, 1.0) * min(edge, 1.0), 0.0));
      float limb = 0.34 + 0.66 * mu;
      // Radiance = irradiance / solid angle of the disc.
      float solidAngle = PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS;
      background += uSunIrradiance * (disc * limb / solidAngle);
      backgroundAlpha = max(backgroundAlpha, disc);
    }

    // A cloud deck seen against space still needs drawing when the ray grazes
    // the limb without reaching the ground.
    float tShell = raySphereNear(ro, rd, shellRadius);
    if (tShell > 0.0) {
      float cloudAlpha;
      vec3 cloud = shadeClouds(ro + rd * tShell, rd, cloudAlpha);
      // Grazing rays skim a long way through the deck, so it thickens.
      vec3 shellN = normalize(ro + rd * tShell);
      float graze = 1.0 - abs(dot(shellN, rd));
      cloudAlpha = clamp(cloudAlpha * (1.0 + graze * 0.7), 0.0, 1.0);
      background = mix(background, cloud, cloudAlpha);
      backgroundAlpha = max(backgroundAlpha, cloudAlpha);
    }
  }

  vec3 transmittance;
  vec3 inScatter = atmosphereRayMarch(ro, rd, tMax, uSkySteps, transmittance);

  vec3 colour = background * transmittance + inScatter;

  // Alpha is how much of the star field this pixel hides.  Opaque where the
  // planet is, near zero out in vacuum, partial through the twilight limb.
  float extinction = 1.0 - dot(transmittance, vec3(0.2126, 0.7152, 0.0722));
  float alpha = clamp(max(backgroundAlpha, extinction), 0.0, 1.0);

  fragColor = encodeOutput(colour, alpha);
}
`;

export function createSpacePass(textures, shared) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  );

  const uniforms = {
    ...shared,
    uAlbedo: { value: textures.albedo },
    uNight: { value: textures.night },
    uClouds: { value: textures.clouds },
    uSurface: { value: textures.surface },
    uAlbedoTexel: { value: new THREE.Vector2(1 / 4096, 1 / 2048) },
    uCloudHeight: { value: 9.0 },
    uNightIntensity: { value: 0.0055 },
    uSurfaceDetail: { value: 0.0 },
  };

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    depthTest: false,
    depthWrite: false,
    // Deliberately NOT `transparent`.  Three puts transparent materials in a
    // queue that runs after every opaque object, and this pass has to run
    // before them: it is the backdrop the terrain stands in front of, not a
    // pane of glass held up in front of the terrain.  Blending is applied from
    // `blending` regardless of which queue the material lands in.
    transparent: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'spacePass';
  return { mesh, material, uniforms };
}
