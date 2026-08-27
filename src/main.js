import * as THREE from 'three';
import { SUN, PHYSICS, LAYOUT, PLANET_COLORS, SEED_RADII } from './config.js';
import { Sim } from './physics.js';
import { GardenAudio } from './audio.js';
import { makeStarfield, makeSun, makePlatform } from './cosmos.js';
import {
  makePlanetMesh, animatePlanetMesh, addRing, disposePlanetMesh, Trail, Nursery,
} from './planets.js';
import { buildTexturePool, ARCHETYPES } from './textures.js';
import { InfoPanel } from './panel.js';
import { Interactions } from './interact.js';
import { Invasion } from './invasion.js';

// GRAVITY GARDEN
// A quiet corner of space, a small hungry sun, and as many planets as you
// care to throw. Everything here — geometry, textures, sound — is generated
// at load; the only dependency is three.js.

// ---- renderer & scene ---------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.xr.enabled = true;
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060f);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 150);
camera.position.set(0, 1.6, 0.6);

scene.add(new THREE.HemisphereLight(0x33415e, 0x05060d, 0.5));

const starfield = makeStarfield();
scene.add(starfield);
const platform = makePlatform(LAYOUT.platformRadius);
scene.add(platform);

// Mixed reality hides the deep-space scenery and clears to transparent, so
// the Quest's passthrough camera shows your real room around the garden.
const spaceBackground = scene.background;
function setSpaceScenery(visible) {
  starfield.visible = visible;
  platform.visible = visible;
  scene.background = visible ? spaceBackground : null;
}

// Everything the player can pick up — sun, planets, trails, nursery — lives
// in this group, so the two-handed world grip can scale, pan and turn it all
// at once. The platform, stars and UI stay fixed for comfort.
const gardenGroup = new THREE.Group();
scene.add(gardenGroup);

buildTexturePool();

const sunState = makeSun();
gardenGroup.add(sunState.group);

// ---- the garden -----------------------------------------------------------------

// Owns the sim plus everything visual that hangs off it: planet meshes,
// trails, the nursery, and the little deaths and celebrations.
class Garden {
  constructor(audio, group) {
    this.audio = audio;
    this.group = group;
    this.sim = new Sim();
    this.nursery = new Nursery(group);
    this.trails = new Map();   // body -> Trail
    this.dying = [];           // meshes shrinking out of existence
    this.trailsOn = true;

    this.sim.onOrbit = (body) => this.audio.orbitNote(this.worldOf(body.pos), body.radius);

    this.sim.onMerge = (removed, survivor) => {
      this.removeVisuals(removed);
      survivor.mesh.scale.setScalar(survivor.radius);
      if (survivor.hasRing) addRing(survivor.mesh, survivor.colorIndex);
      this.trailOf(survivor)?.reset();
      this.audio.merge(this.worldOf(survivor.pos), survivor.radius);
    };

    this.sim.onEat = (body) => {
      this.removeVisuals(body, true);
      this.audio.sunEat(this.worldOf(body.pos));
      sunState.eat();
      sunState.setRadius(this.sim.sun.radius);
      if (this.sim.sun.meals >= SUN.mealsToNova) this.nova();
    };

    this.sim.onEscape = (body) => {
      this.removeVisuals(body);
      this.audio.sweepAway();
    };
  }

  // Garden-space point -> world, for spatial audio.
  worldOf(pos) {
    return this.group.localToWorld(_w.copy(pos));
  }

  nova() {
    // The sun gives back everything it was fed, all at once.
    sunState.nova();
    this.sim.blast(0.5);
    this.audio.nova(this.worldOf(this.sim.sun.pos));
    this.sim.sun.gm = SUN.gm;
    this.sim.sun.radius = SUN.radius;
    this.sim.sun.meals = 0;
    sunState.setRadius(SUN.radius);
    for (const grabber of interactions?.grabbers ?? []) grabber.pulse(0.8, 220);
    invasion?.onNova(); // during a siege the shockwave also scours the sky
  }

  // A stinger made off with a planet: it leaves the sim but its mesh flies
  // on, hanging from the thief. Returns what a rescue needs to rebuild it.
  abductPlanet(body) {
    if (!body.alive || !body.mesh) return null;
    const { mesh, radius, colorIndex, hasRing } = body;
    this.sim.remove(body);
    const trail = this.trails.get(body);
    if (trail) {
      trail.line.parent?.remove(trail.line);
      trail.dispose();
      this.trails.delete(body);
    }
    body.mesh = null;
    mesh.parent?.remove(mesh);
    return { mesh, radius, colorIndex, hasRing };
  }

  addPlanet(pos, vel, radius, colorIndex, mesh = null, archetype = undefined) {
    // Make room: the oldest free planet quietly leaves.
    if (this.sim.bodies.length >= PHYSICS.maxBodies) {
      const oldest = this.sim.bodies.find((b) => !b.held);
      if (oldest) { this.sim.remove(oldest); this.removeVisuals(oldest); }
    }
    const body = this.sim.addBody(pos, vel, radius, colorIndex);
    body.mesh = mesh ?? makePlanetMesh(radius, colorIndex, archetype);
    body.mesh.position.copy(pos);
    if (body.hasRing) addRing(body.mesh, colorIndex);
    this.group.add(body.mesh);

    const trail = new Trail(PLANET_COLORS[colorIndex % PLANET_COLORS.length]);
    trail.line.visible = this.trailsOn;
    this.trails.set(body, trail);
    this.group.add(trail.line);
    return body;
  }

  // A nursery seed becomes a real (held) planet, reusing the orb's mesh.
  plantSeed(slot) {
    this.nursery.orbWorldPos(slot, _v1); // world pos, captured before take()
    this.group.worldToLocal(_v1);
    const { mesh, radius, colorIndex } = this.nursery.take(slot);
    this.group.add(mesh);
    mesh.position.copy(_v1);
    mesh.scale.setScalar(radius);
    return this.addPlanet(_v1, _zero, radius, colorIndex, mesh);
  }

  trailOf(body) {
    return this.trails.get(body);
  }

  removeVisuals(body, immediate = false) {
    const trail = this.trails.get(body);
    if (trail) {
      trail.line.parent?.remove(trail.line);
      trail.dispose();
      this.trails.delete(body);
    }
    if (!body.mesh) return;
    if (immediate) {
      body.mesh.parent?.remove(body.mesh);
      disposePlanetMesh(body.mesh);
    } else {
      this.dying.push({ mesh: body.mesh, life: 0.35, scale: body.mesh.scale.x });
    }
    body.mesh = null;
  }

  clearPlanets() {
    let any = false;
    for (const body of [...this.sim.bodies]) {
      if (body.held) continue;
      this.sim.remove(body);
      this.removeVisuals(body);
      any = true;
    }
    if (any) this.audio.sweepAway();
  }

  toggleTrails() {
    this.trailsOn = !this.trailsOn;
    for (const trail of this.trails.values()) {
      trail.line.visible = this.trailsOn;
      if (!this.trailsOn) trail.reset();
    }
  }

  resetView() {
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.scale.setScalar(1);
    this.group.updateMatrixWorld(true);
  }

  update(dt, t) {
    for (const body of this.sim.bodies) {
      const mesh = body.mesh;
      if (!mesh) continue;
      mesh.position.copy(body.pos);
      animatePlanetMesh(mesh, dt);
      if (this.trailsOn && !body.held && !this.sim.paused) {
        this.trails.get(body)?.push(body.pos);
      }
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.mesh.parent?.remove(d.mesh);
        disposePlanetMesh(d.mesh);
        this.dying.splice(i, 1);
      } else {
        d.mesh.scale.setScalar(d.scale * (d.life / 0.35));
      }
    }
    this.nursery.update(t, dt);
  }
}

const _v1 = new THREE.Vector3();
const _w = new THREE.Vector3();
const _zero = new THREE.Vector3();

let invasion = null; // assigned below; Garden.nova() may fire before then

const audio = new GardenAudio();
const garden = new Garden(audio, gardenGroup);
const sim = garden.sim;
const panel = new InfoPanel(scene);

// ---- actions shared by controllers, keyboard, and buttons ------------------------

const actions = {
  toggleTrails: () => { garden.toggleTrails(); audio.click(); },
  togglePause: () => { sim.paused = !sim.paused; audio.click(); },
  clearPlanets: () => garden.clearPlanets(),
  togglePanel: () => { panel.toggle(); audio.click(); },
  resetView: () => { garden.resetView(); audio.click(); },
};

const interactions = new Interactions({
  renderer, camera, scene, sim, garden, audio, actions, dom: renderer.domElement,
});

// ---- the invasion ----------------------------------------------------------------

// The game mode: press the beacon (or G) and the poachers come for your
// worlds. See invasion.js for the whole war.
const headPos = new THREE.Vector3(0, 1.6, 0); // tracks the camera; see the loop
invasion = new Invasion({
  scene, sim, garden, audio,
  sunFx: sunState,
  getXRMode: () => xrMode,
  getHead: (out) => { out.copy(headPos); return true; },
});
invasion.bindInput(interactions);
interactions.bindInvasion({
  beacon: invasion.beacon,
  toggle: () => { invasion.toggle(); },
  isActive: () => invasion.active,
});

// ---- the opening scene ------------------------------------------------------------

function seedStarterSystem() {
  const sunPos = sim.sun.pos;
  const place = (r, theta, speedMul, radius, colorIndex, archetype, tiltY = 0) => {
    const pos = new THREE.Vector3(
      sunPos.x + r * Math.cos(theta), sunPos.y + tiltY, sunPos.z + r * Math.sin(theta));
    const v = sim.circularSpeed(r) * speedMul;
    const vel = new THREE.Vector3(-Math.sin(theta), (Math.random() - 0.5) * 0.1, Math.cos(theta))
      .normalize().multiplyScalar(v);
    return garden.addPlanet(pos, vel, radius, colorIndex, null, archetype);
  };
  // A blue marble, a small red world on an eccentric path, a ringed giant.
  place(0.42, 0.8, 1.0, SEED_RADII[1], 3, ARCHETYPES[0]);
  place(0.66, 3.6, 1.16, SEED_RADII[0], 7, ARCHETYPES[3], 0.06);
  const ringed = place(0.98, 2.2, 0.98, SEED_RADII[2], 1, ARCHETYPES[5]);
  ringed.hasRing = true;
  addRing(ringed.mesh, ringed.colorIndex);
}
seedStarterSystem();

// ---- XR session -------------------------------------------------------------------

const overlay = document.getElementById('overlay');
const enterBtn = document.getElementById('enter-vr');
const arBtn = document.getElementById('enter-ar');
const hint = document.getElementById('hint');

renderer.xr.setReferenceSpaceType('local-floor');

// 'vr' fills the sky with stars; 'ar' is passthrough mixed reality.
let xrMode = 'vr';

const noVR = () => {
  enterBtn.classList.add('unsupported');
  enterBtn.textContent = 'VR NOT AVAILABLE HERE';
  hint.textContent = 'Open this page in the browser on a Meta Quest to step inside — or play with the mouse: drag planets to throw them, scroll to zoom.';
};

async function supported(mode) {
  try {
    return (await navigator.xr?.isSessionSupported?.(mode)) ?? false;
  } catch {
    return false;
  }
}

(async () => {
  if (await supported('immersive-vr')) {
    enterBtn.disabled = false;
    enterBtn.textContent = 'ENTER VR';
  } else {
    noVR();
  }
  if (await supported('immersive-ar')) arBtn.classList.add('available');
})();

async function enterXR(mode) {
  audio.start();
  try {
    xrMode = mode;
    const session = await navigator.xr.requestSession(
      mode === 'ar' ? 'immersive-ar' : 'immersive-vr',
      { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    await renderer.xr.setSession(session);
  } catch (err) {
    xrMode = 'vr';
    console.error(`Could not start ${mode} session:`, err);
  }
}

enterBtn.addEventListener('click', () => {
  if (!enterBtn.classList.contains('unsupported')) enterXR('vr');
});
arBtn.addEventListener('click', () => enterXR('ar'));

renderer.xr.addEventListener('sessionstart', () => {
  overlay.classList.add('hidden');
  setSpaceScenery(xrMode !== 'ar');
  audio.resume();
});
renderer.xr.addEventListener('sessionend', () => {
  setSpaceScenery(true);
  overlay.classList.remove('hidden');
});

// Sound needs a user gesture on desktop too.
window.addEventListener('pointerdown', () => audio.start(), { once: true });

// ---- main loop --------------------------------------------------------------------

const clock = new THREE.Clock();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
let statTick = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  const presenting = renderer.xr.isPresenting;

  interactions.update(dt, t, presenting);
  sim.step(dt);
  garden.update(dt, t);
  invasion.update(dt, t);
  sunState.update(t, dt);
  for (const child of starfield.children) {
    child.userData.starMat && (child.userData.starMat.uniforms.uTime.value = t);
  }

  if (!presenting) interactions.updateDesktopCamera();

  // Keep the ears where the eyes are — and tell the invasion where the
  // player's head is, so ships can buzz it.
  const cam = presenting ? renderer.xr.getCamera() : camera;
  cam.matrixWorld.decompose(_pos, _q, _s);
  _fwd.set(0, 0, -1).applyQuaternion(_q);
  _up.set(0, 1, 0).applyQuaternion(_q);
  audio.updateListener(_pos, _fwd, _up);
  headPos.copy(_pos);

  statTick += dt;
  if (statTick > 0.25) {
    statTick = 0;
    panel.setStats({
      bodies: sim.bodies.length,
      timeScale: sim.timeScale,
      paused: sim.paused,
      trails: garden.trailsOn,
      meals: sim.sun.meals,
      mealsToNova: SUN.mealsToNova,
      invasion: invasion.getStats(),
    });
  }
  panel.update();

  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// A debug handle for automated smoke tests (and the curious).
window.__gg = {
  sim, garden, renderer, camera, gardenGroup, interactions, invasion,
  setSpaceScenery, starfield, platform,
};
