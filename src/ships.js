import * as THREE from 'three';
import { INVASION } from './config.js';
import { softDiscTexture } from './cosmos.js';

// The invaders' bodies, and everything that glows around them: the ship
// silhouettes, the rifts they tear open, the beacon that summons them, the
// blasters that answer, and pooled bolts / debris / score popups — plus the
// garden's own seeker pods and missiles, and the hatch that leads back out
// of the headset. Like the rest of the garden, nothing is downloaded — every
// hull is primitives and every glow is a canvas gradient.
//
// The enemy palette deliberately clashes with the garden. The garden speaks
// cyan and amber; the poachers arrive in magenta, toxic green and ember red,
// with hard faceted chitin instead of soft round worlds — you can read
// friend from foe across the room, in a dark sky or bright passthrough.

export const ENEMY_GLOW = {
  stinger: 0xff4fd8,
  harvester: 0x8dff5a,
  marauder: 0xff5a3c,
  wraith: 0xb48cff,   // cold violet
  warden: 0xffe14a,   // sickly yellow
  siphon: 0x32f7c2,   // mint teal
};
const RIFT_COLOR = 0x9b5cff;
export const BOLT_COLOR = 0x9fdcff; // the garden's own cyan, answering back

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

let glowTex = null;
function glow() {
  return (glowTex ??= softDiscTexture());
}

function glowSprite(color, scale, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glow(), color, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity, toneMapped: false,
  }));
  s.scale.setScalar(scale);
  return s;
}

// Fresnel rim shell — same trick the planets use for atmospheres, tuned as a
// threat highlight. Per-ship material so a hit can flash it.
function rimShellMaterial(color, strength) {
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
        vRim = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 3.4);
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

// Chitin: hard-faceted, a little metallic, never brighter than the glows.
function chitin(color) {
  return new THREE.MeshStandardMaterial({
    color, metalness: 0.55, roughness: 0.42, flatShading: true,
    emissive: color, emissiveIntensity: 0.55,
  });
}

// Swept-back delta wing as a raw triangle pair; `side` is -1 (left) or 1.
function wingGeometry(side, span, chord, sweep) {
  const geo = new THREE.BufferGeometry();
  const s = side;
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, -chord * 0.4,           // wing root, forward
    s * span, 0.008, sweep,       // tip, swept back and slightly up
    0, 0, chord * 0.6,            // root, rear
  ]), 3));
  geo.computeVertexNormals();
  return geo;
}

// ---- the silhouettes ---------------------------------------------------------

// Stinger: a fast insect dart. One bolt kills it; there are many.
function makeStinger() {
  const group = new THREE.Group();
  const hull = chitin(0x2e3a52);

  const fuselage = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.11, 6), hull);
  fuselage.rotation.x = -Math.PI / 2; // apex forward, down -Z
  group.add(fuselage);

  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 6), hull);
  tail.position.z = 0.05;
  tail.scale.set(1, 0.8, 0.9);
  group.add(tail);

  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x1a1f2e, metalness: 0.4, roughness: 0.5, flatShading: true,
    side: THREE.DoubleSide, emissive: ENEMY_GLOW.stinger, emissiveIntensity: 0.35,
  });
  const wings = [];
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry(side, 0.085, 0.07, 0.075), wingMat);
    wing.position.z = 0.01;
    group.add(wing);
    wings.push(wing);
  }

  // Mandibles reaching forward around the eye.
  for (const side of [-1, 1]) {
    const mandible = new THREE.Mesh(new THREE.ConeGeometry(0.005, 0.045, 4), hull);
    mandible.position.set(side * 0.018, -0.004, -0.055);
    mandible.rotation.x = -Math.PI / 2;
    mandible.rotation.z = side * 0.5;
    group.add(mandible);
  }

  const eye = glowSprite(ENEMY_GLOW.stinger, 0.035);
  eye.position.z = -0.052;
  const engine = glowSprite(0xff8adf, 0.05, 0.9);
  engine.position.z = 0.068;
  group.add(eye, engine);

  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.062, 2),
    rimShellMaterial(ENEMY_GLOW.stinger, 0.22));
  shell.scale.set(1, 0.7, 1.5);
  group.add(shell);

  group.userData.animate = (t, dt, phase) => {
    for (let i = 0; i < wings.length; i++) {
      wings[i].rotation.z = (i === 0 ? 1 : -1) * Math.sin(t * 14 + phase) * 0.22;
    }
    engine.material.opacity = 0.7 + Math.sin(t * 21 + phase) * 0.25;
  };
  return finishShip(group, shell, 0.22);
}

// Harvester: a beetle barge with a belly full of tractor beam. Slow, tough,
// and the reason your planets go missing.
function makeHarvester() {
  const group = new THREE.Group();
  const hull = chitin(0x2a4038);

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 1), hull);
  body.scale.set(1, 0.62, 1.35);
  group.add(body);

  for (const z of [-0.055, 0, 0.055]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.007, 6, 18), hull);
    rib.position.z = z;
    rib.scale.set(1, 0.66, 1);
    group.add(rib);
  }

  const spine = new THREE.Mesh(
    new THREE.BoxGeometry(0.01, 0.006, 0.19),
    new THREE.MeshBasicMaterial({ color: ENEMY_GLOW.harvester, toneMapped: false })
  );
  spine.position.y = 0.058;
  group.add(spine);

  // Four claw arms poised under the belly.
  for (const [x, z] of [[-0.05, -0.05], [0.05, -0.05], [-0.05, 0.05], [0.05, 0.05]]) {
    const claw = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.06, 4), hull);
    claw.position.set(x, -0.062, z);
    claw.rotation.x = Math.PI;
    claw.rotation.z = -x * 6;
    group.add(claw);
  }

  const eyes = new THREE.Group();
  for (const x of [-0.026, 0, 0.026]) {
    const e = glowSprite(ENEMY_GLOW.harvester, 0.024);
    e.position.set(x, 0.008, -0.115);
    eyes.add(e);
  }
  group.add(eyes);

  const engines = [];
  for (const x of [-0.045, 0.045]) {
    const e = glowSprite(0xc8ff8a, 0.045, 0.85);
    e.position.set(x, 0, 0.125);
    group.add(e);
    engines.push(e);
  }

  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.115, 2),
    rimShellMaterial(ENEMY_GLOW.harvester, 0.18));
  shell.scale.set(1, 0.68, 1.3);
  group.add(shell);

  group.userData.animate = (t, dt, phase) => {
    for (const e of engines) e.material.opacity = 0.65 + Math.sin(t * 9 + phase) * 0.25;
  };
  return finishShip(group, shell, 0.18);
}

// Marauder: the fourth-wave dreadnought. A jagged crescent that circles the
// garden and lobs slow plasma — every part of it says "deal with me".
function makeMarauder() {
  const group = new THREE.Group();
  const hull = chitin(0x3d2833);

  const crescent = new THREE.Mesh(
    new THREE.TorusGeometry(0.16, 0.045, 7, 22, Math.PI * 1.15), hull);
  crescent.rotation.x = Math.PI / 2;         // lie flat
  crescent.rotation.z = Math.PI * 0.925;     // horns forward, around -Z
  group.add(crescent);

  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.026, 0.1, 6), hull);
  spire.position.y = 0.04;
  group.add(spire);

  // Rim spikes along the outer edge of the crescent.
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * 0.925 + (i / 4 - 0.5) * Math.PI * 0.95;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.075, 4), hull);
    spike.position.set(Math.sin(a) * 0.2, 0, Math.cos(a) * 0.2);
    spike.rotation.x = Math.PI / 2;
    spike.rotation.z = -a;
    group.add(spike);
  }

  const eye = glowSprite(ENEMY_GLOW.marauder, 0.085);
  eye.position.y = 0.095;
  const underglow = glowSprite(0xff3c2a, 0.24, 0.35);
  underglow.position.y = -0.04;
  group.add(eye, underglow);

  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 2),
    rimShellMaterial(ENEMY_GLOW.marauder, 0.14));
  shell.scale.set(1, 0.45, 1);
  group.add(shell);

  group.userData.animate = (t, dt, phase) => {
    eye.material.opacity = 0.8 + Math.sin(t * 5 + phase) * 0.2;
    group.userData.eyePulse = eye.material.opacity;
  };
  return finishShip(group, shell, 0.14);
}

// Wraith: a cloaking thief. A knife-thin manta that fades to a shimmer on
// the hunt and only shows itself for the snatch. `setCloak` runs it in and
// out of sight; the rim shell keeps a ghost of it so a sharp eye can track.
function makeWraith() {
  const group = new THREE.Group();
  const hull = chitin(0x2a2440);

  // Blade fuselage: one octahedron drawn out long and flat along -Z.
  const blade = new THREE.Mesh(new THREE.OctahedronGeometry(0.03, 0), hull);
  blade.scale.set(0.55, 0.35, 2.4);
  group.add(blade);

  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x1a1528, metalness: 0.45, roughness: 0.5, flatShading: true,
    side: THREE.DoubleSide, emissive: ENEMY_GLOW.wraith, emissiveIntensity: 0.3,
  });
  const wings = [];
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry(side, 0.075, 0.09, 0.09), wingMat);
    wing.position.z = -0.005;
    wing.rotation.z = -side * 0.12; // manta droop
    group.add(wing);
    wings.push(wing);
  }

  // Twin tail barbs trailing behind.
  for (const side of [-1, 1]) {
    const barb = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.05, 4), hull);
    barb.position.set(side * 0.012, 0, 0.085);
    barb.rotation.x = Math.PI / 2; // apex backward, up +Z
    barb.rotation.z = -side * 0.25;
    group.add(barb);
  }

  const eye = glowSprite(ENEMY_GLOW.wraith, 0.03);
  eye.position.z = -0.06;
  const engine = glowSprite(0xd6c0ff, 0.045, 0.85);
  engine.position.z = 0.075;
  group.add(eye, engine);

  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 2),
    rimShellMaterial(ENEMY_GLOW.wraith, 0.2));
  shell.scale.set(1.1, 0.5, 1.6);
  group.add(shell);

  // Cloaking drives opacity on the hull materials directly; the list is
  // fixed at build time so no traversal happens per frame.
  const hullMats = [hull, wingMat];
  for (const m of hullMats) m.transparent = true;
  group.userData.setCloak = (k) => {
    group.userData.cloak = k;
    const vis = 1 - k;
    for (const m of hullMats) {
      m.opacity = 0.06 + 0.94 * vis;
      m.depthWrite = k < 0.5; // a ghost must not occlude what's behind it
    }
    eye.material.opacity = vis;
  };

  group.userData.animate = (t, dt, phase) => {
    const vis = 1 - group.userData.cloak;
    for (let i = 0; i < wings.length; i++) {
      wings[i].rotation.z = (i === 0 ? 1 : -1) * (0.12 + Math.sin(t * 3.2 + phase) * 0.16);
    }
    engine.material.opacity = (0.6 + Math.sin(t * 19 + phase) * 0.25) * vis;
  };
  return finishShip(group, shell, 0.2);
}

// Warden: a shield-projecting escort. A squat armoured turtle with three
// prongs that throw the bubble; it has no teeth of its own, it just makes
// everything near it harder to kill.
function makeWarden() {
  const group = new THREE.Group();
  const hull = chitin(0x3f3a22);

  const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 1), hull);
  dome.scale.set(1, 0.5, 1.1);
  group.add(dome);

  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.022, 9), hull);
  skirt.position.y = -0.012;
  group.add(skirt);

  // Three prong emitters at 120°, leaning outward and up from the rim, each
  // with a glow bead at its point.
  const tips = [];
  for (let i = 0; i < 3; i++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = (i / 3) * Math.PI * 2 + Math.PI / 2; // one prong forward
    const prong = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.06, 4), hull);
    prong.position.set(0.065, 0.025, 0);
    prong.rotation.z = -0.9; // apex outward
    pivot.add(prong);
    const tip = glowSprite(ENEMY_GLOW.warden, 0.028, 0.8);
    tip.position.set(0.089, 0.044, 0);
    pivot.add(tip);
    tips.push(tip);
    group.add(pivot);
  }

  // The emitter ring: a broken hoop above the dome that never stops turning.
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.052, 0.003, 5, 24, Math.PI * 1.6),
    new THREE.MeshBasicMaterial({ color: ENEMY_GLOW.warden, toneMapped: false })
  );
  ring.rotation.x = Math.PI / 2; // lie flat
  ring.position.y = 0.03;
  group.add(ring);

  const eye = glowSprite(ENEMY_GLOW.warden, 0.03);
  eye.position.set(0, 0.004, -0.088);
  const underglow = glowSprite(0xfff28a, 0.14, 0.35);
  underglow.position.y = -0.03;
  group.add(eye, underglow);

  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 2),
    rimShellMaterial(ENEMY_GLOW.warden, 0.2));
  shell.scale.set(1, 0.55, 1.05);
  group.add(shell);

  group.userData.animate = (t, dt, phase) => {
    ring.rotation.z += dt * 2.4;
    for (let i = 0; i < tips.length; i++) {
      tips[i].material.opacity = 0.55 + Math.sin(t * 7 + phase + i * 2.1) * 0.35;
    }
    underglow.material.opacity = 0.3 + Math.sin(t * 4 + phase) * 0.1;
  };
  return finishShip(group, shell, 0.2);
}

// Siphon: a sun leech. A mosquito that hangs over the sun with its needle
// down in the fire, and a glass abdomen that swells with what it steals.
// `setFill` is how full it is; the game drives it as the sun drains.
function makeSiphon() {
  const group = new THREE.Group();
  const hull = chitin(0x1f3a36);

  const thorax = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 1), hull);
  thorax.scale.set(1, 0.85, 1.2);
  group.add(thorax);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), hull);
  head.position.set(0, -0.012, -0.04);
  group.add(head);

  // The proboscis: a long needle straight down from the head, along -Y.
  const needle = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.13, 5), hull);
  needle.position.set(0, -0.077, -0.04);
  needle.rotation.x = Math.PI; // apex down
  group.add(needle);

  // Four legs splayed outward and down.
  for (const [side, z] of [[-1, -0.015], [1, -0.015], [-1, 0.02], [1, 0.02]]) {
    const leg = new THREE.Mesh(new THREE.ConeGeometry(0.003, 0.05, 3), hull);
    leg.position.set(side * 0.032, -0.02, z);
    leg.rotation.z = -side * 2.2; // apex out and below the body
    group.add(leg);
  }

  // Glassy wings, held high and blurring.
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x9ad8c8, metalness: 0.2, roughness: 0.3, flatShading: true,
    side: THREE.DoubleSide, transparent: true, opacity: 0.35,
    emissive: ENEMY_GLOW.siphon, emissiveIntensity: 0.25, depthWrite: false,
  });
  const wings = [];
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry(side, 0.05, 0.05, 0.055), wingMat);
    wing.position.set(0, 0.02, 0.005);
    group.add(wing);
    wings.push(wing);
  }

  // The abdomen: translucent, lit from inside, and swelling as it fills.
  const bellyMat = new THREE.MeshStandardMaterial({
    color: 0x1a4d44, metalness: 0.1, roughness: 0.25, transparent: true,
    opacity: 0.55, emissive: ENEMY_GLOW.siphon, emissiveIntensity: 0.3,
  });
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), bellyMat);
  belly.position.set(0, 0.004, 0.05);
  group.add(belly);
  const bellyGlow = glowSprite(ENEMY_GLOW.siphon, 0.06, 0.3);
  bellyGlow.position.copy(belly.position);
  group.add(bellyGlow);

  for (const side of [-1, 1]) {
    const eye = glowSprite(ENEMY_GLOW.siphon, 0.018);
    eye.position.set(side * 0.012, -0.006, -0.052);
    group.add(eye);
  }
  const drip = glowSprite(0xbdfff0, 0.03, 0.7);
  drip.position.set(0, -0.14, -0.04);
  group.add(drip);

  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 2),
    rimShellMaterial(ENEMY_GLOW.siphon, 0.2));
  shell.scale.set(1, 0.8, 1.6);
  shell.position.z = 0.01;
  group.add(shell);

  const state = { fill: 0 };
  group.userData.setFill = (k) => { state.fill = Math.min(1, Math.max(0, k)); };

  group.userData.animate = (t, dt, phase) => {
    const f = state.fill;
    // Full bellies beat faster.
    const pulse = 1 + Math.sin(t * (4 + f * 5) + phase) * (0.04 + f * 0.06);
    const size = (0.8 + f * 0.4) * pulse;
    belly.scale.set(size, size * 0.9, size * 1.3);
    bellyMat.emissiveIntensity = 0.3 + f * 1.3 * pulse;
    bellyGlow.scale.setScalar(0.06 + f * 0.09 * pulse);
    bellyGlow.material.opacity = 0.2 + f * 0.6;
    for (let i = 0; i < wings.length; i++) {
      wings[i].rotation.z = (i === 0 ? 1 : -1) * Math.sin(t * 40 + phase) * 0.35;
    }
    drip.material.opacity = 0.5 + Math.sin(t * 13 + phase) * 0.2 + f * 0.3;
  };
  return finishShip(group, shell, 0.2);
}

// Shared ship plumbing: the rim shell doubles as the hit flash. `cloak`
// (0..1, only the wraith drives it) dims the shell's resting glow toward a
// 0.05 shimmer — the flash itself always shows through.
function finishShip(group, shell, baseStrength) {
  group.userData.shell = shell;
  group.userData.flash = 0;
  group.userData.cloak = 0;
  group.userData.setFlash = (k) => {
    group.userData.flash = k;
  };
  group.userData.updateFlash = (dt) => {
    const ud = group.userData;
    ud.flash = Math.max(0, ud.flash - dt * 5);
    const base = baseStrength + (0.05 - baseStrength) * ud.cloak;
    shell.material.uniforms.uStrength.value = base + ud.flash * 3.5;
  };
  return group;
}

export function makeShipMesh(type) {
  const mesh = type === 'stinger' ? makeStinger()
    : type === 'harvester' ? makeHarvester()
    : type === 'wraith' ? makeWraith()
    : type === 'warden' ? makeWarden()
    : type === 'siphon' ? makeSiphon()
    : makeMarauder();
  mesh.userData.type = type;
  return mesh;
}

export function disposeShipMesh(mesh) {
  // Materials are per-ship; the glow texture they map is shared and
  // material.dispose() leaves it alone.
  mesh.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
}

// ---- the shield bubble -------------------------------------------------------

// What a warden throws over its charges: a unit sphere (the game scales it)
// of fresnel rim and faint lattice in the warden's yellow. `ripple` is the
// bright wince when a bolt splashes off it.
export function makeShieldBubble() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(ENEMY_GLOW.warden) },
      uStrength: { value: 1 },
      uRipple: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying float vRim;
      varying vec2 vUv;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vRim = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 3.2);
        vUv = uv;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uStrength;
      uniform float uRipple;
      uniform float uTime;
      varying float vRim;
      varying vec2 vUv;
      void main() {
        // A faint lattice of meridians and slowly climbing parallels, and
        // scanlines rolling down the whole thing.
        float lattice = max(
          smoothstep(0.9, 1.0, abs(sin(vUv.x * 48.0))),
          smoothstep(0.9, 1.0, abs(sin(vUv.y * 24.0 + uTime * 0.4))));
        float scan = 0.85 + 0.15 * sin(vUv.y * 90.0 - uTime * 3.0);
        // Kept faint on purpose: this is a field the size of a beach ball,
        // drawn both-sided and additive, a metre from the player's eyes.
        // The ships inside must stay readable through it.
        float body = (vRim * 0.34 + 0.012 + lattice * 0.045) * scan;
        vec3 col = uColor * body + vec3(1.0) * uRipple * (vRim * 0.6 + 0.2);
        gl_FragColor = vec4(col * uStrength, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), mat);

  const state = { ripple: 0 };
  mesh.userData.setStrength = (k) => { mat.uniforms.uStrength.value = k; };
  mesh.userData.ripple = () => { state.ripple = 1; };
  mesh.userData.animate = (t, dt) => {
    mat.uniforms.uTime.value = t;
    state.ripple = Math.max(0, state.ripple - dt / 0.3);
    mat.uniforms.uRipple.value = state.ripple * state.ripple;
  };
  return mesh;
}

export function disposeShieldBubble(mesh) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}

// ---- rifts -------------------------------------------------------------------

// A tear in the sky: a swirling shader disc inside a jagged, slowly turning
// ring of violet lightning. `setOpen` runs the tear open and closed.
export function makeRift() {
  const group = new THREE.Group();

  const swirlMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpen: { value: 0 },
      uColor: { value: new THREE.Color(RIFT_COLOR) },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv - 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uOpen;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float r = length(vUv) * 2.0;
        float a = atan(vUv.y, vUv.x);
        // Spiral arms winding inward, plus a white-hot throat.
        float arms = 0.5 + 0.5 * sin(a * 3.0 - r * 9.0 + uTime * 2.6);
        float swirl = arms * smoothstep(1.0, 0.55, r) * smoothstep(0.02, 0.3, r);
        float throat = smoothstep(0.5, 0.0, r);
        vec3 col = uColor * swirl * 1.6 + vec3(1.0, 0.9, 1.0) * throat * 1.2;
        gl_FragColor = vec4(col * uOpen, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const swirl = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), swirlMat);
  group.add(swirl);

  // The torn edge: a ring whose radius stutters, drawn twice and
  // counter-rotated so the rim seems to crackle.
  const edges = [];
  for (let layer = 0; layer < 2; layer++) {
    const n = 42;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 0.5 + (Math.random() - 0.5) * 0.09;
      pts.set([Math.cos(a) * r, Math.sin(a) * r, 0], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const edge = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
      color: layer ? 0xd9baff : RIFT_COLOR, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    group.add(edge);
    edges.push(edge);
  }

  const halo = glowSprite(RIFT_COLOR, 1.6, 0.5);
  group.add(halo);

  group.userData.setOpen = (k) => {
    swirlMat.uniforms.uOpen.value = k;
    group.scale.setScalar(Math.max(0.001, k) * 0.72);
    halo.material.opacity = 0.5 * k;
    for (const e of edges) e.material.opacity = 0.9 * k;
  };
  group.userData.animate = (t) => {
    swirlMat.uniforms.uTime.value = t;
    edges[0].rotation.z = t * 0.8;
    edges[1].rotation.z = -t * 0.55;
  };
  group.userData.setOpen(0);
  return group;
}

export function disposeRift(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
}

// ---- the tractor beam --------------------------------------------------------

// A tapered cone of flowing light. Unit length along -Y from the origin, so
// the game can hang it under a ship and scale y to reach. Harvesters tow
// with it in green; stingers telegraph a snatch with a thin magenta one.
export function makeTractorBeam(colorHex = ENEMY_GLOW.harvester) {
  const geo = new THREE.CylinderGeometry(0.16, 0.5, 1, 12, 1, true);
  geo.translate(0, -0.5, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(colorHex) },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        // Rings of light streaming down toward the caught world.
        float flow = 0.55 + 0.45 * sin((vUv.y + uTime * 0.9) * 26.0);
        float fade = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.05, 0.6, vUv.y);
        gl_FragColor = vec4(uColor * flow * fade * 0.8, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(geo, mat);
  beam.frustumCulled = false;
  beam.visible = false;
  beam.userData.animate = (t) => { mat.uniforms.uTime.value = t; };
  return beam;
}

// ---- the beacon --------------------------------------------------------------

// A caged ember on a pedestal beside the panel. Amber and patient in
// peacetime; press it and it burns red for as long as the sky is open.
export function makeBeacon() {
  const group = new THREE.Group();

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.065, 0.02, 24),
    new THREE.MeshStandardMaterial({
      color: 0x16233c, roughness: 0.4, metalness: 0.3,
      emissive: 0x67d7ff, emissiveIntensity: 0.08,
    })
  );
  pedestal.position.y = -0.14;
  group.add(pedestal);

  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xffb865, transparent: true, opacity: 0.95, toneMapped: false,
  });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.036, 0), coreMat);
  group.add(core);

  const cageMat = new THREE.MeshStandardMaterial({
    color: 0x3a2c22, metalness: 0.7, roughness: 0.35,
  });
  const cages = [];
  for (const rx of [0, Math.PI / 2]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.004, 6, 28), cageMat);
    ring.rotation.x = rx;
    group.add(ring);
    cages.push(ring);
  }

  const halo = glowSprite(0xffb865, 0.16, 0.55);
  group.add(halo);

  const state = { active: false, hover: 0 };
  group.userData.beacon = true;
  group.userData.setActive = (on) => {
    state.active = on;
    const color = on ? 0xff4030 : 0xffb865;
    coreMat.color.setHex(color);
    halo.material.color.setHex(color);
  };
  group.userData.setHover = (k) => { state.hover = k; };
  group.userData.animate = (t, dt) => {
    const beat = state.active
      ? 0.75 + Math.abs(Math.sin(t * 6)) * 0.6      // urgent double-thump
      : 0.85 + Math.sin(t * 1.8) * 0.15;            // calm breathing
    const s = beat * (1 + state.hover * 0.25);
    core.scale.setScalar(s);
    core.rotation.y += dt * (state.active ? 2.6 : 0.5);
    halo.material.opacity = (state.active ? 0.85 : 0.5) * beat;
    cages[0].rotation.y += dt * 0.3;
    cages[1].rotation.z += dt * 0.22;
  };
  return group;
}

// ---- the exit hatch ----------------------------------------------------------

// The way out of the headset, in the garden's own colours: a turning ring
// on the beacon's pedestal, an airlock glyph inside it, and "EXIT" beneath.
// Hold a hand on it and an amber arc fills clockwise; full circle, it
// flashes white and the game takes it from there.
export function makeExitHatch() {
  const group = new THREE.Group();

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.065, 0.02, 24),
    new THREE.MeshStandardMaterial({
      color: 0x16233c, roughness: 0.4, metalness: 0.3,
      emissive: 0x67d7ff, emissiveIntensity: 0.08,
    })
  );
  pedestal.position.y = -0.14;
  group.add(pedestal);

  // The ring: a hoop with a gap so its slow turn can be seen.
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x16233c, roughness: 0.35, metalness: 0.5,
    emissive: 0x67d7ff, emissiveIntensity: 0.5,
  });
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.05, 0.005, 8, 40, Math.PI * 1.85), ringMat);
  group.add(ring);

  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.038, 32),
    new THREE.MeshBasicMaterial({
      color: 0x0c1a2c, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
    }));
  group.add(disc);

  // The glyph: a broken ring with a bar through the gap — a door ajar.
  const glyphMat = new THREE.MeshBasicMaterial({
    color: 0x9fdcff, toneMapped: false, side: THREE.DoubleSide,
  });
  const glyphRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.02, 0.0025, 6, 28, Math.PI * 1.5), glyphMat);
  glyphRing.rotation.z = Math.PI * 0.75; // gap at the top
  glyphRing.position.z = 0.003;
  const glyphBar = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.024, 0.004), glyphMat);
  glyphBar.position.set(0, 0.012, 0.003);
  group.add(glyphRing, glyphBar);

  // The hold arc, rebuilt only when it has grown enough to notice.
  const arcMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const arc = new THREE.Mesh(new THREE.RingGeometry(0.057, 0.065, 48, 1, 0, 0.001), arcMat);
  arc.position.z = -0.002;
  group.add(arc);

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const g = canvas.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 56px "Segoe UI", system-ui, sans-serif';
  g.shadowColor = '#9fdcff';
  g.shadowBlur = 18;
  g.fillStyle = '#9fdcff';
  g.fillText('EXIT', 128, 48);
  g.shadowBlur = 0;
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillText('EXIT', 128, 48);
  const labelTex = new THREE.CanvasTexture(canvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: labelTex, transparent: true, depthWrite: false,
  }));
  label.scale.set(0.1, 0.0375, 1);
  label.position.y = -0.09;
  group.add(label);

  const halo = glowSprite(0x67d7ff, 0.16, 0.35);
  halo.position.z = -0.005;
  group.add(halo);

  const state = { hover: 0, hold: 0, built: -1, flash: 0 };
  group.userData.setHover = (k) => { state.hover = k; };
  group.userData.setHold = (k) => {
    const hold = Math.min(1, Math.max(0, k));
    if (hold >= 1 && state.hold < 1) state.flash = 1;
    state.hold = hold;
    if (Math.abs(hold - state.built) > 0.02 || (hold === 0) !== (state.built === 0)) {
      state.built = hold;
      arc.geometry.dispose();
      // Start walks backward from 12 o'clock so the arc fills clockwise.
      const len = Math.max(0.001, hold * Math.PI * 2);
      arc.geometry = new THREE.RingGeometry(0.057, 0.065, 48, 1, Math.PI / 2 - len, len);
    }
  };
  group.userData.animate = (t, dt) => {
    const breath = 0.85 + Math.sin(t * 1.8) * 0.15;
    const lift = 1 + state.hover * 0.6;
    state.flash = Math.max(0, state.flash - dt * 4);
    ring.rotation.z += dt * 0.35;
    ringMat.emissiveIntensity = 0.5 * breath * lift;
    glyphMat.color.setHex(0x9fdcff).lerp(_c.setHex(0xffffff), state.hover * 0.5);
    halo.material.opacity = 0.35 * breath * lift;
    halo.scale.setScalar(0.16 * (1 + state.hover * 0.2));
    label.material.opacity = 0.7 + state.hover * 0.3;
    arcMat.opacity = state.hold > 0 ? 0.75 + state.flash * 0.25 : 0;
    arcMat.color.setHex(0xffd9a0).lerp(_c.setHex(0xffffff), state.flash);
  };
  return group;
}

// ---- the blaster -------------------------------------------------------------

// What a controller becomes when the beacon burns: a stub barrel with a
// glowing emitter, whose heat-vein runs cyan → red as you lean on the
// trigger. Aligned down -Z so it points where the controller points.
export function makeBlaster() {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x24304a, metalness: 0.65, roughness: 0.35,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.017, 0.1, 8), bodyMat);
  body.rotation.x = Math.PI / 2;
  body.position.z = -0.01;
  group.add(body);

  const ringMat = new THREE.MeshBasicMaterial({ color: BOLT_COLOR, toneMapped: false });
  const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0035, 6, 20), ringMat);
  muzzleRing.position.z = -0.062;
  group.add(muzzleRing);

  const emitter = new THREE.Mesh(new THREE.IcosahedronGeometry(0.008, 1),
    new THREE.MeshBasicMaterial({
      color: 0xdff4ff, transparent: true, opacity: 0.95, toneMapped: false,
    }));
  emitter.position.z = -0.062;
  group.add(emitter);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.02, 0.055), bodyMat);
  fin.position.set(0, 0.02, -0.02);
  group.add(fin);

  // The heat vein: two strips whose color walks cyan → amber → red.
  const heatMat = new THREE.MeshBasicMaterial({ color: BOLT_COLOR, toneMapped: false });
  for (const x of [-0.015, 0.015]) {
    const vein = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.004, 0.07), heatMat);
    vein.position.set(x, 0, -0.015);
    group.add(vein);
  }

  const flash = glowSprite(BOLT_COLOR, 0.001, 0.9);
  flash.position.z = -0.075;
  group.add(flash);

  // Seeker pips: a row of gold beads along the spine, one per two missiles
  // loaded — the whole magazine at a glance, and a gold muzzle while any
  // are left.
  const pipMat = new THREE.MeshBasicMaterial({ color: SEEKER_COLOR, toneMapped: false });
  const pips = [];
  for (let i = 0; i < 6; i++) {
    const pip = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.006), pipMat);
    pip.position.set(0, 0.033, -0.045 + i * 0.011);
    pip.visible = false;
    group.add(pip);
    pips.push(pip);
  }

  const state = { flash: 0, loaded: 0 };
  group.userData.setHeat = (h, overheated) => {
    const k = Math.min(1, h);
    _c.setHex(BOLT_COLOR).lerp(new THREE.Color(0xff3820), k * k);
    heatMat.color.copy(_c);
    // Overheat: the muzzle ring goes dark while the blaster vents.
    ringMat.color.setHex(overheated ? 0x5a2018 : state.loaded > 0 ? SEEKER_COLOR : BOLT_COLOR);
  };
  group.userData.setLoaded = (n) => {
    state.loaded = n;
    const lit = Math.min(pips.length, Math.ceil(n / 2));
    for (let i = 0; i < pips.length; i++) pips[i].visible = i < lit;
  };
  group.userData.flash = () => { state.flash = 1; };
  group.userData.animate = (dt) => {
    state.flash = Math.max(0, state.flash - dt * 14);
    flash.scale.setScalar(0.001 + state.flash * 0.075);
    flash.material.opacity = state.flash * 0.9;
    emitter.material.opacity = 0.55 + state.flash * 0.45;
  };
  group.visible = false;
  return group;
}

// ---- seeker pods and missiles ------------------------------------------------

// A power-up worth reaching for: a cyan crystal with a white heart, two
// rings on the turn, and a halo. The game bobs it; this only spins and
// pulses. `setFade` blinks it out before it expires; `setHover` is the
// come-hither when a hand is near.
export function makeSeekerPod() {
  const group = new THREE.Group();

  const crystalMat = new THREE.MeshStandardMaterial({
    color: 0x67d7ff, metalness: 0.2, roughness: 0.25, flatShading: true,
    transparent: true, opacity: 0.75, emissive: 0x67d7ff, emissiveIntensity: 0.6,
  });
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.028, 0), crystalMat);
  crystal.scale.set(1, 1.5, 1);
  group.add(crystal);

  const core = glowSprite(0xffffff, 0.035);
  group.add(core);

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x9fdcff, transparent: true, toneMapped: false,
  });
  const rings = [];
  for (const tilt of [0.5, -0.9]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.002, 5, 32), ringMat);
    ring.rotation.x = Math.PI / 2 + tilt;
    group.add(ring);
    rings.push(ring);
  }

  const halo = glowSprite(0x67d7ff, 0.14, 0.4);
  group.add(halo);

  const state = { fade: 1, hover: 0 };
  group.userData.setFade = (k) => { state.fade = k; };
  group.userData.setHover = (k) => { state.hover = k; };
  group.userData.animate = (t, dt) => {
    const { fade, hover } = state;
    const beat = 0.9 + Math.sin(t * 2.4) * 0.1;
    crystal.rotation.y += dt * (1.2 + hover * 2.5);
    rings[0].rotation.z += dt * 0.9;
    rings[1].rotation.z -= dt * 0.7;
    crystalMat.opacity = 0.75 * fade;
    crystalMat.emissiveIntensity = 0.6 + hover * 0.9;
    ringMat.opacity = fade;
    core.material.opacity = fade * (0.85 + hover * 0.15);
    core.scale.setScalar(0.035 * beat * (1 + hover * 0.4));
    halo.material.opacity = 0.4 * beat * fade * (1 + hover * 0.6);
    halo.scale.setScalar(0.14 * (1 + hover * 0.35));
  };
  return group;
}

export function disposeSeekerPod(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
}

// The garden's own answer to a fast target: a white-gold dart that turns
// after what it's thrown at. Pooled by the game, so it stays at four
// objects — a dart, a four-point fin set, and two sprites.
export const SEEKER_COLOR = 0xffe9a0;
export function makeSeekerMesh() {
  const group = new THREE.Group();

  const dart = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.05, 5),
    new THREE.MeshBasicMaterial({ color: 0xfff6d8, toneMapped: false }));
  dart.rotation.x = -Math.PI / 2; // apex forward, down -Z
  dart.position.z = -0.01;
  group.add(dart);

  const fins = new THREE.Mesh(new THREE.OctahedronGeometry(0.012, 0),
    new THREE.MeshBasicMaterial({ color: SEEKER_COLOR, toneMapped: false }));
  fins.scale.set(1.4, 1.4, 0.35);
  fins.position.z = 0.015;
  group.add(fins);

  const exhaust = glowSprite(SEEKER_COLOR, 0.05, 0.9);
  exhaust.position.z = 0.03;
  const tip = glowSprite(0xffffff, 0.025, 0.8);
  tip.position.z = -0.036;
  group.add(exhaust, tip);

  const phase = Math.random() * Math.PI * 2;
  group.userData.animate = (t, dt) => {
    const flicker = 0.65 + Math.sin(t * 37 + phase) * 0.2 + Math.sin(t * 91 + phase) * 0.1;
    exhaust.material.opacity = flicker;
    exhaust.scale.setScalar(0.04 + flicker * 0.02);
    fins.rotation.z += dt * 9;
  };
  return group;
}

export function disposeSeekerMesh(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
}

// ---- bolt pool ---------------------------------------------------------------

// Every laser bolt alive, drawn as one instanced mesh. Bolts carry their
// previous position so hits test the swept segment (see waves.js) — at
// 7 m/s a bolt crosses a stinger in under a frame.
export class BoltPool {
  constructor(parent) {
    const cap = INVASION.blaster.maxBolts;
    this.capacity = cap;
    this.bolts = []; // {pos, prev, dir, life, grabber}
    this.free = [];

    // Bright-cored streak: a thin cylinder with a canvas gradient along it.
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.45, 'rgba(255,255,255,1)');
    grad.addColorStop(0.55, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 64);
    const tex = new THREE.CanvasTexture(c);

    this.mesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.11, 5, 1, true),
      new THREE.MeshBasicMaterial({
        map: tex, color: BOLT_COLOR, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
      cap
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  fire(origin, dir, grabber) {
    if (this.bolts.length >= this.capacity) this.bolts.shift();
    this.bolts.push({
      pos: origin.clone(),
      prev: origin.clone(),
      dir: dir.clone().normalize(),
      life: INVASION.blaster.boltLife,
      grabber,
    });
  }

  kill(bolt) {
    bolt.life = 0;
  }

  update(dt) {
    const speed = INVASION.blaster.boltSpeed;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      if (b.life <= 0) { this.bolts.splice(i, 1); continue; }
      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.dir, speed * dt);
    }
    // Write instance matrices: cylinder Y-axis aligned to flight direction.
    for (let i = 0; i < this.bolts.length; i++) {
      const b = this.bolts[i];
      _q.setFromUnitVectors(Y_AXIS, b.dir);
      _m.compose(b.pos, _q, _v.set(1, 1, 1));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = this.bolts.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- explosions --------------------------------------------------------------

// One instanced pool of chitin shards for every kill, plus a flash and an
// expanding ring per burst. Shards drift, tumble and shrink; space has no
// air, but a little drag keeps debris near where the kill happened.
export class ExplosionPool {
  constructor(parent) {
    this.capacity = 240;
    this.shards = []; // {pos, vel, rot, spin, life, maxLife, size, idx}
    this.mesh = new THREE.InstancedMesh(
      new THREE.TetrahedronGeometry(0.016, 0),
      new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false }),
      this.capacity
    );
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);

    this.flashes = []; // pooled sprites: {sprite, life, maxLife, scale}
    this.rings = [];
    for (let i = 0; i < 8; i++) {
      const flash = glowSprite(0xffffff, 1, 1);
      flash.visible = false;
      parent.add(flash);
      this.flashes.push({ sprite: flash, life: 0, maxLife: 0.22, scale: 1 });

      const ring = new THREE.Sprite(new THREE.SpriteMaterial({
        map: ringTexture(), color: 0xffffff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      ring.visible = false;
      parent.add(ring);
      this.rings.push({ sprite: ring, life: 0, maxLife: 0.5, scale: 1 });
    }
  }

  burst(pos, colorHex, size = 1) {
    _c.setHex(colorHex);
    const n = Math.round(14 + size * 10);
    for (let i = 0; i < n; i++) {
      if (this.shards.length >= this.capacity) this.shards.shift();
      const life = 0.5 + Math.random() * 0.45;
      this.shards.push({
        pos: pos.clone(),
        vel: new THREE.Vector3().randomDirection()
          .multiplyScalar((0.6 + Math.random() * 1.3) * size),
        rot: new THREE.Euler(
          Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI),
        spin: (Math.random() - 0.5) * 14,
        life,
        maxLife: life,
        size: (0.5 + Math.random() * 0.8) * size,
        color: Math.random() < 0.35 ? new THREE.Color(0xffffff) : _c.clone(),
      });
    }
    this.claim(this.flashes, pos, colorHex, 0.45 * size + 0.1);
    this.claim(this.rings, pos, colorHex, 1.1 * size + 0.2);
  }

  claim(pool, pos, colorHex, scale) {
    const slot = pool.find((f) => f.life <= 0) ?? pool[0];
    slot.sprite.position.copy(pos);
    slot.sprite.material.color.setHex(colorHex);
    slot.sprite.visible = true;
    slot.life = slot.maxLife;
    slot.scale = scale;
  }

  update(dt) {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life -= dt;
      if (s.life <= 0) { this.shards.splice(i, 1); continue; }
      s.pos.addScaledVector(s.vel, dt);
      s.vel.multiplyScalar(1 - dt * 1.8);
      s.rot.x += s.spin * dt;
      s.rot.y += s.spin * 0.7 * dt;
    }
    for (let i = 0; i < this.shards.length; i++) {
      const s = this.shards[i];
      const k = s.life / s.maxLife;
      _q.setFromEuler(s.rot);
      _m.compose(s.pos, _q, _v.setScalar(s.size * k));
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, s.color);
    }
    this.mesh.count = this.shards.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    for (const f of this.flashes) {
      if (f.life <= 0) { f.sprite.visible = false; continue; }
      f.life -= dt;
      const k = Math.max(0, f.life / f.maxLife);
      f.sprite.scale.setScalar(f.scale * (1.4 - k * 0.4));
      f.sprite.material.opacity = k;
    }
    for (const r of this.rings) {
      if (r.life <= 0) { r.sprite.visible = false; continue; }
      r.life -= dt;
      const k = Math.max(0, r.life / r.maxLife);
      r.sprite.scale.setScalar(r.scale * (1.15 - k));
      r.sprite.material.opacity = k * 0.9;
    }
  }
}

let ringTex = null;
function ringTexture() {
  if (ringTex) return ringTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 40, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  ringTex = new THREE.CanvasTexture(c);
  return ringTex;
}

// ---- score popups ------------------------------------------------------------

// "+400 ×3" drifting up from a kill. A small pool of canvas sprites; each
// claim redraws its canvas — kills are rare enough that this never hitches.
export class PopupPool {
  constructor(parent) {
    this.pool = [];
    for (let i = 0; i < 10; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 96;
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false,
      }));
      sprite.visible = false;
      sprite.renderOrder = 10;
      parent.add(sprite);
      this.pool.push({ canvas, tex, sprite, life: 0, maxLife: 1.2, vel: 0.22 });
    }
  }

  spawn(text, pos, colorCss = '#9fdcff', scale = 1) {
    const slot = this.pool.find((p) => p.life <= 0) ?? this.pool[0];
    const g = slot.canvas.getContext('2d');
    g.clearRect(0, 0, 320, 96);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 52px "Segoe UI", system-ui, sans-serif';
    g.shadowColor = colorCss;
    g.shadowBlur = 18;
    g.fillStyle = colorCss;
    g.fillText(text, 160, 48);
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillText(text, 160, 48);
    slot.tex.needsUpdate = true;
    slot.sprite.position.copy(pos);
    slot.sprite.scale.set(0.42 * scale, 0.126 * scale, 1);
    slot.sprite.visible = true;
    slot.life = slot.maxLife;
  }

  update(dt) {
    for (const p of this.pool) {
      if (p.life <= 0) { p.sprite.visible = false; continue; }
      p.life -= dt;
      p.sprite.position.y += p.vel * dt;
      p.sprite.material.opacity = Math.min(1, (p.life / p.maxLife) * 2.2);
    }
  }
}

// ---- marauder plasma ---------------------------------------------------------

// A slow, fat, shootable ball of trouble.
export function makeOrbMesh() {
  const group = new THREE.Group();
  const core = glowSprite(0xffd2a0, 0.07, 1);
  const halo = glowSprite(ENEMY_GLOW.marauder, 0.17, 0.7);
  group.add(core, halo);
  group.userData.animate = (t, phase) => {
    const pulse = 1 + Math.sin(t * 11 + phase) * 0.18;
    core.scale.setScalar(0.07 * pulse);
    halo.scale.setScalar(0.17 * (2 - pulse));
  };
  return group;
}

export function disposeOrbMesh(group) {
  group.traverse((o) => o.material?.dispose());
}
