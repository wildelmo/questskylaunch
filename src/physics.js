import * as THREE from 'three';
import { SUN, PHYSICS, PREDICT } from './config.js';

// Newtonian n-body around a fixed sun, integrated with velocity Verlet at a
// fixed substep. Bodies are plain objects owned by the sim; rendering hangs
// its own state (mesh, trail) off them and reads pos/radius every frame.
//
// A body being held by a hand is kinematic: the grab code writes its pos and
// vel directly, the integrator skips it, but everything else still feels its
// gravity — wiggling a heavy planet through a swarm perturbs the swarm.

const _d = new THREE.Vector3();
const _a0 = new THREE.Vector3();

export class Sim {
  constructor() {
    this.sun = {
      pos: new THREE.Vector3(...SUN.pos),
      gm: SUN.gm,
      radius: SUN.radius,
      meals: 0,
    };
    this.bodies = [];
    this.paused = false;
    this.timeScale = 1;

    // Callbacks the app wires up: (body), (a, b, merged), etc.
    this.onEat = null;      // sun swallowed a body
    this.onMerge = null;    // two bodies became one
    this.onEscape = null;   // body left the garden
    this.onOrbit = null;    // body completed a full revolution
  }

  addBody(pos, vel, radius, colorIndex) {
    const body = {
      pos: pos.clone(),
      vel: vel.clone(),
      acc: new THREE.Vector3(),
      radius,
      gm: PHYSICS.planetDensity * radius ** 3,
      colorIndex,
      held: false,
      alive: true,
      hasRing: radius > 0.03 && Math.random() < 0.35,
      // Orbit-completion tracking: unit radial direction last frame, and the
      // unsigned angle swept since the last completed revolution.
      orbitDir: pos.clone().sub(this.sun.pos).normalize(),
      orbitAngle: 0,
      orbits: 0,
    };
    this.bodies.push(body);
    return body;
  }

  remove(body) {
    body.alive = false;
    const i = this.bodies.indexOf(body);
    if (i !== -1) this.bodies.splice(i, 1);
  }

  // Gravitational acceleration at point p, excluding one body (usually the
  // body being accelerated). Held bodies still attract.
  accelAt(p, exclude, out) {
    out.set(0, 0, 0);
    const eps2 = PHYSICS.soften * PHYSICS.soften;

    _d.subVectors(this.sun.pos, p);
    let d2 = _d.lengthSq() + eps2;
    out.addScaledVector(_d, this.sun.gm / (d2 * Math.sqrt(d2)));

    for (const b of this.bodies) {
      if (b === exclude) continue;
      _d.subVectors(b.pos, p);
      d2 = _d.lengthSq() + eps2;
      out.addScaledVector(_d, b.gm / (d2 * Math.sqrt(d2)));
    }
    return out;
  }

  step(frameDt) {
    if (this.paused) return;
    const simDt = frameDt * this.timeScale;
    const n = Math.min(PHYSICS.maxSubsteps, Math.max(1, Math.ceil(simDt / PHYSICS.substep)));
    const h = simDt / n;

    for (let s = 0; s < n; s++) {
      // Velocity Verlet: uses acc from the previous substep as a(t).
      for (const b of this.bodies) {
        if (b.held) continue;
        b.pos.addScaledVector(b.vel, h).addScaledVector(b.acc, 0.5 * h * h);
      }
      for (const b of this.bodies) {
        if (b.held) { b.acc.set(0, 0, 0); continue; }
        _a0.copy(b.acc);
        this.accelAt(b.pos, b, b.acc);
        b.vel.addScaledVector(_a0.add(b.acc), 0.5 * h);
      }
    }

    this.resolveCollisions();
    this.trackOrbits();
  }

  resolveCollisions() {
    // Sun absorbs, then planet pairs merge. Lists are small; brute force.
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (b.held) continue;
      const d = b.pos.distanceTo(this.sun.pos);
      if (d < this.sun.radius + b.radius) {
        this.remove(b);
        this.sun.meals++;
        this.sun.gm *= SUN.growPerMeal;
        this.sun.radius *= SUN.radiusPerMeal;
        this.onEat?.(b);
        continue;
      }
      if (d > PHYSICS.escapeRadius || !Number.isFinite(b.pos.x)) {
        this.remove(b);
        this.onEscape?.(b);
      }
    }

    // Pairwise merges. After each merge, restart the scan — the grown body
    // may now overlap something else. Lists are tiny and collisions rare.
    let merged = true;
    while (merged) {
      merged = false;
      scan: for (let i = 0; i < this.bodies.length; i++) {
        for (let j = i + 1; j < this.bodies.length; j++) {
          const a = this.bodies[i];
          const b = this.bodies[j];
          if (a.pos.distanceTo(b.pos) >= a.radius + b.radius) continue;
          this.mergePair(a, b);
          merged = true;
          break scan;
        }
      }
    }
  }

  // Merge conserves momentum; volume adds. A held body stays in the hand and
  // simply swallows the other, whatever their sizes.
  mergePair(a, b) {
    let survivor = a.gm >= b.gm ? a : b;
    if (a.held !== b.held) survivor = a.held ? a : b;
    const removed = survivor === a ? b : a;

    const m = survivor.gm + removed.gm;
    if (!survivor.held) {
      survivor.vel.multiplyScalar(survivor.gm / m).addScaledVector(removed.vel, removed.gm / m);
      survivor.pos.multiplyScalar(survivor.gm / m).addScaledVector(removed.pos, removed.gm / m);
    }
    survivor.gm = m;
    survivor.radius = Math.cbrt(survivor.radius ** 3 + removed.radius ** 3);
    survivor.hasRing = survivor.hasRing || removed.hasRing;
    this.remove(removed);
    this.onMerge?.(removed, survivor);
  }

  trackOrbits() {
    for (const b of this.bodies) {
      if (b.held) continue;
      _d.subVectors(b.pos, this.sun.pos).normalize();
      const dot = Math.min(1, Math.max(-1, _d.dot(b.orbitDir)));
      b.orbitAngle += Math.acos(dot);
      b.orbitDir.copy(_d);
      if (b.orbitAngle >= Math.PI * 2) {
        b.orbitAngle -= Math.PI * 2;
        b.orbits++;
        this.onOrbit?.(b);
      }
    }
  }

  // Look-ahead for the ghost arc shown while a planet is held: integrate a
  // phantom copy against the sun and a frozen snapshot of the other bodies.
  // Writes xyz triples into `out` (a Float32Array) and returns
  // { count, hitSun } — the arc ends early at the sun's surface.
  predict(pos, vel, exclude, out) {
    const p = _predP.copy(pos);
    const v = _predV.copy(vel);
    const h = PREDICT.dt;
    let count = 0;
    let hitSun = false;

    for (let i = 0; i < PREDICT.steps; i++) {
      this.accelAt(p, exclude, _predA);
      v.addScaledVector(_predA, h);
      p.addScaledVector(v, h);
      out[count * 3] = p.x;
      out[count * 3 + 1] = p.y;
      out[count * 3 + 2] = p.z;
      count++;
      const d = p.distanceTo(this.sun.pos);
      if (d < this.sun.radius) { hitSun = true; break; }
      if (d > PHYSICS.escapeRadius) break;
    }
    return { count, hitSun };
  }

  // Radial shove from the sun, used by the nova. Falls off with distance.
  blast(strength) {
    for (const b of this.bodies) {
      if (b.held) continue;
      _d.subVectors(b.pos, this.sun.pos);
      const d = Math.max(0.18, _d.length());
      b.vel.addScaledVector(_d.normalize(), Math.min(1.6, strength / d));
    }
  }

  // Speed for a circular orbit at distance r — used to seed the opening scene.
  circularSpeed(r) {
    return Math.sqrt(this.sun.gm / r);
  }
}

const _predP = new THREE.Vector3();
const _predV = new THREE.Vector3();
const _predA = new THREE.Vector3();
