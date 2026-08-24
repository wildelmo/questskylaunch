// Headless sanity checks for the orbital mechanics — run with `npm test`.
// If these pass, a thrown planet in the headset behaves: circular orbits stay
// circular, merges conserve momentum, the sun eats, escapees leave.

import * as THREE from 'three';
import { Sim } from '../src/physics.js';
import { PREDICT } from '../src/config.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const FRAME = 1 / 72;

function stepSeconds(sim, seconds) {
  for (let t = 0; t < seconds; t += FRAME) sim.step(FRAME);
}

// ---- 1. a circular orbit stays put and completes revolutions -------------------

{
  const sim = new Sim();
  let orbits = 0;
  sim.onOrbit = () => orbits++;
  const r = 0.5;
  const v = sim.circularSpeed(r);
  const pos = sim.sun.pos.clone().add(new THREE.Vector3(r, 0, 0));
  const body = sim.addBody(pos, new THREE.Vector3(0, 0, v), 0.03, 0);

  let minR = Infinity, maxR = 0;
  for (let t = 0; t < 20; t += FRAME) {
    sim.step(FRAME);
    const d = body.pos.distanceTo(sim.sun.pos);
    minR = Math.min(minR, d);
    maxR = Math.max(maxR, d);
  }
  const period = 2 * Math.PI * r / v;
  check('circular orbit radius holds within 2%',
    minR > r * 0.98 && maxR < r * 1.02, `r ∈ [${minR.toFixed(4)}, ${maxR.toFixed(4)}]`);
  check('orbit completions counted',
    Math.abs(orbits - Math.floor(20 / period)) <= 1, `${orbits} orbits, period ≈ ${period.toFixed(2)}s`);
  check('velocity stays finite', Number.isFinite(body.vel.length()));
}

// ---- 2. merges conserve momentum and volume ------------------------------------

{
  const sim = new Sim();
  sim.sun.gm = 0; // no external force, so total momentum must be conserved
  let merged = null;
  sim.onMerge = (removed, survivor) => { merged = survivor; };
  const c = sim.sun.pos.clone().add(new THREE.Vector3(1.5, 0, 0));
  const a = sim.addBody(c.clone().add(new THREE.Vector3(-0.05, 0, 0)), new THREE.Vector3(0.4, 0, 0), 0.03, 0);
  const b = sim.addBody(c.clone().add(new THREE.Vector3(0.05, 0, 0)), new THREE.Vector3(-0.4, 0, 0), 0.03, 1);
  const p0 = a.vel.clone().multiplyScalar(a.gm).addScaledVector(b.vel, b.gm);

  stepSeconds(sim, 0.5);
  check('head-on bodies merged', sim.bodies.length === 1 && merged !== null);
  if (merged) {
    const p1 = merged.vel.clone().multiplyScalar(merged.gm);
    check('momentum conserved through merge', p0.distanceTo(p1) < 1e-6,
      `|Δp| = ${p0.distanceTo(p1).toExponential(2)}`);
    check('volume added', Math.abs(merged.radius - Math.cbrt(2) * 0.03) < 1e-9);
  }
}

// ---- 3. the sun eats what falls in ----------------------------------------------

{
  const sim = new Sim();
  let eaten = 0;
  sim.onEat = () => eaten++;
  sim.addBody(sim.sun.pos.clone().add(new THREE.Vector3(0.3, 0, 0)), new THREE.Vector3(), 0.02, 0);
  stepSeconds(sim, 3);
  check('dropped planet is eaten', eaten === 1 && sim.bodies.length === 0 && sim.sun.meals === 1);
  check('sun grows when fed', sim.sun.gm > 0.45 && sim.sun.radius > 0.13);
}

// ---- 4. escapees are removed ------------------------------------------------------

{
  const sim = new Sim();
  let escaped = 0;
  sim.onEscape = () => escaped++;
  sim.addBody(sim.sun.pos.clone().add(new THREE.Vector3(0.5, 0, 0)), new THREE.Vector3(3.5, 0.5, 0), 0.02, 0);
  stepSeconds(sim, 6);
  check('fast throw escapes the garden', escaped === 1 && sim.bodies.length === 0);
}

// ---- 5. prediction agrees with reality --------------------------------------------

{
  const sim = new Sim();
  const r = 0.5;
  const v = sim.circularSpeed(r);
  const pos = sim.sun.pos.clone().add(new THREE.Vector3(r, 0, 0));
  const vel = new THREE.Vector3(0, 0, v);
  const buf = new Float32Array(PREDICT.steps * 3);
  const res = sim.predict(pos, vel, null, buf);
  check('circular prediction runs full length without hitting sun',
    !res.hitSun && res.count === PREDICT.steps);
  let maxDev = 0;
  for (let i = 0; i < res.count; i++) {
    const d = Math.hypot(
      buf[i * 3] - sim.sun.pos.x, buf[i * 3 + 1] - sim.sun.pos.y, buf[i * 3 + 2] - sim.sun.pos.z);
    maxDev = Math.max(maxDev, Math.abs(d - r));
  }
  check('predicted circular arc stays near radius', maxDev < r * 0.06, `max dev ${(maxDev / r * 100).toFixed(1)}%`);

  const res2 = sim.predict(pos, new THREE.Vector3(-0.2, 0, 0), null, buf);
  check('inward drop prediction ends at the sun', res2.hitSun === true);
}

// ---- 6. a nova blast pushes planets out --------------------------------------------

{
  const sim = new Sim();
  const body = sim.addBody(sim.sun.pos.clone().add(new THREE.Vector3(0.5, 0, 0)), new THREE.Vector3(), 0.03, 0);
  sim.blast(0.5);
  check('blast imparts outward velocity', body.vel.x > 0.4);
}

// ---- 7. the orbit-assist boundary is real physics -----------------------------------
// A tangential release at 0.9 × escape speed (what assist caps to) must stay
// bound; the same throw at 2.1 × escape must leave.

{
  const sim = new Sim();
  const r = 0.5;
  const start = () => sim.sun.pos.clone().add(new THREE.Vector3(r, 0, 0));
  const esc = sim.escapeSpeedAt(start());
  check('escape speed matches sqrt(2GM/r)',
    Math.abs(esc - Math.sqrt(2 * sim.sun.gm / r)) < 1e-12, `${esc.toFixed(3)} m/s`);

  let gone = 0;
  sim.onEscape = () => gone++;
  sim.onEat = () => gone++;
  sim.addBody(start(), new THREE.Vector3(0, 0, esc * 0.9), 0.021, 0);
  stepSeconds(sim, 32); // longer than the big ellipse's period
  check('capped throw stays bound through a full ellipse', gone === 0 && sim.bodies.length === 1);

  sim.addBody(start(), new THREE.Vector3(0, 0, esc * 2.1), 0.021, 0);
  stepSeconds(sim, 10);
  check('a real hurl still escapes', gone === 1);
}

// ---- 8. held bodies are kinematic but still attract ---------------------------------

{
  const sim = new Sim();
  const held = sim.addBody(sim.sun.pos.clone().add(new THREE.Vector3(0.6, 0, 0)), new THREE.Vector3(), 0.052, 0);
  held.held = true;
  const near = sim.addBody(held.pos.clone().add(new THREE.Vector3(0.12, 0, 0)), new THREE.Vector3(), 0.021, 1);
  const posBefore = held.pos.clone();
  const gapBefore = near.pos.distanceTo(held.pos);
  sim.step(FRAME * 3);
  check('held body does not move under gravity', held.pos.equals(posBefore));
  check('held body still attracts neighbours', near.pos.distanceTo(held.pos) < gapBefore);
}

console.log(failures === 0 ? '\nall good ✓' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
