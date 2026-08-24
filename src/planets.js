import * as THREE from 'three';
import { PLANET_COLORS, TRAIL, NURSERY, SEED_RADII } from './config.js';

// How planets look: faceted unit icosahedra with per-vertex colour noise,
// scaled to the body's radius, plus an additive fresnel "atmosphere" shell
// that doubles as the hover/held highlight, and an optional Saturn ring.

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

// Smooth-ish value noise at a vertex — enough for banding, cheap to compute.
function vnoise(x, y, z) {
  return (hash3(Math.round(x * 2), Math.round(y * 2), Math.round(z * 2)) * 0.6 +
          hash3(Math.round(x * 5), Math.round(y * 5), Math.round(z * 5)) * 0.4);
}

function makeAtmosphereMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: 0.35 },
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

const sharedShellGeo = new THREE.IcosahedronGeometry(1.18, 2);
const sharedRingGeo = new THREE.RingGeometry(1.55, 2.35, 48);

export function makePlanetMesh(radius, colorIndex) {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const base = PLANET_COLORS[colorIndex % PLANET_COLORS.length];
  _c1.setHex(base);
  const hsl = {};
  _c1.getHSL(hsl);
  const seed = Math.random() * 100;

  for (let i = 0; i < pos.count; i++) {
    const n = vnoise(pos.getX(i) + seed, pos.getY(i) * 2.4 + seed, pos.getZ(i) + seed);
    _c2.setHSL(
      (hsl.h + (n - 0.5) * 0.07 + 1) % 1,
      Math.min(1, hsl.s * (0.85 + n * 0.35)),
      Math.min(0.85, hsl.l * (0.72 + n * 0.62)),
    );
    colors.set([_c2.r, _c2.g, _c2.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.6,
    metalness: 0,
    emissive: base,
    emissiveIntensity: 0.06,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(radius);

  const shell = new THREE.Mesh(sharedShellGeo, makeAtmosphereMaterial(base));
  mesh.add(shell);
  mesh.userData.shell = shell;
  mesh.userData.spin = new THREE.Vector3(
    (Math.random() - 0.5) * 0.4, 0.4 + Math.random() * 1.2, (Math.random() - 0.5) * 0.4);
  return mesh;
}

export function addRing(mesh, colorIndex) {
  if (mesh.userData.ring) return;
  const ring = new THREE.Mesh(
    sharedRingGeo,
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PLANET_COLORS[colorIndex % PLANET_COLORS.length]).lerp(_c1.set(0xffffff), 0.55),
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.set(Math.PI / 2 + (Math.random() - 0.5) * 0.7, 0, (Math.random() - 0.5) * 0.6);
  mesh.add(ring);
  mesh.userData.ring = ring;
}

// Highlight states for the atmosphere shell.
export function setShellState(mesh, state) {
  const shell = mesh.userData.shell;
  if (!shell) return;
  if (state === 'hover') shell.material.uniforms.uStrength.value = 1.5;
  else if (state === 'held') shell.material.uniforms.uStrength.value = 1.0;
  else shell.material.uniforms.uStrength.value = 0.35;
}

export function disposePlanetMesh(mesh) {
  mesh.geometry.dispose();
  mesh.material.dispose();
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
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.position.set(...NURSERY.pos);
    this.group.lookAt(0, NURSERY.pos[1], 0);
    scene.add(this.group);

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
      const colorIndex = (Math.random() * PLANET_COLORS.length) | 0;
      const slot = {
        radius,
        colorIndex,
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
      slot.mesh.rotation.y += dt * 0.6;
      slot.mesh.material.emissiveIntensity = 0.1 + (Math.sin(t * 2 + slot.phase) + 1) * 0.06;
    }
  }
}
