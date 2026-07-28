// Physically based atmosphere, following Hillaire's "A Scalable and Production
// Ready Sky and Atmosphere Rendering Technique" (EGSR 2020), which is itself a
// re-parameterisation of Bruneton & Neyret.  Two small look-up tables are baked
// once at start-up:
//
//   * transmittance   how much sunlight survives the trip from a point in the
//                     atmosphere out to space along a given direction
//   * multi-scatter   the energy that arrives at a point after bouncing around
//                     the medium more than once, which is what keeps the sky
//                     from going black at the horizon and puts the glow into
//                     the twilight limb
//
// Everything else is a single ray-march, evaluated per pixel, that works
// unchanged whether the camera is standing in a field or sitting 40,000 km out.

export const ATMOSPHERE_PARS = /* glsl */ `
#ifndef ATMOSPHERE_PARS
#define ATMOSPHERE_PARS

#define PI 3.14159265358979323846

uniform float uPlanetRadius;
uniform float uAtmosphereRadius;

// Scattering / absorption coefficients in 1/km at sea level.
const vec3  RAYLEIGH_SCATTER = vec3(5.802e-3, 13.558e-3, 33.100e-3);
const float RAYLEIGH_HEIGHT  = 8.0;
// A clear day rather than a continental-haze default: the standard 3.996e-3
// puts a permanent white wall along the horizon and floods every downward view
// from orbit.
const float MIE_SCATTER      = 2.600e-3;
const float MIE_EXTINCT      = 2.900e-3;
const float MIE_HEIGHT       = 1.2;
const float MIE_G            = 0.80;
// Ozone does not scatter at these wavelengths, it only absorbs, and it is what
// makes a clear zenith sky deep blue rather than washed out.
const vec3  OZONE_ABSORB     = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const float OZONE_CENTRE     = 25.0;
const float OZONE_WIDTH      = 15.0;

const float GROUND_ALBEDO    = 0.28;

void sampleMedium(float height, out vec3 scatterR, out float scatterM, out vec3 extinction) {
  float densityR = exp(-max(height, 0.0) / RAYLEIGH_HEIGHT);
  float densityM = exp(-max(height, 0.0) / MIE_HEIGHT);
  float densityO = max(0.0, 1.0 - abs(height - OZONE_CENTRE) / OZONE_WIDTH);
  scatterR = RAYLEIGH_SCATTER * densityR;
  scatterM = MIE_SCATTER * densityM;
  extinction = scatterR + vec3(MIE_EXTINCT * densityM) + OZONE_ABSORB * densityO;
}

float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

// Cornette-Shanks: cheaper than Henyey-Greenstein and better behaved at the
// forward peak, which is the only place anyone looks.
float miePhase(float cosTheta) {
  float g2 = MIE_G * MIE_G;
  float k = 3.0 / (8.0 * PI) * (1.0 - g2) / (2.0 + g2);
  float d = 1.0 + g2 - 2.0 * MIE_G * cosTheta;
  return k * (1.0 + cosTheta * cosTheta) / max(d * sqrt(d), 1e-4);
}

// Nearest positive intersection with a sphere centred on the origin, or -1.
float raySphereNear(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  float t0 = -b - s;
  float t1 = -b + s;
  if (t1 < 0.0) return -1.0;
  return t0 >= 0.0 ? t0 : t1;
}

// Both intersections, x <= y.  y < 0 means the sphere is entirely behind.
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(1.0, -1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

bool rayHitsGround(float r, float mu) {
  return mu < 0.0 && (r * r * (mu * mu - 1.0) + uPlanetRadius * uPlanetRadius) >= 0.0;
}

// --- transmittance LUT parameterisation -----------------------------------

vec2 transmittanceUv(float r, float mu) {
  float H = sqrt(max(uAtmosphereRadius * uAtmosphereRadius - uPlanetRadius * uPlanetRadius, 0.0));
  float rho = sqrt(max(r * r - uPlanetRadius * uPlanetRadius, 0.0));
  float disc = r * r * (mu * mu - 1.0) + uAtmosphereRadius * uAtmosphereRadius;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = uAtmosphereRadius - r;
  float dMax = rho + H;
  float xMu = (d - dMin) / max(dMax - dMin, 1e-6);
  float xR = rho / max(H, 1e-6);
  return vec2(clamp(xMu, 0.0, 1.0), clamp(xR, 0.0, 1.0));
}

void transmittanceRMu(vec2 uv, out float r, out float mu) {
  float H = sqrt(max(uAtmosphereRadius * uAtmosphereRadius - uPlanetRadius * uPlanetRadius, 0.0));
  float rho = H * uv.y;
  r = sqrt(rho * rho + uPlanetRadius * uPlanetRadius);
  float dMin = uAtmosphereRadius - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}

#endif
`;

// Shared by every pass that samples the baked tables.
export const ATMOSPHERE_LOOKUPS = /* glsl */ `
uniform sampler2D uTransmittanceLut;
uniform sampler2D uMultiScatterLut;
uniform sampler2D uSkyIrradianceLut;

vec3 transmittanceToSpace(float r, float mu) {
  return texture(uTransmittanceLut, transmittanceUv(r, mu)).rgb;
}

vec3 multiScatterAt(float r, float muSun) {
  float u = clamp(muSun * 0.5 + 0.5, 0.0, 1.0);
  float v = clamp((r - uPlanetRadius) / max(uAtmosphereRadius - uPlanetRadius, 1e-4), 0.0, 1.0);
  return texture(uMultiScatterLut, vec2(u, v)).rgb;
}

// Irradiance the sky alone lays on an upward-facing surface, for unit solar
// irradiance.  This is the term that decides what a shadow looks like, and
// guessing it -- as a multiple of the multiple-scattering table, say -- gets it
// wrong by more than an order of magnitude and washes the whole world out.
vec3 skyIrradianceAt(float r, float muSun) {
  float u = clamp(muSun * 0.5 + 0.5, 0.0, 1.0);
  float v = clamp((r - uPlanetRadius) / max(uAtmosphereRadius - uPlanetRadius, 1e-4), 0.0, 1.0);
  return texture(uSkyIrradianceLut, vec2(u, v)).rgb;
}
`;

// --- transmittance LUT ------------------------------------------------------

export const TRANSMITTANCE_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;

${ATMOSPHERE_PARS}

const int STEPS = 48;

void main() {
  float r, mu;
  transmittanceRMu(vUv, r, mu);

  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);

  vec2 atm = raySphere(ro, rd, uAtmosphereRadius);
  float tEnd = max(atm.y, 0.0);
  float ground = raySphereNear(ro, rd, uPlanetRadius);
  if (ground > 0.0) tEnd = min(tEnd, ground);

  float dt = tEnd / float(STEPS);
  vec3 opticalDepth = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * ((float(i) + 0.5) * dt);
    vec3 sr; float sm; vec3 ext;
    sampleMedium(length(p) - uPlanetRadius, sr, sm, ext);
    opticalDepth += ext * dt;
  }
  fragColor = vec4(exp(-opticalDepth), 1.0);
}
`;

// --- multiple scattering LUT -----------------------------------------------
//
// For a point at (r, muSun) we fire a small sphere of directions, integrate the
// single-scattered radiance along each and the fraction of light that gets
// handed on to the next order, then sum the resulting geometric series in
// closed form.  32x32 is plenty: the function is extremely smooth.

export const MULTISCATTER_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;

${ATMOSPHERE_PARS}

uniform sampler2D uTransmittanceLut;

vec3 transmittanceToSpace(float r, float mu) {
  return texture(uTransmittanceLut, transmittanceUv(r, mu)).rgb;
}

const int DIR_SQRT = 8;      // 8x8 = 64 directions
const int STEPS = 20;

void integrateDirection(vec3 ro, vec3 rd, vec3 sunDir, out vec3 lum, out vec3 fms) {
  lum = vec3(0.0);
  fms = vec3(0.0);

  vec2 atm = raySphere(ro, rd, uAtmosphereRadius);
  float tEnd = max(atm.y, 0.0);
  float ground = raySphereNear(ro, rd, uPlanetRadius);
  bool hitGround = ground > 0.0;
  if (hitGround) tEnd = min(tEnd, ground);
  if (tEnd <= 0.0) return;

  float dt = tEnd / float(STEPS);
  vec3 throughput = vec3(1.0);

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * ((float(i) + 0.5) * dt);
    float r = length(p);
    vec3 up = p / r;

    vec3 sr; float sm; vec3 ext;
    sampleMedium(r - uPlanetRadius, sr, sm, ext);
    vec3 scatter = sr + vec3(sm);
    ext = max(ext, vec3(1e-7));
    vec3 stepT = exp(-ext * dt);

    float muSun = dot(up, sunDir);
    float shadow = rayHitsGround(r, muSun) ? 0.0 : 1.0;
    vec3 sunT = transmittanceToSpace(r, muSun);

    // Fraction of the light reaching this point that is handed on to the next
    // scattering order.  No phase term: by definition it has been averaged out.
    fms += throughput * ((scatter - scatter * stepT) / ext);

    // Single-scattered radiance with an isotropic phase.
    vec3 s = shadow * sunT * scatter * (1.0 / (4.0 * PI));
    lum += throughput * ((s - s * stepT) / ext);

    throughput *= stepT;
  }

  if (hitGround) {
    vec3 hit = ro + rd * tEnd;
    vec3 n = normalize(hit);
    float muSun = dot(n, sunDir);
    if (muSun > 0.0) {
      vec3 sunT = transmittanceToSpace(uPlanetRadius, muSun);
      lum += throughput * sunT * muSun * (GROUND_ALBEDO / PI);
    }
  }
}

void main() {
  float muSun = clamp(vUv.x * 2.0 - 1.0, -1.0, 1.0);
  float r = mix(uPlanetRadius, uAtmosphereRadius, clamp(vUv.y, 0.0, 1.0));
  r = clamp(r, uPlanetRadius + 1e-3, uAtmosphereRadius - 1e-3);

  vec3 sunDir = vec3(sqrt(max(1.0 - muSun * muSun, 0.0)), muSun, 0.0);
  vec3 ro = vec3(0.0, r, 0.0);

  vec3 lumTotal = vec3(0.0);
  vec3 fmsTotal = vec3(0.0);
  float invN = 1.0 / float(DIR_SQRT * DIR_SQRT);

  for (int i = 0; i < DIR_SQRT; i++) {
    for (int j = 0; j < DIR_SQRT; j++) {
      // Uniform sphere sampling, offset to the centre of each cell.
      float u = (float(i) + 0.5) / float(DIR_SQRT);
      float v = (float(j) + 0.5) / float(DIR_SQRT);
      float cosT = 1.0 - 2.0 * u;
      float sinT = sqrt(max(1.0 - cosT * cosT, 0.0));
      float phi = 2.0 * PI * v;
      vec3 rd = vec3(sinT * cos(phi), cosT, sinT * sin(phi));

      vec3 lum, fms;
      integrateDirection(ro, rd, sunDir, lum, fms);
      // Uniform sphere sampling: the 4pi solid angle and the 1/4pi isotropic
      // phase cancel, leaving a plain average over directions.
      lumTotal += lum * invN;
      fmsTotal += fms * invN;
    }
  }

  // Sum of the infinite series of further scattering orders.
  vec3 psi = lumTotal / max(1.0 - fmsTotal, vec3(1e-4));
  fragColor = vec4(psi, 1.0);
}
`;

// --- the ray-march used by every visible pass -------------------------------
//
// atmosphereRayMarch returns in-scattered radiance and fills transmittance with
// the fraction of whatever lies beyond tMax that survives to the eye.
// Samples are packed toward the low point of the ray, which is where all the
// air is: standing in a field that means near the camera, from orbit it means
// the limb or the ground.

export const ATMOSPHERE_RAYMARCH = /* glsl */ `
uniform vec3 uSunDirection;
uniform vec3 uSunIrradiance;

float sampleWarp(float x, float towardEnd) {
  return mix(x * x, 1.0 - (1.0 - x) * (1.0 - x), towardEnd);
}

void marchSegment(
  vec3 ro, vec3 rd, float t0, float t1, float towardEnd, int steps,
  float phaseR, float phaseM,
  inout vec3 luminance, inout vec3 transmittance
) {
  if (t1 <= t0) return;
  float span = t1 - t0;
  float inv = 1.0 / float(steps);

  for (int i = 0; i < steps; i++) {
    float ua = sampleWarp(float(i) * inv, towardEnd);
    float ub = sampleWarp(float(i + 1) * inv, towardEnd);
    float ta = t0 + span * ua;
    float tb = t0 + span * ub;
    float ds = tb - ta;
    if (ds <= 0.0) continue;

    vec3 p = ro + rd * (0.5 * (ta + tb));
    float r = max(length(p), uPlanetRadius);
    vec3 up = p / r;

    vec3 sr; float sm; vec3 ext;
    sampleMedium(r - uPlanetRadius, sr, sm, ext);
    ext = max(ext, vec3(1e-9));
    vec3 stepT = exp(-ext * ds);

    float muSun = dot(up, uSunDirection);
    float shadow = rayHitsGround(r, muSun) ? 0.0 : 1.0;
    vec3 sunT = transmittanceToSpace(r, muSun);

    vec3 scatterR = sr;
    vec3 scatterM = vec3(sm);

    vec3 direct = shadow * sunT * (scatterR * phaseR + scatterM * phaseM);
    vec3 multi = multiScatterAt(r, muSun) * (scatterR + scatterM);
    vec3 s = uSunIrradiance * (direct + multi);

    vec3 integ = (s - s * stepT) / ext;
    luminance += transmittance * integ;
    transmittance *= stepT;
  }
}

// tMax: distance to whatever is behind the atmosphere (use a huge number for
// open sky).  Returns in-scattered radiance; transmittance comes back with
// the surviving fraction of the background.
vec3 atmosphereRayMarch(vec3 ro, vec3 rd, float tMax, int steps, out vec3 transmittance) {
  transmittance = vec3(1.0);
  vec3 luminance = vec3(0.0);

  vec2 atm = raySphere(ro, rd, uAtmosphereRadius);
  if (atm.y <= 0.0) return luminance;

  float tStart = max(atm.x, 0.0);
  float tEnd = min(tMax, atm.y);
  if (tEnd <= tStart) return luminance;

  float cosTheta = dot(rd, uSunDirection);
  float phaseR = rayleighPhase(cosTheta);
  float phaseM = miePhase(cosTheta);

  // Closest approach to the planet centre.  If it falls inside the marched
  // span the ray dips and climbs again, so split there and pack samples toward
  // the dip from both sides.
  float tPerigee = -dot(ro, rd);
  if (tPerigee > tStart && tPerigee < tEnd) {
    int half1 = max(steps / 2, 4);
    marchSegment(ro, rd, tStart, tPerigee, 1.0, half1, phaseR, phaseM, luminance, transmittance);
    marchSegment(ro, rd, tPerigee, tEnd, 0.0, max(steps - half1, 4), phaseR, phaseM, luminance, transmittance);
  } else {
    float hStart = length(ro + rd * tStart) - uPlanetRadius;
    float hEnd = length(ro + rd * tEnd) - uPlanetRadius;
    marchSegment(ro, rd, tStart, tEnd, hEnd < hStart ? 1.0 : 0.0, steps, phaseR, phaseM, luminance, transmittance);
  }

  return luminance;
}
`;

// --- sky irradiance LUT ----------------------------------------------------
//
// Fires a cosine-weighted hemisphere from a point and integrates the radiance
// arriving down each direction, single- plus multiple-scattered, with the real
// phase functions.  With cosine weighting the estimator is simply pi times the
// mean, and 64 directions is more than enough for something this smooth.

export const SKY_IRRADIANCE_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;

${ATMOSPHERE_PARS}

uniform sampler2D uTransmittanceLut;
uniform sampler2D uMultiScatterLut;

vec3 transmittanceToSpace(float r, float mu) {
  return texture(uTransmittanceLut, transmittanceUv(r, mu)).rgb;
}

vec3 multiScatterAt(float r, float muSun) {
  float u = clamp(muSun * 0.5 + 0.5, 0.0, 1.0);
  float v = clamp((r - uPlanetRadius) / max(uAtmosphereRadius - uPlanetRadius, 1e-4), 0.0, 1.0);
  return texture(uMultiScatterLut, vec2(u, v)).rgb;
}

const int SAMPLES = 64;
const int STEPS = 16;

vec3 radianceAlong(vec3 ro, vec3 rd, vec3 sunDir) {
  vec2 atm = raySphere(ro, rd, uAtmosphereRadius);
  float tEnd = max(atm.y, 0.0);
  float ground = raySphereNear(ro, rd, uPlanetRadius);
  if (ground > 0.0) tEnd = min(tEnd, ground);
  if (tEnd <= 0.0) return vec3(0.0);

  float cosTheta = dot(rd, sunDir);
  float phaseR = rayleighPhase(cosTheta);
  float phaseM = miePhase(cosTheta);

  float dt = tEnd / float(STEPS);
  vec3 transmittance = vec3(1.0);
  vec3 luminance = vec3(0.0);

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * ((float(i) + 0.5) * dt);
    float r = max(length(p), uPlanetRadius);
    vec3 up = p / r;

    vec3 sr; float sm; vec3 ext;
    sampleMedium(r - uPlanetRadius, sr, sm, ext);
    ext = max(ext, vec3(1e-9));
    vec3 stepT = exp(-ext * dt);

    float muSun = dot(up, sunDir);
    float shadow = rayHitsGround(r, muSun) ? 0.0 : 1.0;
    vec3 sunT = transmittanceToSpace(r, muSun);

    vec3 direct = shadow * sunT * (sr * phaseR + vec3(sm) * phaseM);
    vec3 multi = multiScatterAt(r, muSun) * (sr + vec3(sm));
    vec3 s = direct + multi;

    luminance += transmittance * ((s - s * stepT) / ext);
    transmittance *= stepT;
  }
  return luminance;
}

void main() {
  float muSun = clamp(vUv.x * 2.0 - 1.0, -1.0, 1.0);
  float r = mix(uPlanetRadius, uAtmosphereRadius, clamp(vUv.y, 0.0, 1.0));
  r = clamp(r, uPlanetRadius + 1e-3, uAtmosphereRadius - 1e-3);

  vec3 sunDir = vec3(sqrt(max(1.0 - muSun * muSun, 0.0)), muSun, 0.0);
  vec3 ro = vec3(0.0, r, 0.0);

  vec3 total = vec3(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    // Cosine-weighted hemisphere about +y, on a 8x8 stratified grid.
    float u1 = (float(i / 8) + 0.5) / 8.0;
    float u2 = (float(i - (i / 8) * 8) + 0.5) / 8.0;
    float radius = sqrt(u1);
    float phi = 2.0 * PI * u2;
    vec3 rd = vec3(radius * cos(phi), sqrt(max(1.0 - u1, 0.0)), radius * sin(phi));
    total += radianceAlong(ro, rd, sunDir);
  }

  // Cosine weighting turns the hemispherical integral into pi times the mean.
  fragColor = vec4(total * (PI / float(SAMPLES)), 1.0);
}
`;
