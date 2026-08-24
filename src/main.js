import * as THREE from 'three';
import { SUN, PHYSICS, LAYOUT, PLANET_COLORS, SEED_RADII } from './config.js';
import { Sim } from './physics.js';
import { GardenAudio } from './audio.js';
import { makeStarfield, makeSun, makePlatform } from './cosmos.js';
import { makePlanetMesh, addRing, disposePlanetMesh, Trail, Nursery } from './planets.js';
import { InfoPanel } from './panel.js';
import { Interactions } from './interact.js';

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
const sunState = makeSun();
scene.add(sunState.group);
scene.add(makePlatform(LAYOUT.platformRadius));

// ---- the garden -----------------------------------------------------------------

// Owns the sim plus everything visual that hangs off it: planet meshes,
// trails, the nursery, and the little deaths and celebrations.
class Garden {
  constructor(audio) {
    this.audio = audio;
    this.sim = new Sim();
    this.nursery = new Nursery(scene);
    this.trails = new Map();   // body -> Trail
    this.dying = [];           // meshes shrinking out of existence
    this.trailsOn = true;

    this.sim.onOrbit = (body) => this.audio.orbitNote(body.pos, body.radius);

    this.sim.onMerge = (removed, survivor) => {
      this.removeVisuals(removed);
      survivor.mesh.scale.setScalar(survivor.radius);
      if (survivor.hasRing) addRing(survivor.mesh, survivor.colorIndex);
      this.trailOf(survivor)?.reset();
      this.audio.merge(survivor.pos, survivor.radius);
    };

    this.sim.onEat = (body) => {
      this.removeVisuals(body, true);
      this.audio.sunEat(body.pos);
      sunState.eat();
      sunState.setRadius(this.sim.sun.radius);
      if (this.sim.sun.meals >= SUN.mealsToNova) this.nova();
    };

    this.sim.onEscape = (body) => {
      this.removeVisuals(body);
      this.audio.sweepAway();
    };
  }

  nova() {
    // The sun gives back everything it was fed, all at once.
    sunState.nova();
    this.sim.blast(0.5);
    this.audio.nova(this.sim.sun.pos);
    this.sim.sun.gm = SUN.gm;
    this.sim.sun.radius = SUN.radius;
    this.sim.sun.meals = 0;
    sunState.setRadius(SUN.radius);
    for (const grabber of interactions?.grabbers ?? []) grabber.pulse(0.8, 220);
  }

  addPlanet(pos, vel, radius, colorIndex, mesh = null) {
    // Make room: the oldest free planet quietly leaves.
    if (this.sim.bodies.length >= PHYSICS.maxBodies) {
      const oldest = this.sim.bodies.find((b) => !b.held);
      if (oldest) { this.sim.remove(oldest); this.removeVisuals(oldest); }
    }
    const body = this.sim.addBody(pos, vel, radius, colorIndex);
    body.mesh = mesh ?? makePlanetMesh(radius, colorIndex);
    body.mesh.position.copy(pos);
    if (body.hasRing) addRing(body.mesh, colorIndex);
    scene.add(body.mesh);

    const trail = new Trail(PLANET_COLORS[colorIndex % PLANET_COLORS.length]);
    trail.line.visible = this.trailsOn;
    this.trails.set(body, trail);
    scene.add(trail.line);
    return body;
  }

  // A nursery seed becomes a real (held) planet, reusing the orb's mesh.
  plantSeed(slot) {
    this.nursery.orbWorldPos(slot, _v1); // capture before take() detaches it
    const { mesh, radius, colorIndex } = this.nursery.take(slot);
    scene.add(mesh);
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
      scene.remove(trail.line);
      trail.dispose();
      this.trails.delete(body);
    }
    if (!body.mesh) return;
    if (immediate) {
      scene.remove(body.mesh);
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

  update(dt, t) {
    for (const body of this.sim.bodies) {
      const mesh = body.mesh;
      if (!mesh) continue;
      mesh.position.copy(body.pos);
      const spin = mesh.userData.spin;
      if (spin) {
        mesh.rotation.x += spin.x * dt;
        mesh.rotation.y += spin.y * dt;
        mesh.rotation.z += spin.z * dt;
      }
      if (this.trailsOn && !body.held && !this.sim.paused) {
        this.trails.get(body)?.push(body.pos);
      }
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i];
      d.life -= dt;
      if (d.life <= 0) {
        scene.remove(d.mesh);
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
const _zero = new THREE.Vector3();

const audio = new GardenAudio();
const garden = new Garden(audio);
const sim = garden.sim;
const panel = new InfoPanel(scene);

// ---- actions shared by controllers, keyboard, and buttons ------------------------

const actions = {
  toggleTrails: () => { garden.toggleTrails(); audio.click(); },
  togglePause: () => { sim.paused = !sim.paused; audio.click(); },
  clearPlanets: () => garden.clearPlanets(),
  togglePanel: () => { panel.toggle(); audio.click(); },
};

const interactions = new Interactions({
  renderer, camera, scene, sim, garden, audio, actions, dom: renderer.domElement,
});

// ---- the opening scene ------------------------------------------------------------

function seedStarterSystem() {
  const sunPos = sim.sun.pos;
  const place = (r, theta, speedMul, radius, colorIndex, tiltY = 0) => {
    const pos = new THREE.Vector3(
      sunPos.x + r * Math.cos(theta), sunPos.y + tiltY, sunPos.z + r * Math.sin(theta));
    const v = sim.circularSpeed(r) * speedMul;
    const vel = new THREE.Vector3(-Math.sin(theta), (Math.random() - 0.5) * 0.1, Math.cos(theta))
      .normalize().multiplyScalar(v);
    return garden.addPlanet(pos, vel, radius, colorIndex);
  };
  place(0.42, 0.8, 1.0, SEED_RADII[1], 3);          // a steady blue year
  place(0.66, 3.6, 1.16, SEED_RADII[0], 7, 0.06);   // a small pink comet of a thing
  const ringed = place(0.98, 2.2, 0.98, SEED_RADII[2], 1);
  ringed.hasRing = true;
  addRing(ringed.mesh, ringed.colorIndex);
}
seedStarterSystem();

// ---- XR session -------------------------------------------------------------------

const overlay = document.getElementById('overlay');
const enterBtn = document.getElementById('enter-vr');
const hint = document.getElementById('hint');

renderer.xr.setReferenceSpaceType('local-floor');

if (navigator.xr?.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (ok) {
      enterBtn.disabled = false;
      enterBtn.textContent = 'ENTER VR';
    } else {
      enterBtn.classList.add('unsupported');
      enterBtn.textContent = 'VR NOT AVAILABLE HERE';
      hint.textContent = 'Open this page in the browser on a Meta Quest to step inside — or play with the mouse: drag planets to throw them, scroll to zoom.';
    }
  }).catch(() => {});
} else {
  enterBtn.classList.add('unsupported');
  enterBtn.textContent = 'VR NOT AVAILABLE HERE';
  hint.textContent = 'Open this page in the browser on a Meta Quest to step inside — or play with the mouse: drag planets to throw them, scroll to zoom.';
}

enterBtn.addEventListener('click', async () => {
  if (enterBtn.classList.contains('unsupported')) return;
  audio.start();
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    await renderer.xr.setSession(session);
  } catch (err) {
    console.error('Could not start VR session:', err);
  }
});

renderer.xr.addEventListener('sessionstart', () => {
  overlay.classList.add('hidden');
  audio.resume();
});
renderer.xr.addEventListener('sessionend', () => {
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
  sunState.update(t, dt);
  for (const child of starfield.children) {
    child.userData.starMat && (child.userData.starMat.uniforms.uTime.value = t);
  }

  if (!presenting) interactions.updateDesktopCamera();

  // Keep the ears where the eyes are.
  const cam = presenting ? renderer.xr.getCamera() : camera;
  cam.matrixWorld.decompose(_pos, _q, _s);
  _fwd.set(0, 0, -1).applyQuaternion(_q);
  _up.set(0, 1, 0).applyQuaternion(_q);
  audio.updateListener(_pos, _fwd, _up);

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
window.__gg = { sim, garden, renderer, camera };
