import * as THREE from 'three';
import { ATMOSPHERE_PARS, ATMOSPHERE_LOOKUPS, ATMOSPHERE_RAYMARCH } from '../atmosphere/glsl.js';
import { WORLD_TO_PLANET_GLSL } from '../render/environment.js';
import { OUTPUT_GLSL } from '../render/output.js';
import { HEIGHTFIELD_GLSL } from './heightfield.js';
import { TERRAIN_COMMON } from './terrain.js';

// Everything standing on the ground: grass at your feet, oaks out to a couple of
// kilometres, and a handful of built things whose size you already know.
//
// Nothing here is told how high the ground is.  Each vertex shader evaluates
// the same terrain height function the ground mesh uses, from the same texture,
// so a blade of grass and the surface under it cannot disagree.  (They can, if
// you let the CPU decide: the elevation channel packs 8.85 km into eight bits,
// so one code value of decoder drift is a 35 metre hole.)
//
// The buildings and the power line are not decoration.  Until there is
// something in view whose real dimensions you can recall, "a hundred metres up"
// and "a thousand metres up" look identical, and the first half-minute of the
// ascent does nothing.  A barn roof and a line of poles fix the scale, and then
// watching them shrink is the whole point.

// Shared by every prop's vertex shader.
const STAND_ON_GROUND = /* glsl */ `
${ATMOSPHERE_PARS}
${WORLD_TO_PLANET_GLSL}
${HEIGHTFIELD_GLSL}
${TERRAIN_COMMON}

// Move a point that was authored with its base at y = 0 onto the terrain at
// the given tangent-plane anchor.
vec3 placeOnGround(vec3 local, vec2 anchorKm) {
  return terrainSurfacePoint(anchorKm) + local;
}
`;

const LIT_PARS = /* glsl */ `
${ATMOSPHERE_PARS}
${ATMOSPHERE_LOOKUPS}
${ATMOSPHERE_RAYMARCH}
${WORLD_TO_PLANET_GLSL}

uniform int uAirSteps;

// Sun + sky on a surface, then whatever the air between here and the eye does
// to it.  Shared by every solid object so nothing looks pasted on.
vec3 shadeLit(vec3 worldPosition, vec3 worldNormal, vec3 albedo, float skyView, float translucency) {
  vec3 pPlanet = worldToPlanetPoint(worldPosition);
  vec3 nPlanet = worldToPlanetDir(worldNormal);
  float r = length(pPlanet);
  float muSun = dot(normalize(pPlanet), uSunDirection);

  vec3 sunTransmittance = transmittanceToSpace(r, muSun);
  float nDotL = max(dot(nPlanet, uSunDirection), 0.0);
  // Thin things -- leaves, grass -- glow when the sun is behind them.
  float back = max(-dot(nPlanet, uSunDirection), 0.0) * translucency;

  vec3 ambient = uSunIrradiance * skyIrradianceAt(r, muSun) * skyView;
  vec3 radiance = albedo * (1.0 / PI) * (uSunIrradiance * sunTransmittance * (nDotL + back) + ambient);

  vec3 toEye = cameraPosition - worldPosition;
  float dist = length(toEye);
  vec3 rdWorld = -toEye / max(dist, 1e-7);
  vec3 transmittance;
  vec3 inScatter = atmosphereRayMarch(
    worldToPlanetPoint(cameraPosition), worldToPlanetDir(rdWorld), dist, uAirSteps, transmittance);
  return radiance * transmittance + inScatter;
}
`;

// --------------------------------------------------------------------------
// grass
// --------------------------------------------------------------------------

const GRASS_VERTEX = /* glsl */ `
precision highp float;
${STAND_ON_GROUND}

uniform float uTime;
uniform float uFade;
uniform float uBladeHeight;

out vec3 vWorldPosition;
out vec3 vNormal;
out vec3 vTint;
out float vAlongBlade;

void main() {
  float along = position.y / uBladeHeight;   // 0 at the root, 1 at the tip
  vec2 anchor = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  vec3 offset = vec3(anchor.x, 0.0, anchor.y);

  // Wind: a travelling wave plus a slower gust envelope, both driven off the
  // blade's own position so neighbours move together but not in lockstep.
  float phase = dot(offset.xz, vec2(41.0, 27.0)) + uTime * 1.6;
  float gust = 0.55 + 0.45 * sin(dot(offset.xz, vec2(2.3, 1.7)) * 0.6 + uTime * 0.42);
  float sway = (sin(phase) * 0.5 + sin(phase * 2.31) * 0.25) * gust;
  float bend = sway * along * along * 0.00016;   // 16 cm at the tip, in km

  // Fade by shrinking each blade about its own root, so the sward sinks into
  // the ground instead of popping out of existence.
  vec3 local = position * uFade;
  local.x += bend;
  local.z += bend * 0.35;
  local.y -= abs(bend) * 0.25;      // a bent blade is a shorter blade

  // Instance translation is only an anchor; the height comes from the terrain.
  vec3 rotated = (instanceMatrix * vec4(local, 1.0)).xyz - vec3(anchor.x, instanceMatrix[3][1], anchor.y);
  vec3 world = placeOnGround(rotated, anchor);

  vNormal = normalize((instanceMatrix * vec4(normal, 0.0)).xyz);
  vWorldPosition = world;
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #else
    vTint = vec3(0.1, 0.12, 0.04);
  #endif
  vAlongBlade = along;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

// Grass never gets further away than the far side of a small garden, so it
// skips the aerial-perspective march entirely: over twenty metres the air does
// nothing a fragment shader could show you.
const GRASS_FRAGMENT = /* glsl */ `
precision highp float;
in vec3 vWorldPosition;
in vec3 vNormal;
in vec3 vTint;
in float vAlongBlade;
layout(location = 0) out vec4 fragColor;

${ATMOSPHERE_PARS}
${ATMOSPHERE_LOOKUPS}
${WORLD_TO_PLANET_GLSL}
${OUTPUT_GLSL}
uniform vec3 uSunDirection;
uniform vec3 uSunIrradiance;

vec3 shadeBlade(vec3 worldPosition, vec3 worldNormal, vec3 albedo, float skyView, float translucency) {
  vec3 pPlanet = worldToPlanetPoint(worldPosition);
  vec3 nPlanet = worldToPlanetDir(worldNormal);
  float r = length(pPlanet);
  float muSun = dot(normalize(pPlanet), uSunDirection);
  vec3 sunTransmittance = transmittanceToSpace(r, muSun);
  float nDotL = max(dot(nPlanet, uSunDirection), 0.0);
  float back = max(-dot(nPlanet, uSunDirection), 0.0) * translucency;
  vec3 ambient = uSunIrradiance * skyIrradianceAt(r, muSun) * skyView;
  return albedo * (1.0 / PI) * (uSunIrradiance * sunTransmittance * (nDotL + back) + ambient);
}

void main() {
  // Blades are double sided; flip the normal so both faces light correctly.
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;

  // Darker and less sky-lit at the root, where the surrounding sward shades it.
  float occlusion = mix(0.28, 1.0, vAlongBlade);
  vec3 albedo = vTint * mix(0.45, 1.0, vAlongBlade);

  fragColor = encodeOutput(shadeBlade(vWorldPosition, n, albedo, occlusion, 0.55), 1.0);
}
`;

const BLADE_HEIGHT = 0.00040; // km == 40 cm

function bladeGeometry() {
  // Four segments tapering to a point: five triangles per blade, which is the
  // least that still bends convincingly.
  const segments = 4;
  const height = BLADE_HEIGHT;
  const halfWidth = 0.0000105; // 10.5 mm across
  const positions = [];
  const normals = [];
  const indices = [];

  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const w = halfWidth * (1 - t * t);
    positions.push(-w, t, 0, w, t, 0);
    normals.push(0, 0, 1, 0, 0, 1);
  }
  positions.push(0, 1, 0);
  normals.push(0, 0, 1);

  for (let i = 0; i < segments - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const last = (segments - 1) * 2;
  indices.push(last, segments * 2, last + 1);

  const geometry = new THREE.BufferGeometry();
  const scaled = positions.map((v, i) => (i % 3 === 1 ? v * height : v));
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(scaled, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

// Real grass runs to thousands of blades per square metre, which no headset is
// going to draw.  What sells it instead is density where you are actually
// looking -- straight down and a few metres out -- so the blades are packed
// into a fourteen-metre disc at about forty per square metre and the terrain
// shader carries the texture from there outward.
const GRASS_RADIUS = 0.014; // km
const GRASS_COUNT = 24000;

function createGrass(shared, terrainUniforms, random) {
  const geometry = bladeGeometry();
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: GRASS_VERTEX,
    fragmentShader: GRASS_FRAGMENT,
    uniforms: {
      ...shared, ...terrainUniforms,
      uTime: { value: 0 },
      uFade: { value: 1 },
      uBladeHeight: { value: BLADE_HEIGHT },
    },
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, GRASS_COUNT);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(GRASS_COUNT * 3), 3);
  mesh.frustumCulled = false;
  mesh.name = 'grass';

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  const colour = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < GRASS_COUNT; i++) {
    // Square root of a uniform gives a uniform areal density.
    const radius = Math.sqrt(random()) * GRASS_RADIUS;
    const angle = random() * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    // y is an anchor only; the vertex shader puts the blade on the ground.
    position.set(x, 0, z);
    // Lean each blade off vertical, then spin it about its own root.
    const lean = (random() - 0.5) * 0.55;
    const leanAxis = new THREE.Vector3(Math.cos(random() * Math.PI * 2), 0, Math.sin(random() * Math.PI * 2));
    quaternion.setFromAxisAngle(leanAxis, lean);
    const spin = new THREE.Quaternion().setFromAxisAngle(up, random() * Math.PI * 2);
    quaternion.multiply(spin);

    const size = 0.55 + random() * 0.95;
    scale.set(0.7 + random() * 0.9, size, 1);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);

    // Sun-bleached tips over green roots; the valley is dry in late June.
    const dryness = random();
    colour.setRGB(
      0.085 + dryness * 0.135,
      0.105 + dryness * 0.085,
      0.030 + dryness * 0.032
    );
    mesh.instanceColor.setXYZ(i, colour.r, colour.g, colour.b);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;

  return { mesh, material };
}

// --------------------------------------------------------------------------
// solid props: trees, buildings, poles
// --------------------------------------------------------------------------

const SOLID_VERTEX = /* glsl */ `
precision highp float;
${STAND_ON_GROUND}

out vec3 vWorldPosition;
out vec3 vNormal;
out vec3 vTint;

#ifndef USE_INSTANCING
  in vec2 aAnchor;
#endif

void main() {
  vec3 world;
  #ifdef USE_INSTANCING
    vec2 anchor = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
    vec3 rotated = (instanceMatrix * vec4(position, 1.0)).xyz
                 - vec3(anchor.x, instanceMatrix[3][1], anchor.y);
    world = placeOnGround(rotated, anchor);
    vNormal = normalize(mat3(instanceMatrix) * normal);
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor * color;
    #else
      vTint = color;
    #endif
  #else
    world = placeOnGround(position - vec3(aAnchor.x, 0.0, aAnchor.y), aAnchor);
    vNormal = normalize(normal);
    vTint = color;
  #endif
  vWorldPosition = world;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const SOLID_FRAGMENT = /* glsl */ `
precision highp float;
in vec3 vWorldPosition;
in vec3 vNormal;
in vec3 vTint;
layout(location = 0) out vec4 fragColor;

${LIT_PARS}
${OUTPUT_GLSL}

uniform float uTranslucency;

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 up = normalize(vWorldPosition - uPlanetCentre);
  float skyView = clamp(dot(n, up) * 0.5 + 0.5, 0.15, 1.0);
  fragColor = encodeOutput(shadeLit(vWorldPosition, n, vTint, skyView, uTranslucency), 1.0);
}
`;

function solidMaterial(shared, terrainUniforms, translucency, airSteps) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SOLID_VERTEX,
    fragmentShader: SOLID_FRAGMENT,
    uniforms: {
      ...shared, ...terrainUniforms,
      uTranslucency: { value: translucency },
      uAirSteps: { value: airSteps },
    },
    side: THREE.DoubleSide,
    vertexColors: true,
    toneMapped: false,
  });
}

/** A valley oak: short trunk, wide irregular crown. */
function oakGeometry(detail) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.00022, 0.00040, 0.0042, detail > 0 ? 6 : 4, 1);
  trunk.translate(0, 0.0021, 0);
  parts.push({ geometry: trunk, colour: new THREE.Color(0.055, 0.042, 0.032) });

  const blobs = detail > 0
    ? [
        { x: 0, y: 0.0072, z: 0, r: 0.0044 },
        { x: 0.0026, y: 0.0058, z: 0.0014, r: 0.0031 },
        { x: -0.0022, y: 0.0060, z: -0.0018, r: 0.0029 },
        { x: 0.0006, y: 0.0092, z: -0.0022, r: 0.0026 },
      ]
    : [{ x: 0, y: 0.0070, z: 0, r: 0.0050 }];

  for (const b of blobs) {
    const g = new THREE.IcosahedronGeometry(b.r, detail > 0 ? 1 : 0);
    g.scale(1.15, 0.78, 1.15);
    g.translate(b.x, b.y, b.z);
    parts.push({ geometry: g, colour: new THREE.Color(0.052, 0.070, 0.028) });
  }
  return mergeWithColours(parts);
}

function mergeWithColours(parts) {
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const part of parts) {
    vertexTotal += part.geometry.attributes.position.count;
    indexTotal += part.geometry.index ? part.geometry.index.count : part.geometry.attributes.position.count;
  }

  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const colours = new Float32Array(vertexTotal * 3);
  const anchors = new Float32Array(vertexTotal * 2);
  const indices = new Uint32Array(indexTotal);

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    const g = part.geometry;
    if (!g.attributes.normal) g.computeVertexNormals();
    const count = g.attributes.position.count;
    positions.set(g.attributes.position.array, vertexOffset * 3);
    normals.set(g.attributes.normal.array, vertexOffset * 3);
    const anchor = part.anchor || [0, 0];
    for (let i = 0; i < count; i++) {
      colours[(vertexOffset + i) * 3 + 0] = part.colour.r;
      colours[(vertexOffset + i) * 3 + 1] = part.colour.g;
      colours[(vertexOffset + i) * 3 + 2] = part.colour.b;
      anchors[(vertexOffset + i) * 2 + 0] = anchor[0];
      anchors[(vertexOffset + i) * 2 + 1] = anchor[1];
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices[indexOffset + i] = g.index.array[i] + vertexOffset;
      indexOffset += g.index.count;
    } else {
      for (let i = 0; i < count; i++) indices[indexOffset + i] = vertexOffset + i;
      indexOffset += count;
    }
    vertexOffset += count;
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  merged.setAttribute('aAnchor', new THREE.BufferAttribute(anchors, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return merged;
}

function createTrees(shared, terrainUniforms, random, { detail, count, minRadius, maxRadius }) {
  const geometry = oakGeometry(detail);
  const material = solidMaterial(shared, terrainUniforms, 0.35, detail > 0 ? 5 : 4);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.frustumCulled = false;
  mesh.name = `trees-lod${detail}`;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 40) {
    attempts++;
    const radius = Math.sqrt(random()) * (maxRadius - minRadius) + minRadius;
    const angle = random() * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    // Oak savanna clumps rather than an even sprinkle: accept against a smooth
    // density field so the trees gather in draws and thin out on the ridges.
    const clump = clusterField(x, z);
    if (random() > clump) continue;

    position.set(x, 0, z);
    quaternion.setFromAxisAngle(up, random() * Math.PI * 2);
    // A stand of oaks is mostly saplings and a few old ones, so bias the size
    // distribution rather than spreading it evenly: a row of identical trees is
    // the fastest way to make a landscape look manufactured.
    const roll = random();
    const size = 0.42 + roll * roll * 1.55;
    scale.set(size * (0.72 + random() * 0.55), size * (0.8 + random() * 0.45), size * (0.72 + random() * 0.55));
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(placed, matrix);

    const shade = 0.72 + random() * 0.55;
    mesh.instanceColor.setXYZ(placed, shade, shade * (0.94 + random() * 0.12), shade * 0.9);
    placed++;
  }
  // Park any unplaced instances far below the surface rather than piling them
  // on top of each other at the origin.
  matrix.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(1e-6, 1e-6, 1e-6));
  for (let i = placed; i < count; i++) mesh.setMatrixAt(i, matrix);

  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return { mesh, material, placed };
}

function clusterField(x, z) {
  const a = Math.sin(x * 41.3 + z * 17.7) * Math.cos(x * 9.1 - z * 27.3);
  const b = Math.sin(x * 103.0 - z * 71.0) * 0.5;
  return Math.min(Math.max(0.34 + a * 0.42 + b * 0.2, 0.02), 0.95);
}

/** Farm buildings and a power line: the things whose size you already know. */
function createStructures(shared, terrainUniforms) {
  const parts = [];
  const timber = new THREE.Color(0.185, 0.150, 0.120);
  const paint = new THREE.Color(0.240, 0.085, 0.062);
  const roof = new THREE.Color(0.115, 0.118, 0.122);
  const pole = new THREE.Color(0.075, 0.058, 0.044);

  // Everything is authored with its base at y = 0 and carries the tangent-plane
  // anchor it should be planted at; the vertex shader does the rest.
  function addBuilding(x, z, width, depth, wallHeight, rotation, wallColour) {
    const walls = new THREE.BoxGeometry(width, wallHeight, depth);
    walls.rotateY(rotation);
    walls.translate(x, wallHeight / 2, z);
    parts.push({ geometry: walls, colour: wallColour, anchor: [x, z] });

    // Gable roof from a three-sided prism: cheap, and right in silhouette.
    const g = new THREE.CylinderGeometry(depth * 0.62, depth * 0.62, width * 1.06, 3, 1);
    g.rotateZ(Math.PI / 2);   // lay the prism along x, spanning the building
    g.rotateX(-Math.PI / 2);  // put the ridge at the top rather than the side
    g.rotateY(rotation);
    g.translate(x, wallHeight + depth * 0.18, z);
    parts.push({ geometry: g, colour: roof, anchor: [x, z] });
  }

  // A barn, a farmhouse and a couple of outbuildings, 180 to 700 m out.
  addBuilding(0.21, -0.32, 0.024, 0.013, 0.0072, 0.35, paint);
  addBuilding(0.26, -0.29, 0.011, 0.009, 0.0042, 0.35, timber);
  addBuilding(-0.44, -0.58, 0.019, 0.012, 0.0058, -0.9, timber);
  addBuilding(0.62, -0.21, 0.016, 0.010, 0.0050, 1.4, paint);
  addBuilding(-0.17, -0.74, 0.013, 0.010, 0.0044, 0.2, timber);

  // A line of poles marching away toward the valley: nothing reads distance
  // like a repeated object of known size.
  for (let i = 0; i < 26; i++) {
    const t = i;
    const x = -0.055 - t * 0.0415;
    const z = -0.06 - t * 0.0605;
    const height = 0.0098;
    const shaft = new THREE.CylinderGeometry(0.00016, 0.00022, height, 5, 1);
    shaft.translate(x, height / 2, z);
    parts.push({ geometry: shaft, colour: pole, anchor: [x, z] });
    const arm = new THREE.BoxGeometry(0.0034, 0.00022, 0.00022);
    arm.rotateY(0.97);
    arm.translate(x, height * 0.93, z);
    parts.push({ geometry: arm, colour: pole, anchor: [x, z] });
  }

  const geometry = mergeWithColours(parts);
  const material = solidMaterial(shared, terrainUniforms, 0.0, 6);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = 'structures';
  return { mesh, material };
}

// --------------------------------------------------------------------------

function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createGroundProps(shared, terrainUniforms) {
  const group = new THREE.Group();
  group.name = 'groundProps';

  const grass = createGrass(shared, terrainUniforms, makeRandom(0x51f00d));
  const nearTrees = createTrees(shared, terrainUniforms, makeRandom(0x0a11ce), {
    detail: 1, count: 700, minRadius: 0.016, maxRadius: 0.55,
  });
  const farTrees = createTrees(shared, terrainUniforms, makeRandom(0xbeef21), {
    detail: 0, count: 2600, minRadius: 0.45, maxRadius: 3.2,
  });
  const structures = createStructures(shared, terrainUniforms);

  group.add(grass.mesh, nearTrees.mesh, farTrees.mesh, structures.mesh);

  const materials = [grass.material, nearTrees.material, farTrees.material, structures.material];

  return {
    group,
    grass,
    materials,
    update(elapsed, altitudeKm) {
      grass.material.uniforms.uTime.value = elapsed;
      // Grass has no business being drawn from higher than a diving board.
      const fade = 1 - smoothstep(0.03, 0.16, altitudeKm);
      grass.material.uniforms.uFade.value = fade;
      grass.mesh.visible = fade > 0.01;
      // The oaks last a little longer, then the terrain's own colour carries on.
      nearTrees.mesh.visible = altitudeKm < 2.5;
      farTrees.mesh.visible = altitudeKm < 7.0;
      structures.mesh.visible = altitudeKm < 6.0;
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    },
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
