import * as THREE from 'three';
import { INVASION } from './config.js';
import {
  waveComposition, spawnIntervalFor, waveSpeedMul, comboAdvance, comboMultiplier,
  heatAfterShot, heatCool, canFire, segmentSphereHit, waveClearBonus, strafeThrough,
} from './waves.js';
import {
  makeShipMesh, disposeShipMesh, makeRift, disposeRift, makeTractorBeam,
  makeBeacon, makeBlaster, makeOrbMesh, disposeOrbMesh,
  BoltPool, ExplosionPool, PopupPool, ENEMY_GLOW,
} from './ships.js';
import { Trail, disposePlanetMesh } from './planets.js';

// THE POACHERS
// Something out there noticed a garden full of hand-thrown worlds, and wants
// them. Press the beacon and the invasion begins: rifts tear open around the
// room, stingers dive for your nursery, harvesters drag whole planets away
// on tractor beams, and every fourth wave a marauder circles the garden
// lobbing plasma. Your controllers become blasters. Hold the trigger.
//
// Ships live in WORLD space — they fly through the player's room (straight
// through real walls, in passthrough), while their targets live inside the
// scalable garden group. Every chase therefore converts between the two
// spaces each frame, and everything the player does runs on real time, never
// the garden's timeScale.

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const NEG_Y = new THREE.Vector3(0, -1, 0);

const SHIP_SIZE = { stinger: 0.8, harvester: 1.3, marauder: 1.9 }; // fx scale

export class Invasion {
  constructor({ scene, sim, garden, audio, sunFx, getXRMode, getHead }) {
    this.scene = scene;
    this.sim = sim;
    this.garden = garden;
    this.audio = audio;
    this.sunFx = sunFx;
    this.getXRMode = getXRMode ?? (() => 'vr');
    this.getHead = getHead ?? null; // (outVector3) => bool, the player's head
    this.input = null; // Interactions, bound by main.js

    this.group = new THREE.Group(); // world-space home for ships, bolts, fx
    scene.add(this.group);

    this.beacon = makeBeacon();
    this.beacon.position.set(...INVASION.beaconPos);
    garden.group.add(this.beacon);

    this.bolts = new BoltPool(this.group);
    this.explosions = new ExplosionPool(this.group);
    this.popups = new PopupPool(this.group);

    this.state = 'idle'; // idle | alarm | wave | intermission | retreat
    this.stateT = 0;
    this.time = 0;
    this.wave = 0;
    this.score = 0;
    this.best = readBest();
    this.kills = 0;
    this.worldsLost = 0;
    this.combo = { kills: 0, lastAt: -Infinity };

    this.ships = [];
    this.rifts = [];
    this.orbs = [];
    this.queue = [];       // ship types waiting to come through
    this.spawnTimer = 0;

    // One shooter per grabber (left, right, mouse): heat + fire cadence.
    this.shooters = [emptyShooter(), emptyShooter(), emptyShooter()];
    this.blasters = [];
  }

  // Called once by main.js after Interactions exists: hang a blaster on each
  // controller's aim space.
  bindInput(interactions) {
    this.input = interactions;
    for (let i = 0; i < 2; i++) {
      const blaster = makeBlaster();
      interactions.grabbers[i].raySpace?.add(blaster);
      this.blasters.push(blaster);
    }
  }

  get active() {
    return this.state !== 'idle';
  }

  toggle() {
    this.active && this.state !== 'retreat' ? this.stop() : this.start();
  }

  start() {
    if (this.state !== 'idle') return;
    this.state = 'alarm';
    this.stateT = 0;
    this.wave = 0;
    this.score = 0;
    this.kills = 0;
    this.worldsLost = 0;
    this.combo = { kills: 0, lastAt: -Infinity };
    this.beacon.userData.setActive(true);
    this.audio.alarm();
    this.ensureRifts(1);
  }

  // The beacon put out: ships break off and dive back through the rifts.
  // Harvesters let go of whatever they were dragging.
  stop() {
    if (this.state === 'idle' || this.state === 'retreat') return;
    this.state = 'retreat';
    this.stateT = 0;
    this.queue.length = 0;
    for (const ship of this.ships) {
      if (ship.phase === 'tractor') this.releaseTractor(ship);
      ship.phase = 'flee';
    }
    for (const orb of this.orbs) this.removeOrb(orb, false);
    this.beacon.userData.setActive(false);
    this.audio.standDown();
  }

  // ---- per-frame ------------------------------------------------------------

  update(dt, t) {
    this.time += dt;
    this.beacon.userData.animate(t, dt);
    if (this.state === 'idle') {
      // Let the last embers finish: closing rifts, debris, fading popups.
      for (const rift of this.rifts) this.updateRift(rift, dt, t);
      this.rifts = this.rifts.filter((r) => !r.dead);
      this.bolts.update(dt);
      this.explosions.update(dt);
      this.popups.update(dt);
      this.updateBlasterVisuals(false);
      return;
    }
    if (this.sim.paused) return; // B freezes the war along with the orbits

    this.updateShooters(dt);
    this.updateStateMachine(dt);
    this.updateShips(dt, t);
    this.updateOrbs(dt, t);
    this.bolts.update(dt);
    this.collideBolts();
    this.collideSwats(dt);
    for (const rift of this.rifts) this.updateRift(rift, dt, t);
    this.rifts = this.rifts.filter((r) => !r.dead);
    this.explosions.update(dt);
    this.popups.update(dt);
  }

  updateStateMachine(dt) {
    this.stateT += dt;
    switch (this.state) {
      case 'alarm':
        if (this.stateT >= INVASION.alarmTime) this.startWave(1);
        break;
      case 'wave': {
        this.spawnFromQueue(dt);
        const clear = this.queue.length === 0 && this.ships.length === 0
          && this.orbs.length === 0;
        if (clear) {
          const bonus = waveClearBonus(this.wave);
          this.addScore(bonus, `WAVE ${this.wave} CLEAR +${bonus}`,
            this.worldSun(_v1).add(_v2.set(0, 0.45, 0)), '#ffd9a0', 1.5);
          this.audio.waveClear();
          this.state = 'intermission';
          this.stateT = 0;
          this.ensureRifts(1); // extras close; one stays open, humming
        }
        break;
      }
      case 'intermission':
        if (this.stateT >= INVASION.intermission) this.startWave(this.wave + 1);
        break;
      case 'retreat':
        if (this.ships.length === 0 || this.stateT > 6) {
          for (const ship of [...this.ships]) this.removeShip(ship);
          this.ensureRifts(0);
          this.state = 'idle';
          this.stateT = 0;
          writeBest(this.best);
        }
        break;
    }
  }

  startWave(n) {
    this.wave = n;
    this.state = 'wave';
    this.stateT = 0;
    const mix = waveComposition(n);
    this.queue.length = 0;
    for (let i = 0; i < mix.marauders; i++) this.queue.push('marauder');
    for (let i = 0; i < Math.max(mix.stingers, mix.harvesters); i++) {
      if (i < mix.stingers) this.queue.push('stinger');
      if (i < mix.harvesters) this.queue.push('harvester');
    }
    this.spawnTimer = 0.6;
    this.ensureRifts(1 + Math.min(2, Math.floor((n - 1) / 3)));
    this.audio.waveStart();
    this.popups.spawn(`WAVE ${n}`, this.worldSun(_v1).add(_v2.set(0, 0.5, 0)),
      '#ff8adf', 1.6);
  }

  spawnFromQueue(dt) {
    if (!this.queue.length || this.ships.length >= INVASION.maxShips) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    const rift = this.rifts.find((r) => r.k > 0.8 && !r.closing);
    if (!rift) return;
    this.spawnTimer = spawnIntervalFor(this.wave);
    this.spawnShip(this.queue.shift(), rift);
  }

  // ---- rifts ----------------------------------------------------------------

  ensureRifts(count) {
    for (let i = 0; i < this.rifts.length; i++) {
      if (i >= count && !this.rifts[i].closing) this.closeRift(this.rifts[i]);
    }
    while (this.rifts.filter((r) => !r.closing).length < count) {
      this.openRift();
    }
  }

  openRift() {
    const mesh = makeRift();
    const pos = this.pickSpawnPoint(_v1);
    mesh.position.copy(pos);
    mesh.lookAt(this.worldSun(_v2));
    this.group.add(mesh);
    const rift = { mesh, pos: mesh.position, k: 0, closing: false, dead: false, hum: null };
    this.rifts.push(rift);
    this.audio.riftOpen(rift.pos);
    return rift;
  }

  closeRift(rift) {
    rift.closing = true;
    rift.hum?.stop();
    rift.hum = null;
    this.audio.riftClose(rift.pos);
  }

  updateRift(rift, dt, t) {
    rift.k = Math.max(0, Math.min(1, rift.k + (rift.closing ? -dt / 0.4 : dt / 0.55)));
    rift.mesh.userData.setOpen(rift.k);
    rift.mesh.userData.animate(t);
    if (!rift.closing && rift.k >= 1 && !rift.hum) rift.hum = this.audio.riftHum(rift.pos);
    if (rift.closing && rift.k <= 0) {
      this.group.remove(rift.mesh);
      disposeRift(rift.mesh);
      rift.dead = true;
    }
  }

  // A shell around the garden, out past arm's reach. Mixed reality keeps it
  // tighter — the ships should cross your actual room, not the neighbour's.
  pickSpawnPoint(out) {
    const [rMin, rMax] = this.getXRMode() === 'ar'
      ? INVASION.spawnRadiusAR : INVASION.spawnRadiusVR;
    const a = Math.random() * Math.PI * 2;
    const r = rMin + Math.random() * (rMax - rMin);
    const [hMin, hMax] = INVASION.spawnHeight;
    this.worldSun(out);
    out.x += Math.cos(a) * r;
    out.z += Math.sin(a) * r;
    out.y = hMin + Math.random() * (hMax - hMin);
    return out;
  }

  // ---- ships ----------------------------------------------------------------

  spawnShip(type, rift) {
    const cfg = INVASION.ships[type];
    const mesh = makeShipMesh(type);
    mesh.position.copy(rift.pos);
    this.group.add(mesh);

    const trail = new Trail(ENEMY_GLOW[type], 46);
    this.group.add(trail.line);

    const ship = {
      type, cfg, mesh, trail,
      pos: mesh.position,
      // A fresh vector, never a shared temp: ship.vel is mutated every frame
      // for the ship's whole life. (Aliasing _v1 here once sent every ship
      // drifting skyward with the sun's coordinates as its velocity.)
      vel: this.worldSun(new THREE.Vector3()).sub(rift.pos).normalize()
        .multiplyScalar(cfg.speed * waveSpeedMul(this.wave)),
      speed: cfg.speed * waveSpeedMul(this.wave),
      hp: cfg.hp,
      phase: 'enter',
      target: null,
      cargo: null,
      beam: null,
      hum: null,
      reelT: 0,
      latchStart: new THREE.Vector3(),
      // Arrive at the garden's rim, outside the orbit shell — flying entry
      // straight through the middle fed the ships to their own swat rule.
      entryPoint: this.worldSun(new THREE.Vector3())
        .addScaledVector(flattenedDirection(), 1.15 + Math.random() * 0.5),
      orbitAngle: Math.atan2(rift.pos.z - this.worldSun(_v2).z, rift.pos.x - _v2.x),
      orbTimer: 2.5,
      retarget: 0,
      telegraphT: 0,      // grab-beam hover timer before a snatch lands
      strafe: null,       // {to, t, mark, knocked} while on an attack run
      exemptBody: null,   // the one planet this ship may approach unswatted
      weave: Math.random() * Math.PI * 2,
      spawnK: 0,
      despawnK: -1,
    };
    this.ships.push(ship);
    return ship;
  }

  updateShips(dt, t) {
    for (let i = this.ships.length - 1; i >= 0; i--) {
      const ship = this.ships[i];

      // Pop in through the rift; melt away when leaving.
      ship.spawnK = Math.min(1, ship.spawnK + dt / 0.4);
      if (ship.despawnK >= 0) {
        ship.despawnK += dt / 0.3;
        ship.mesh.scale.setScalar(Math.max(0.001, 1 - ship.despawnK));
        if (ship.despawnK >= 1) this.removeShip(ship);
        continue;
      }
      ship.mesh.scale.setScalar(ship.spawnK);

      if (ship.type === 'marauder') this.updateMarauder(ship, dt);
      else this.updateRaider(ship, dt);

      this.orientShip(ship, dt);
      ship.mesh.userData.animate(t, dt, ship.weave);
      ship.mesh.userData.updateFlash(dt);
      ship.trail.push(ship.pos);

      if (ship.beam?.visible) {
        ship.beam.userData.animate(t);
      }
    }
  }

  // Stingers and harvesters share a life: come in, pick something to steal,
  // telegraph the theft, steal it, run for a rift — and when there is
  // nothing worth stealing, fly attack runs instead of loitering.
  updateRaider(ship, dt) {
    const scale = this.garden.group.scale.x;
    // The one body a ship is working on doesn't swat it — everything else does.
    ship.exemptBody = ship.phase === 'strafe' ? ship.strafe?.mark
      : ship.target?.body ?? null;

    switch (ship.phase) {
      case 'enter': {
        this.flyToward(ship, ship.entryPoint, dt, true);
        if (ship.pos.distanceTo(ship.entryPoint) < 0.4) this.acquire(ship);
        break;
      }
      case 'hunt': {
        if (!this.targetValid(ship)) {
          ship.retarget -= dt;
          if (ship.retarget <= 0) this.acquire(ship);
          break;
        }
        // Chase where the prize is GOING (an orbiting planet outruns a
        // harvester in a stern chase), and engage at beam range — the
        // tractor reaches; the hull doesn't need to touch anything.
        const aim = this.targetAimPoint(ship, _v3);
        const prizeD = this.prizeWorldPos(ship, _v5).distanceTo(ship.pos);
        const inReach = prizeD < (ship.type === 'harvester' ? 0.5 : 0.24);
        this.flyToward(ship, aim, dt, ship.type === 'stinger', undefined,
          ship.type === 'harvester' ? 0.9 : 0.45);
        if (inReach) {
          if (ship.type === 'stinger') {
            ship.phase = 'grab';
            ship.telegraphT = 0;
          } else {
            this.latchTractor(ship);
          }
        }
        break;
      }
      case 'grab': {
        // The telegraph: shadow the prize with the grab beam lit. This is
        // the window to shoot the thief before the theft lands.
        if (!this.targetValid(ship)) {
          if (ship.beam) ship.beam.visible = false;
          this.acquire(ship);
          break;
        }
        const aim = this.targetAimPoint(ship, _v3);
        // Full speed with a tight arrive radius: hovers over a seed, keeps
        // pace with a planet on the move.
        this.flyToward(ship, aim, dt, false, undefined, 0.3);
        const prizeD = this.prizeWorldPos(ship, _v5).distanceTo(ship.pos);
        this.aimBeam(ship, ENEMY_GLOW.stinger, _v5, 0.08);
        ship.telegraphT += dt;
        if (ship.telegraphT >= INVASION.ai.grabTelegraph && prizeD < 0.35) {
          ship.beam.visible = false;
          this.snatch(ship);
        } else if (ship.telegraphT > INVASION.ai.grabTelegraph + 1.8) {
          ship.beam.visible = false; // the prize got away; line up again
          this.acquire(ship);
        }
        break;
      }
      case 'strafe': {
        this.updateStrafe(ship, dt);
        break;
      }
      case 'tractor': {
        this.dragWorldAway(ship, dt);
        break;
      }
      case 'flee': {
        const rift = this.nearestRift(ship.pos);
        if (!rift) { ship.despawnK = 0; break; }
        this.flyToward(ship, rift.pos, dt, false, INVASION.fleeSpeed);
        if (ship.pos.distanceTo(rift.pos) < 0.3) this.escapeThroughRift(ship);
        break;
      }
    }
    // Carried cargo rides under the keel, at garden scale.
    if (ship.cargo?.mesh) {
      ship.cargo.mesh.scale.setScalar(ship.cargo.radius * scale
        * (0.9 + Math.sin(this.time * 9) * 0.08));
    }
  }

  // Decide what to do next: steal if there's a target, otherwise dive.
  acquire(ship) {
    ship.retarget = INVASION.ai.retarget;
    if (this.pickTarget(ship)) {
      ship.phase = 'hunt';
    } else {
      this.beginStrafe(ship);
    }
  }

  // An attack run: pick a mark — a planet, the sun, or the player's own
  // head — and dive hard past it. A grazed planet takes a knock and throws
  // sparks; a buzzed player just gets a very close look at the enemy.
  beginStrafe(ship) {
    const bodies = this.sim.bodies.filter((b) => !b.held && !b.abducted);
    const mark = { body: null, head: false };
    const roll = Math.random();
    if (roll < INVASION.ai.headSwoopChance && this.getHead?.(_v1)) {
      mark.head = true; // _v1 already holds the head position
    } else if (bodies.length && roll < 0.85) {
      mark.body = bodies[(Math.random() * bodies.length) | 0];
      this.worldOfBody(mark.body, _v1);
    } else {
      this.worldSun(_v1);
    }
    // Buzz the player at a respectful distance; graze planets closely.
    const graze = mark.head ? 0.4 : INVASION.ai.strafeGraze;
    const overshoot = mark.head ? 1.2 : INVASION.ai.strafeOvershoot;
    const to = strafeThrough(
      ship.pos.x, ship.pos.y, ship.pos.z, _v1.x, _v1.y, _v1.z,
      graze, overshoot, Math.random() < 0.5 ? -1 : 1);
    ship.strafe = {
      to: new THREE.Vector3(to[0], to[1], to[2]),
      t: 0,
      mark: mark.body,
      knocked: false,
    };
    ship.phase = 'strafe';
  }

  updateStrafe(ship, dt) {
    const run = ship.strafe;
    if (!run) { this.acquire(ship); return; }
    run.t += dt;
    this.flyToward(ship, run.to, dt, false, ship.speed * INVASION.ai.strafeSpeedMul);

    // The graze: rattle the mark as the ship slices past.
    const body = run.mark;
    if (body && !run.knocked && body.alive && !body.held && !body.abducted) {
      const scale = this.garden.group.scale.x;
      this.worldOfBody(body, _v1);
      if (ship.pos.distanceTo(_v1) < INVASION.ai.knockRadius + body.radius * scale) {
        run.knocked = true;
        _v2.copy(ship.vel).normalize().multiplyScalar(INVASION.ai.knockSpeed / scale);
        body.vel.add(_v2);
        this.garden.trailOf(body)?.reset();
        this.explosions.burst(_v1, ENEMY_GLOW[ship.type], 0.35);
        this.audio.shipHit(_v1);
      }
    }

    if (ship.pos.distanceTo(run.to) < 0.3 || run.t > INVASION.ai.strafeTimeout) {
      ship.strafe = null;
      this.acquire(ship);
    }
  }

  // The prize itself (no hover offset): where a grab beam should point.
  prizeWorldPos(ship, out) {
    const t = ship.target;
    if (t?.kind === 'seed' && t.slot.mesh) return this.garden.nursery.orbWorldPos(t.slot, out);
    if (t?.kind === 'planet' && t.body.alive) return this.worldOfBody(t.body, out);
    return out.copy(ship.entryPoint);
  }

  // Point a ship's under-keel beam at a world-space target.
  aimBeam(ship, colorHex, target, girth) {
    if (!ship.beam) {
      ship.beam = makeTractorBeam(colorHex);
      this.group.add(ship.beam);
    }
    ship.beam.visible = true;
    ship.beam.position.copy(ship.pos);
    const len = Math.max(0.05, ship.pos.distanceTo(target));
    _v2.subVectors(target, ship.pos).normalize();
    ship.beam.quaternion.setFromUnitVectors(NEG_Y, _v2);
    ship.beam.scale.set(girth, len, girth);
  }

  updateMarauder(ship, dt) {
    // Circle the garden at bombardment range, throwing slow plasma.
    const center = this.worldSun(_v1);
    const r = INVASION.marauderOrbitRadius;
    ship.orbitAngle += (ship.speed / r) * dt;
    _v2.set(center.x + Math.cos(ship.orbitAngle) * r, center.y + 0.42,
      center.z + Math.sin(ship.orbitAngle) * r);
    this.flyToward(ship, _v2, dt, false);

    ship.orbTimer -= dt;
    if (ship.orbTimer <= 0) {
      ship.orbTimer = INVASION.orbEverySeconds;
      this.fireOrb(ship);
    }
  }

  // arriveRadius > 0 turns seek into arrive: the ship slows as it closes,
  // which shrinks its turning circle — without this, a slow-turning barge
  // orbits its destination forever, always a metre short.
  flyToward(ship, target, dt, weave, speedOverride, arriveRadius = 0) {
    let speed = speedOverride ?? ship.speed;
    if (arriveRadius > 0) {
      const dist = ship.pos.distanceTo(target);
      speed *= Math.max(0.15, Math.min(1, dist / arriveRadius));
    }
    _v4.copy(target);
    if (weave) {
      // Stingers never fly straight: a sideways sine that fades on approach.
      const dist = ship.pos.distanceTo(target);
      _v2.subVectors(target, ship.pos).normalize();
      _v3.crossVectors(_v2, UP).normalize();
      _v4.addScaledVector(_v3,
        Math.sin(this.time * 3.6 + ship.weave) * 0.3 * Math.min(1, dist / 1.2));
    }
    _v2.subVectors(_v4, ship.pos).normalize().multiplyScalar(speed);
    ship.vel.lerp(_v2, Math.min(1, ship.cfg.turnRate * dt));
    ship.pos.addScaledVector(ship.vel, dt);
  }

  orientShip(ship, dt) {
    if (ship.vel.lengthSq() < 1e-6) return;
    // Matrix4.lookAt(eye→target) leaves -Z along (target-eye): ships are
    // modelled nose-down-negative-Z, so eye=origin, target=velocity.
    _m1.lookAt(_v1.set(0, 0, 0), _v2.copy(ship.vel), UP);
    _q1.setFromRotationMatrix(_m1);
    // Bank into the turn: roll against the yaw rate, like anything that flies.
    const heading = Math.atan2(ship.vel.x, ship.vel.z);
    const yawRate = ship.lastHeading === undefined ? 0
      : angleDelta(heading, ship.lastHeading) / Math.max(dt, 1e-4);
    ship.lastHeading = heading;
    const bank = Math.max(-0.65, Math.min(0.65, yawRate * 0.22));
    _q2.setFromAxisAngle(_v3.copy(ship.vel).normalize(), -bank);
    _q1.premultiply(_q2);
    ship.mesh.quaternion.slerp(_q1, Math.min(1, dt * 7));
  }

  // ---- what ships want -------------------------------------------------------

  // Stingers snatch nursery seeds and pocket-sized planets; harvesters take
  // the biggest world you have. Siblings don't pile onto the same prize.
  // Returns whether anything stealable was found.
  pickTarget(ship) {
    const claimed = (thing, key) =>
      this.ships.some((s) => s !== ship && s.target?.[key] === thing);
    const candidates = [];
    if (ship.type === 'stinger') {
      for (const slot of this.garden.nursery.slots) {
        if (slot.mesh && slot.growth >= 1 && !claimed(slot, 'slot')) {
          candidates.push({ kind: 'seed', slot });
        }
      }
      for (const body of this.sim.bodies) {
        if (!body.held && !body.abducted && body.radius <= INVASION.stealRadiusMax
          && !claimed(body, 'body')) {
          candidates.push({ kind: 'planet', body });
        }
      }
    } else {
      let biggest = null;
      for (const body of this.sim.bodies) {
        if (body.held || body.abducted || claimed(body, 'body')) continue;
        if (!biggest || body.radius > biggest.radius) biggest = body;
      }
      if (biggest) candidates.push({ kind: 'planet', body: biggest });
    }
    ship.target = candidates.length
      ? candidates[(Math.random() * candidates.length) | 0] : null;
    return !!ship.target;
  }

  targetValid(ship) {
    const t = ship.target;
    if (!t) return false;
    if (t.kind === 'seed') return !!t.slot.mesh && t.slot.growth >= 1;
    return t.body.alive && !t.body.held && !t.body.abducted;
  }

  // Where the ship flies to work on its target: over the prize at beam
  // height — and for a planet, over where the orbit is about to carry it.
  // The lead is predicted in garden space, so it survives any world grip.
  targetAimPoint(ship, out) {
    if (!this.targetValid(ship)) return out.copy(ship.entryPoint);
    const t = ship.target;
    if (t.kind === 'planet') {
      const dist = this.worldOfBody(t.body, out).distanceTo(ship.pos);
      const lead = Math.max(0.2, Math.min(1.4,
        (dist / Math.max(0.1, ship.speed)) * 0.5));
      _v5.copy(t.body.pos).addScaledVector(t.body.vel, lead);
      this.garden.group.localToWorld(out.copy(_v5));
    } else {
      this.prizeWorldPos(ship, out);
    }
    out.y += ship.type === 'harvester' ? 0.28 : 0.1;
    return out;
  }

  // ---- stealing -------------------------------------------------------------

  // A stinger grabs its prize and runs.
  snatch(ship) {
    const t = ship.target;
    const scale = this.garden.group.scale.x;
    if (t.kind === 'seed') {
      if (!t.slot.mesh) { ship.target = null; return; }
      const { mesh, radius, colorIndex } = this.garden.nursery.take(t.slot);
      ship.cargo = { kind: 'seed', mesh, radius, colorIndex, hasRing: false };
      ship.mesh.add(mesh);
      mesh.position.set(0, -0.055, 0.02);
      mesh.scale.setScalar(radius * scale);
    } else {
      const body = t.body;
      const cargo = this.garden.abductPlanet(body);
      if (!cargo) { ship.target = null; return; }
      ship.cargo = { kind: 'planet', ...cargo };
      ship.mesh.add(cargo.mesh);
      cargo.mesh.position.set(0, -0.055, 0.02);
      cargo.mesh.scale.setScalar(cargo.radius * scale);
    }
    // Announce the theft — the courier is now the priority target.
    this.popups.spawn(t.kind === 'seed' ? 'SEED STOLEN' : 'WORLD SNATCHED',
      ship.pos, '#ff6a5a', t.kind === 'seed' ? 0.9 : 1.1);
    ship.target = null;
    ship.phase = 'flee';
    this.audio.grab();
  }

  // A harvester parks over a planet and switches on the beam. The planet
  // stays in the sim as a kinematic body, reeled up to the keel, so its
  // gravity still tugs its siblings all the way out.
  latchTractor(ship) {
    const t = ship.target;
    if (!t || t.kind !== 'planet' || !this.targetValid(ship)) {
      ship.target = null;
      return;
    }
    const body = t.body;
    body.held = true;
    body.abducted = true;
    ship.phase = 'tractor';
    ship.reelT = 0;
    this.worldOfBody(body, ship.latchStart);
    if (!ship.beam) {
      ship.beam = makeTractorBeam();
      this.group.add(ship.beam);
    }
    ship.beam.visible = true;
    ship.hum = this.audio.tractorHum(ship.pos);
    this.garden.trailOf(body)?.reset();
  }

  dragWorldAway(ship, dt) {
    const body = ship.target?.body;
    if (!body || !body.alive) { this.releaseTractor(ship); ship.phase = 'hunt'; return; }
    const scale = this.garden.group.scale.x;

    // Drift for the exit while the reel-in runs.
    const rift = this.nearestRift(ship.pos);
    if (rift) this.flyToward(ship, rift.pos, dt, false, ship.speed * 0.7);

    ship.reelT = Math.min(1, ship.reelT + dt / INVASION.tractorReel);
    const hang = 0.2 + body.radius * scale * 1.6;
    _v1.copy(ship.pos);
    _v1.y -= hang;
    _v2.copy(ship.latchStart).lerp(_v1, easeInOut(ship.reelT));

    // Write the world-space hold back into garden space.
    const prev = _v3.copy(body.pos);
    body.pos.copy(this.garden.group.worldToLocal(_v4.copy(_v2)));
    body.vel.copy(body.pos).sub(prev).divideScalar(Math.max(dt, 1e-4));

    // Aim the beam from keel to cargo.
    ship.beam.position.copy(ship.pos);
    const len = Math.max(0.05, ship.pos.distanceTo(_v2));
    _v4.subVectors(_v2, ship.pos).normalize();
    ship.beam.quaternion.setFromUnitVectors(NEG_Y, _v4);
    const girth = Math.min(0.5, Math.max(0.14, body.radius * scale * 3));
    ship.beam.scale.set(girth, len + body.radius * scale, girth);
    ship.hum?.move(ship.pos);

    if (rift && ship.pos.distanceTo(rift.pos) < 0.32) {
      // Gone. The garden is one world poorer.
      this.worldOfBody(body, _v1);
      this.sim.remove(body);
      this.garden.removeVisuals(body, true);
      this.releaseTractor(ship, true);
      this.worldsLost++;
      this.audio.worldStolen(_v1);
      this.popups.spawn('WORLD TAKEN', _v1, '#ff6a5a', 1.3);
      ship.cargo = null;
      ship.despawnK = 0;
    }
  }

  releaseTractor(ship, silent = false) {
    const body = ship.target?.body;
    if (body?.abducted) {
      body.held = false;
      body.abducted = false;
      body.vel.clampLength(0, 1.2); // dropped, not launched
      this.garden.trailOf(body)?.reset();
    }
    if (ship.beam) ship.beam.visible = false;
    ship.hum?.stop();
    ship.hum = null;
    if (!silent && body?.alive) {
      this.worldOfBody(body, _v1);
      this.addScore(INVASION.score.rescue, `RESCUE +${INVASION.score.rescue}`, _v1, '#8dff5a');
      this.audio.rescue(_v1);
    }
    ship.target = null;
  }

  // A courier reaching a rift takes its cargo out of the universe.
  escapeThroughRift(ship) {
    if (ship.cargo) {
      const isWorld = ship.cargo.kind === 'planet';
      if (isWorld) this.worldsLost++;
      this.audio.worldStolen(ship.pos);
      this.popups.spawn(isWorld ? 'WORLD TAKEN' : 'SEED TAKEN', ship.pos,
        '#ff6a5a', isWorld ? 1.3 : 1);
      ship.cargo.mesh.parent?.remove(ship.cargo.mesh);
      disposePlanetMesh(ship.cargo.mesh);
      ship.cargo = null;
    }
    ship.despawnK = 0;
  }

  // A killed courier drops its prize back into the garden — with a little
  // velocity, so a rescued world sometimes falls straight into a new orbit.
  dropCargo(ship) {
    const cargo = ship.cargo;
    ship.cargo = null;
    if (!cargo) return;
    const scale = this.garden.group.scale.x;
    cargo.mesh.getWorldPosition(_v1);
    this.garden.group.worldToLocal(_v1);
    _v2.set((Math.random() - 0.5) * 0.4, -0.15, (Math.random() - 0.5) * 0.4)
      .divideScalar(scale);
    const body = this.garden.addPlanet(_v1, _v2, cargo.radius, cargo.colorIndex, cargo.mesh);
    body.hasRing = body.hasRing || cargo.hasRing;
    cargo.mesh.scale.setScalar(cargo.radius);
    cargo.mesh.rotation.set(0, cargo.mesh.rotation.y, 0);
    this.addScore(INVASION.score.rescue, `RESCUE +${INVASION.score.rescue}`,
      this.worldOfBody(body, _v3), '#8dff5a');
    this.audio.rescue(_v3);
  }

  // ---- the marauder's plasma --------------------------------------------------

  fireOrb(ship) {
    const targets = this.sim.bodies.filter((b) => !b.held && !b.abducted);
    const target = targets.length && Math.random() < 0.6
      ? { kind: 'planet', body: targets[(Math.random() * targets.length) | 0] }
      : { kind: 'sun' };
    const mesh = makeOrbMesh();
    mesh.position.copy(ship.pos);
    this.group.add(mesh);
    this.orbs.push({
      mesh, pos: mesh.position, target,
      vel: this.orbTargetPoint(target, _v1).sub(ship.pos).normalize()
        .multiplyScalar(INVASION.orbSpeed),
      life: 14,
      phase: Math.random() * Math.PI * 2,
    });
    this.audio.plasmaLaunch(ship.pos);
  }

  orbTargetPoint(target, out) {
    if (target.kind === 'planet' && target.body.alive && !target.body.abducted) {
      return this.worldOfBody(target.body, out);
    }
    return this.worldSun(out);
  }

  updateOrbs(dt, t) {
    const scale = this.garden.group.scale.x;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      orb.life -= dt;
      if (orb.life <= 0) { this.removeOrb(orb, false); continue; }

      // Gentle homing: plasma drifts, it doesn't chase.
      this.orbTargetPoint(orb.target, _v1).sub(orb.pos).normalize()
        .multiplyScalar(INVASION.orbSpeed);
      orb.vel.lerp(_v1, Math.min(1, dt * 0.9));
      orb.pos.addScaledVector(orb.vel, dt);
      orb.mesh.userData.animate(t, orb.phase);

      // Impact: the sun shrugs it off but loses appetite; a planet is
      // knocked hard — sometimes into a worse orbit, which is the point.
      const sun = this.worldSun(_v2);
      if (orb.pos.distanceTo(sun) < this.sim.sun.radius * scale + INVASION.orbHitRadius) {
        this.sim.sun.meals = Math.max(0, this.sim.sun.meals - 1);
        this.sunFx?.eat();
        this.audio.plasmaImpact(orb.pos);
        this.explosions.burst(orb.pos, ENEMY_GLOW.marauder, 0.8);
        this.popups.spawn('SUN STUNG', orb.pos, '#ff6a5a');
        this.removeOrb(orb, false);
        continue;
      }
      for (const body of this.sim.bodies) {
        if (body.abducted) continue;
        this.worldOfBody(body, _v3);
        if (orb.pos.distanceTo(_v3) < body.radius * scale + INVASION.orbHitRadius) {
          _v4.subVectors(_v3, orb.pos).normalize()
            .multiplyScalar(INVASION.orbKnock / scale);
          body.vel.add(_v4);
          this.garden.trailOf(body)?.reset();
          this.audio.plasmaImpact(orb.pos);
          this.explosions.burst(orb.pos, ENEMY_GLOW.marauder, 0.8);
          this.removeOrb(orb, false);
          break;
        }
      }
    }
  }

  removeOrb(orb, shot) {
    const i = this.orbs.indexOf(orb);
    if (i !== -1) this.orbs.splice(i, 1);
    if (shot) {
      this.explosions.burst(orb.pos, ENEMY_GLOW.marauder, 0.7);
      this.audio.shipHit(orb.pos);
    }
    this.group.remove(orb.mesh);
    disposeOrbMesh(orb.mesh);
  }

  // ---- the blasters -----------------------------------------------------------

  updateShooters(dt) {
    if (!this.input) return;
    for (let i = 0; i < 3; i++) {
      const grabber = this.input.grabbers[i];
      const shooter = this.shooters[i];
      const wasOverheated = shooter.heatState.overheated;
      shooter.heatState = heatCool(shooter.heatState, dt);
      if (wasOverheated && !shooter.heatState.overheated) this.audio.blasterReady();

      // Dual wielding is allowed: grip a planet, keep the trigger down.
      const firing = !!grabber?.firing;
      if (firing && canFire(shooter.heatState)) {
        shooter.accum += dt * INVASION.blaster.rate;
        // A full trigger pull fires immediately, then keeps cadence.
        if (shooter.wasIdle) { shooter.accum = Math.max(shooter.accum, 1); shooter.wasIdle = false; }
        while (shooter.accum >= 1) {
          shooter.accum -= 1;
          this.fireBolt(i, grabber);
          shooter.heatState = heatAfterShot(shooter.heatState);
          if (shooter.heatState.overheated) {
            this.audio.overheat();
            grabber.pulse?.(0.7, 140);
            break;
          }
        }
      } else {
        shooter.accum = 0;
        shooter.wasIdle = true;
      }
    }
    this.updateBlasterVisuals(true);
  }

  updateBlasterVisuals(activeMode) {
    for (let i = 0; i < this.blasters.length; i++) {
      const blaster = this.blasters[i];
      const grabber = this.input?.grabbers[i];
      const isController = !!grabber?.inputSource?.gamepad && !grabber.inputSource.hand;
      blaster.visible = activeMode && !!grabber?.active && isController;
      if (blaster.visible) {
        const hs = this.shooters[i].heatState;
        blaster.userData.setHeat(hs.heat, hs.overheated);
      }
      blaster.userData.animate(1 / 60);
    }
  }

  shooterPose(i, grabber, origin, dir) {
    if (i === 2) {
      // Mouse: from just under the camera, along the cursor ray.
      if (!this.input.getMouseRay(origin, dir)) return false;
      origin.y -= 0.09;
      return true;
    }
    const space = grabber.raySpace;
    if (!space) return false;
    space.getWorldPosition(origin);
    space.getWorldQuaternion(_q1);
    dir.set(0, 0, -1).applyQuaternion(_q1);
    return true;
  }

  fireBolt(i, grabber) {
    if (!this.shooterPose(i, grabber, _v1, _v2)) return;

    // Aim assist: if the shot is nearly on a ship, bend it kindly. A 7 cm
    // stinger at 3 m is a two-degree target — the cone does the last degree.
    let best = null;
    let bestAngle = INVASION.blaster.assistCone;
    const consider = (pos) => {
      _v3.subVectors(pos, _v1);
      const dist = _v3.length();
      if (dist < 0.2 || dist > 9) return;
      const angle = _v3.normalize().angleTo(_v2);
      if (angle < bestAngle) { bestAngle = angle; best = _v4.copy(_v3); }
    };
    for (const ship of this.ships) if (ship.despawnK < 0) consider(ship.pos);
    for (const orb of this.orbs) consider(orb.pos);
    if (best) _v2.lerp(best, INVASION.blaster.assistBend).normalize();

    // Then a hose's worth of jitter.
    _v2.x += (Math.random() - 0.5) * INVASION.blaster.spread;
    _v2.y += (Math.random() - 0.5) * INVASION.blaster.spread;
    _v2.z += (Math.random() - 0.5) * INVASION.blaster.spread;
    _v2.normalize();

    _v1.addScaledVector(_v2, 0.09);
    this.bolts.fire(_v1, _v2, grabber);
    this.audio.blasterShot();
    grabber.pulse?.(0.28, 14);
    this.blasters[i]?.userData.flash();
  }

  // ---- collisions -------------------------------------------------------------

  collideBolts() {
    const scale = this.garden.group.scale.x;
    const sun = this.worldSun(_v1);
    outer: for (const bolt of [...this.bolts.bolts]) {
      const { prev, pos } = bolt;

      for (const ship of [...this.ships]) {
        if (ship.despawnK >= 0 || ship.hp <= 0) continue;
        if (segmentSphereHit(prev.x, prev.y, prev.z, pos.x, pos.y, pos.z,
          ship.pos.x, ship.pos.y, ship.pos.z, ship.cfg.hitRadius)) {
          this.bolts.kill(bolt);
          this.hitShip(ship, 1, bolt.grabber);
          continue outer;
        }
      }
      for (const orb of [...this.orbs]) {
        if (segmentSphereHit(prev.x, prev.y, prev.z, pos.x, pos.y, pos.z,
          orb.pos.x, orb.pos.y, orb.pos.z, INVASION.orbHitRadius + 0.03)) {
          this.bolts.kill(bolt);
          this.removeOrb(orb, true);
          this.addScore(INVASION.score.orb, `+${INVASION.score.orb}`, orb.pos, '#9fdcff', 0.8);
          bolt.grabber?.pulse?.(0.4, 30);
          continue outer;
        }
      }
      // Friendly sky: bolts fizz out on the sun and on your own worlds.
      if (pos.distanceTo(sun) < this.sim.sun.radius * scale) {
        this.bolts.kill(bolt);
        continue;
      }
      for (const body of this.sim.bodies) {
        this.worldOfBody(body, _v2);
        if (pos.distanceTo(_v2) < body.radius * scale + 0.01) {
          this.bolts.kill(bolt);
          break;
        }
      }
    }
  }

  // Ship meets world: the garden's own physics is a legal weapon, whether
  // the planet was thrown, orbiting, or still in your hand. A short immunity
  // after each hit keeps a lingering overlap from landing once per frame.
  collideSwats(dt) {
    const scale = this.garden.group.scale.x;
    for (const ship of [...this.ships]) {
      ship.swatCd = Math.max(0, (ship.swatCd ?? 0) - dt);
      if (ship.despawnK >= 0 || ship.spawnK < 1 || ship.swatCd > 0) continue;
      for (const body of this.sim.bodies) {
        // A ship's own prize (or strafe mark) can't swat it — thieves get to
        // reach what they're stealing. Everything else in orbit is a mine.
        if (body.abducted || body === ship.exemptBody) continue;
        this.worldOfBody(body, _v1);
        if (ship.pos.distanceTo(_v1) < ship.cfg.hitRadius * 0.9 + body.radius * scale) {
          body.vel.multiplyScalar(0.6);
          this.audio.swat(ship.pos);
          ship.swatCd = 0.8;
          if (ship.type === 'marauder') {
            this.hitShip(ship, 8, null, 'swat');
          } else {
            this.killShip(ship, 'swat', null);
          }
          break;
        }
      }
    }
  }

  hitShip(ship, damage, grabber, cause = 'shot') {
    ship.hp -= damage;
    ship.mesh.userData.setFlash(1);
    if (ship.hp <= 0) {
      this.killShip(ship, cause, grabber);
    } else {
      this.audio.shipHit(ship.pos);
      grabber?.pulse?.(0.35, 22);
    }
  }

  killShip(ship, cause, grabber) {
    const base = ship.cfg.score;
    let pts = base;
    let label;
    if (cause === 'swat') {
      pts = base + INVASION.score.swat;
      label = `SWAT +${pts}`;
    } else if (cause === 'nova') {
      label = `NOVA +${pts}`;
    } else {
      this.combo.kills = comboAdvance(this.combo.kills, this.time - this.combo.lastAt);
      this.combo.lastAt = this.time;
      const mult = comboMultiplier(this.combo.kills);
      pts = base * mult;
      label = mult > 1 ? `+${pts} ×${mult}` : `+${pts}`;
      if (mult > 1) this.audio.comboNote(ship.pos, this.combo.kills);
    }
    this.kills++;
    this.addScore(pts, label, ship.pos,
      cause === 'swat' ? '#ffd9a0' : '#9fdcff', ship.type === 'marauder' ? 1.4 : 1);

    if (ship.phase === 'tractor') this.releaseTractor(ship);
    if (ship.cargo) this.dropCargo(ship);
    this.audio.shipExplode(ship.pos, SHIP_SIZE[ship.type]);
    this.explosions.burst(ship.pos, ENEMY_GLOW[ship.type], SHIP_SIZE[ship.type]);
    grabber?.pulse?.(0.6, 70);
    this.removeShip(ship);
  }

  removeShip(ship) {
    if (ship.phase === 'tractor') this.releaseTractor(ship, true);
    ship.hum?.stop();
    if (ship.beam) {
      this.group.remove(ship.beam);
      ship.beam.geometry.dispose();
      ship.beam.material.dispose();
    }
    if (ship.cargo?.mesh) {
      ship.cargo.mesh.parent?.remove(ship.cargo.mesh);
      disposePlanetMesh(ship.cargo.mesh);
    }
    ship.trail.line.parent?.remove(ship.trail.line);
    ship.trail.dispose();
    this.group.remove(ship.mesh);
    disposeShipMesh(ship.mesh);
    const i = this.ships.indexOf(ship);
    if (i !== -1) this.ships.splice(i, 1);
  }

  // The sun's nova already hurls planets; now it also scours the sky.
  // Feeding the sun to eight during a siege is a deliberate, delicious play.
  onNova() {
    if (!this.active) return;
    const sun = this.worldSun(_v1);
    const radius = 3.5 * this.garden.group.scale.x;
    for (const ship of [...this.ships]) {
      if (ship.pos.distanceTo(sun) > radius) continue;
      if (ship.type === 'marauder' && ship.hp > 8) {
        this.hitShip(ship, 8, null, 'nova');
      } else {
        this.killShip(ship, 'nova', null);
      }
    }
    for (const orb of [...this.orbs]) this.removeOrb(orb, true);
  }

  // ---- bookkeeping ------------------------------------------------------------

  addScore(pts, label, pos, color, scale = 1) {
    this.score += pts;
    if (this.score > this.best) {
      this.best = this.score;
      writeBest(this.best);
    }
    if (label) this.popups.spawn(label, pos, color, scale);
  }

  worldSun(out) {
    return this.garden.group.localToWorld(out.copy(this.sim.sun.pos));
  }

  worldOfBody(body, out) {
    return this.garden.group.localToWorld(out.copy(body.pos));
  }

  nearestRift(pos) {
    let best = null;
    let bestD = Infinity;
    for (const rift of this.rifts) {
      if (rift.closing) continue;
      const d = pos.distanceTo(rift.pos);
      if (d < bestD) { best = rift; bestD = d; }
    }
    return best;
  }

  getStats() {
    const hot = this.time - this.combo.lastAt <= INVASION.score.comboWindow;
    return {
      active: this.active,
      state: this.state,
      wave: this.wave,
      score: this.score,
      best: this.best,
      mult: hot ? comboMultiplier(this.combo.kills) : 1,
      kills: this.kills,
      worldsLost: this.worldsLost,
      inbound: this.queue.length + this.ships.length,
      nextIn: this.state === 'intermission'
        ? Math.max(0, Math.ceil(INVASION.intermission - this.stateT)) : 0,
    };
  }

  // ---- test hooks (smoke.mjs drives these headlessly) -------------------------

  debugSpawn(type, pos) {
    const rift = this.rifts.find((r) => !r.closing) ?? this.openRift();
    rift.k = 1;
    rift.mesh.userData.setOpen(1);
    const ship = this.spawnShip(type, rift);
    if (pos) ship.pos.set(pos[0], pos[1], pos[2]);
    return ship;
  }

  debugFireAt(ship) {
    _v1.copy(ship.pos).add(_v2.set(0, 0, 1.5));
    _v2.subVectors(ship.pos, _v1).normalize();
    this.bolts.fire(_v1, _v2, null);
  }
}

function emptyShooter() {
  return { heatState: { heat: 0, overheated: false }, accum: 0, wasIdle: true };
}

// A random direction squashed toward the horizontal, so entry points ring
// the garden at orbit height instead of arriving from straight above.
function flattenedDirection() {
  const dir = new THREE.Vector3().randomDirection();
  dir.y *= 0.4;
  return dir.normalize();
}

function easeInOut(k) {
  return k * k * (3 - 2 * k);
}

function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function readBest() {
  try {
    return Number(localStorage.getItem('gg-invasion-best')) || 0;
  } catch {
    return 0;
  }
}

function writeBest(v) {
  try {
    localStorage.setItem('gg-invasion-best', String(v));
  } catch { /* private mode: the high score dies with the tab */ }
}
