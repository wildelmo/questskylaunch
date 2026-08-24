import * as THREE from 'three';
import { PLANET_COLORS, TRAIL, NURSERY, SEED_RADII, MOONS } from './config.js';
import { pickArchetype, CLOUD_MAPS, MOON_MAP } from './textures.js';

// How planets look: texture-mapped worlds from the procedural pool — oceans
// and ice caps, banded giants, glowing lava veins — wrapped in a tinted
// fresnel atmosphere that doubles as the hover/held highlight. Some carry a
// slowly drifting cloud deck; some carry tiny moons on tilted orbits.

const _c1 = new THREE.Color();

// Geometry is shared by every planet; radius comes from mesh.scale.
const planetGeo = new THREE.SphereGeometry(1, 40, 26);
const moonGeo = new THREE.SphereGeometry(1, 12, 9);
const sharedShellGeo = new THREE.IcosahedronGeometry(1.18, 3);
const sharedRingGeo = new THREE.RingGeometry(1.55, 2.35, 64);

// Concentric translucent bands for planetary rings, drawn once. RingGeometry
// has planar UVs, so concentric circles in the canvas map to ring bands.
let ringTex = null;
function ringTexture() {
  if (ringTex) return ringTex;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const px = img.data;
  const inner = 1.55 / 2.35; // the geometry's inner edge, as a radius fraction
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
      let a = 0;
      if (r > inner - 0.02 && r < 1) {
        const k = (r - inner) / (1 - inner); // 0..1 across the ring
        a = 0.55 + 0.45 * Math.sin(k * 40 + Math.sin(k * 13) * 2);
        a *= 0.65 + 0.35 * Math.sin(k * 7);
        if (k > 0.62 && k < 0.7) a *= 0.15;   // a Cassini-style gap
        a *= Math.min(1, (1 - r) / 0.03, (r - inner + 0.02) / 0.03); // soft edges
      }
      const i = (y * size + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 255;
      px[i + 3] = Math.max(0, Math.min(255, a * 235));
    }
  }
  g.putImageData(img, 0, 0);
  ringTex = new THREE.CanvasTexture(c);
  ringTex.colorSpace = THREE.SRGBColorSpace;
  ringTex.anisotropy = 4;
  return ringTex;
}

let moonMat = null;
const cloudMats = [];

function makeAtmosphereMaterial(color, strength) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: strength },
    },
    vertexShader: /* glsl */`
      varying float vRim;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vRim = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 2.6);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vRim;
      void main() {
        gl_FragColor = vec4(uColor * vRim * uStrength, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

// One material per archetype, shared by every planet of that kind. The
// surface texture doubles as a faint emissive map so the night side is never
// pure black — worlds stay readable from every angle.
function archetypeMaterial(arch) {
  if (!arch.material) {
    arch.material = new THREE.MeshStandardMaterial({
      map: arch.map,
      roughness: arch.roughness,
      metalness: 0,
      emissiveMap: arch.emissiveMap ?? arch.map,
      emissive: 0xffffff,
      emissiveIntensity: arch.emissiveMap ? 1.1 : 0.11,
    });
  }
  return arch.material;
}

export function makePlanetMesh(radius, colorIndex, archetype = pickArchetype()) {
  const mesh = new THREE.Mesh(planetGeo, archetypeMaterial(archetype));
  mesh.scale.setScalar(radius);
  mesh.userData.archetype = archetype;

  const shell = new THREE.Mesh(sharedShellGeo,
    makeAtmosphereMaterial(archetype.atmo, archetype.atmoStrength));
  shell.userData.base = archetype.atmoStrength;
  mesh.add(shell);
  mesh.userData.shell = shell;

  if (archetype.cloudy && CLOUD_MAPS.length) {
    if (!cloudMats.length) {
      for (const map of CLOUD_MAPS) {
        cloudMats.push(new THREE.MeshLambertMaterial({
          map, transparent: true, depthWrite: false, opacity: 0.92,
        }));
      }
    }
    const cloud = new THREE.Mesh(planetGeo, cloudMats[(Math.random() * cloudMats.length) | 0]);
    cloud.scale.setScalar(1.04);
    cloud.rotation.y = Math.random() * Math.PI * 2;
    mesh.add(cloud);
    mesh.userData.cloud = cloud;
    mesh.userData.cloudSpin = 0.06 + Math.random() * 0.08;
  }

  // Gas giants spin flat and fast; rocky worlds tumble a little.
  mesh.userData.spin = archetype.kind === 'gas'
    ? new THREE.Vector3(0, 0.9 + Math.random() * 1.2, 0)
    : new THREE.Vector3(
        (Math.random() - 0.5) * 0.3, 0.35 + Math.random() * 1.0, (Math.random() - 0.5) * 0.3);

  if (radius >= MOONS.minRadius && Math.random() < MOONS.chance) {
    if (!moonMat) {
      moonMat = new THREE.MeshStandardMaterial({ map: MOON_MAP, roughness: 0.95, metalness: 0 });
    }
    const count = Math.random() < 0.3 ? 2 : 1;
    mesh.userData.moons = [];
    for (let i = 0; i < count; i++) {
      const pivot = new THREE.Group();
      pivot.rotation.set((Math.random() - 0.5) * 0.6, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.9);
      const moon = new THREE.Mesh(moonGeo, moonMat);
      moon.scale.setScalar(0.16 + Math.random() * 0.1);
      moon.position.x = 2.5 + Math.random() * 1.3 + i * 0.9;
      pivot.add(moon);
      mesh.add(pivot);
      mesh.userData.moons.push({ pivot, speed: (0.8 + Math.random() * 1.6) * (Math.random() < 0.15 ? -1 : 1) });
    }
  }

  return mesh;
}

// Per-frame life: self-rotation, cloud drift, moons on their orbits.
export function animatePlanetMesh(mesh, dt) {
  const ud = mesh.userData;
  mesh.rotation.x += ud.spin.x * dt;
  mesh.rotation.y += ud.spin.y * dt;
  mesh.rotation.z += ud.spin.z * dt;
  if (ud.cloud) ud.cloud.rotation.y += ud.cloudSpin * dt;
  if (ud.moons) {
    for (const m of ud.moons) m.pivot.rotation.y += m.speed * dt;
  }
}

export function addRing(mesh, colorIndex) {
  if (mesh.userData.ring) return;
  const ring = new THREE.Mesh(
    sharedRingGeo,
    new THREE.MeshBasicMaterial({
      map: ringTexture(),
      color: new THREE.Color(PLANET_COLORS[colorIndex % PLANET_COLORS.length]).lerp(_c1.set(0xffffff), 0.7),
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.set(Math.PI / 2 + (Math.random() - 0.5) * 0.7, 0, (Math.random() - 0.5) * 0.6);
  mesh.add(ring);
  mesh.userData.ring = ring;
}

// Highlight states for the atmosphere shell. The nursery's idle shimmer only
// runs while the state is 'none', so highlights always win.
export function setShellState(mesh, state) {
  const shell = mesh.userData.shell;
  if (!shell) return;
  mesh.userData.shellState = state;
  const base = shell.userData.base;
  if (state === 'hover') shell.material.uniforms.uStrength.value = Math.max(1.6, base * 3);
  else if (state === 'held') shell.material.uniforms.uStrength.value = Math.max(1.1, base * 2.2);
  else shell.material.uniforms.uStrength.value = base;
}

export function disposePlanetMesh(mesh) {
  // Geometry and surface materials are shared across planets; only the
  // per-planet materials (atmosphere tint, ring tint) are ours to free.
  mesh.userData.shell?.material.dispose();
  mesh.userData.ring?.material.dispose();
}

// ---- trails -------------------------------------------------------------------

// A fading ribbon of recent positions. Fixed-capacity buffer; when full, the
// whole array shifts left one slot per new point — trivial cost at this size.
export class Trail {
  constructor(colorHex) {
    this.capacity = TRAIL.points;
    this.count = 0;
    this.positions = new Float32Array(this.capacity * 3);
    const colors = new Float32Array(this.capacity * 3);
    _c1.setHex(colorHex);
    for (let i = 0; i < this.capacity; i++) {
      const t = Math.pow(i / (this.capacity - 1), 1.6) * 0.85;
      colors.set([_c1.r * t, _c1.g * t, _c1.b * t], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setDrawRange(0, 0);
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }));
    this.line.frustumCulled = false;
    this.last = new THREE.Vector3(Infinity, Infinity, Infinity);
  }

  push(p) {
    if (p.distanceTo(this.last) < TRAIL.minStep) return;
    this.last.copy(p);
    if (this.count === this.capacity) {
      this.positions.copyWithin(0, 3);
      this.count--;
    }
    this.positions.set([p.x, p.y, p.z], this.count * 3);
    this.count++;
    // Oldest point sits at index 0 where the colour ramp is dimmest; a
    // partially-filled trail just doesn't reach full brightness yet.
    this.line.geometry.setDrawRange(0, this.count);
    this.line.geometry.getAttribute('position').needsUpdate = true;
  }

  reset() {
    this.count = 0;
    this.last.set(Infinity, Infinity, Infinity);
    this.line.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.line.geometry.dispose();
    this.line.material.dispose();
  }
}

// ---- the nursery ----------------------------------------------------------------

// Three seed orbs hovering over a small stand. Grabbing one hands the app a
// fresh planet; the empty slot grows a replacement a moment later.
export class Nursery {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.position.set(...NURSERY.pos);
    this.group.lookAt(0, NURSERY.pos[1], 0);
    parent.add(this.group);

    const stand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.3, 0.02, 32),
      new THREE.MeshStandardMaterial({
        color: 0x16233c, roughness: 0.4, metalness: 0.3,
        emissive: 0x67d7ff, emissiveIntensity: 0.08,
      })
    );
    stand.position.y = -0.16;
    this.group.add(stand);

    this.slots = SEED_RADII.map((radius, i) => {
      const slot = {
        radius,
        colorIndex: 0,
        basePos: new THREE.Vector3((i - 1) * NURSERY.spacing, 0, 0),
        mesh: null,
        respawnIn: 0,
        growth: 1,
        phase: Math.random() * Math.PI * 2,
      };
      this.spawnOrb(slot);
      return slot;
    });
  }

  spawnOrb(slot) {
    slot.colorIndex = (Math.random() * PLANET_COLORS.length) | 0;
    slot.mesh = makePlanetMesh(slot.radius, slot.colorIndex);
    slot.mesh.position.copy(slot.basePos);
    slot.growth = 0;
    this.group.add(slot.mesh);
  }

  // The world-space position of a slot's orb (for grab checks).
  orbWorldPos(slot, out) {
    return slot.mesh ? slot.mesh.getWorldPosition(out) : null;
  }

  // Called when a hand takes an orb: detach it and start the respawn timer.
  take(slot) {
    const mesh = slot.mesh;
    slot.mesh = null;
    slot.respawnIn = NURSERY.respawnDelay;
    this.group.remove(mesh);
    return { mesh, radius: slot.radius, colorIndex: slot.colorIndex };
  }

  update(t, dt) {
    for (const slot of this.slots) {
      if (!slot.mesh) {
        slot.respawnIn -= dt;
        if (slot.respawnIn <= 0) this.spawnOrb(slot);
        continue;
      }
      slot.growth = Math.min(1, slot.growth + dt * 1.6);
      const pop = slot.growth < 1 ? 1 - Math.pow(1 - slot.growth, 3) : 1;
      slot.mesh.scale.setScalar(slot.radius * pop);
      slot.mesh.position.y = slot.basePos.y + Math.sin(t * 1.3 + slot.phase) * 0.012;
      animatePlanetMesh(slot.mesh, dt);
      // Idle shimmer on the atmosphere — unless a hand is highlighting it.
      if (!slot.mesh.userData.shellState || slot.mesh.userData.shellState === 'none') {
        const base = slot.mesh.userData.shell.userData.base;
        slot.mesh.userData.shell.material.uniforms.uStrength.value =
          base * (1.1 + Math.sin(t * 2 + slot.phase) * 0.45);
      }
    }
  }
}
