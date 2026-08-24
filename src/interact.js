import * as THREE from 'three';
import { THROW, TIME, PREDICT, SUN, ASSIST, GRIP } from './config.js';
import { setShellState } from './planets.js';

// Grabbing, throwing, steering time, and gripping space itself — for XR
// controllers, tracked hands, and (on a flat screen) the mouse. All three are
// the same Grabber underneath: a point with a velocity history and maybe a
// held body.
//
// The garden lives inside a transform group the player can scale, pan and
// turn, so all grab logic runs in *garden space*: hand poses arrive in world
// coordinates and are converted immediately. While a body is held, its future
// path under gravity is integrated every frame and drawn as a ghost arc —
// with orbit assist applied, so the arc never lies about the throw.

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

class Grabber {
  constructor() {
    this.active = false;
    this.worldPos = new THREE.Vector3(); // raw hand/pointer pose
    this.pos = new THREE.Vector3();      // same point in garden space
    this.history = [];                   // {p: garden-space Vector3, t: seconds}
    this.held = null;
    this.holdOffset = new THREE.Vector3();
    this.pressCount = 0;
    this.inputSource = null;
    this.buttonsPrev = [];
  }

  recordHistory(t) {
    this.history.push({ p: this.pos.clone(), t });
    while (this.history.length > THROW.smoothFrames) this.history.shift();
  }

  velocity(out) {
    const h = this.history;
    if (h.length < 2) return out.set(0, 0, 0);
    const a = h[0], b = h[h.length - 1];
    const dt = Math.max(1e-3, b.t - a.t);
    return out.subVectors(b.p, a.p).divideScalar(dt);
  }

  pulse(intensity, ms) {
    this.inputSource?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, ms);
  }
}

export class Interactions {
  constructor({ renderer, camera, scene, sim, garden, audio, actions, dom }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.sim = sim;
    this.garden = garden;       // garden.group is the transform we grip
    this.audio = audio;
    this.actions = actions;
    this.hovered = new Set();
    this.predictBuf = new Float32Array(PREDICT.steps * 3);
    this.grip = null;           // active two-handed world grip, or null
    this.resetLatch = false;

    this.grabbers = [new Grabber(), new Grabber(), new Grabber()]; // L, R, mouse
    this.mouseGrabber = this.grabbers[2];

    this.setupXR();
    this.setupDesktop(dom);
  }

  toGarden(v) {
    return this.garden.group.worldToLocal(v);
  }

  gardenScale() {
    return this.garden.group.scale.x;
  }

  // ---- XR input -------------------------------------------------------------

  setupXR() {
    this.hands = [];
    this.controllerVisuals = [];

    for (let i = 0; i < 2; i++) {
      const grabber = this.grabbers[i];
      const controller = this.renderer.xr.getController(i);
      const grip = this.renderer.xr.getControllerGrip(i);
      const hand = this.renderer.xr.getHand(i);
      this.scene.add(controller, grip, hand);

      controller.addEventListener('connected', (e) => {
        grabber.inputSource = e.data;
        grabber.active = true;
        visual.visible = !e.data.hand;
      });
      controller.addEventListener('disconnected', () => {
        this.release(grabber, true);
        grabber.inputSource = null;
        grabber.active = false;
        grabber.pressCount = 0;
        visual.visible = false;
      });

      // Trigger and grip both grab; hands fire select on system pinch.
      const press = () => {
        if (++grabber.pressCount === 1) this.tryGrab(grabber);
      };
      const unpress = () => {
        if (grabber.pressCount > 0 && --grabber.pressCount === 0) this.release(grabber);
      };
      controller.addEventListener('selectstart', press);
      controller.addEventListener('selectend', unpress);
      controller.addEventListener('squeezestart', press);
      controller.addEventListener('squeezeend', unpress);

      // A soft glowing orb where your grip is — no downloaded controller models.
      const visual = new THREE.Group();
      const orb = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.022, 2),
        new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.85 })
      );
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.034, 0.0035, 8, 32),
        new THREE.MeshBasicMaterial({ color: 0x67d7ff, transparent: true, opacity: 0.5 })
      );
      halo.rotation.x = Math.PI / 2;
      visual.add(orb, halo);
      visual.visible = false;
      grip.add(visual);

      grabber.grip = grip;
      grabber.hand = hand;
      this.controllerVisuals.push(visual);

      // Tracked hands drawn as constellations of small joint spheres.
      const jointMesh = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(0.0075, 1),
        new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.7 }),
        25
      );
      jointMesh.count = 0;
      jointMesh.frustumCulled = false;
      this.scene.add(jointMesh);
      this.hands.push({ hand, jointMesh });
    }

    // Ghost arcs, one per hand plus one for the mouse — drawn in garden space.
    this.predictLines = this.grabbers.map(() => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREDICT.steps * 3), 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0xbfe9ff, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      line.frustumCulled = false;
      line.visible = false;
      this.garden.group.add(line);
      return line;
    });
  }

  // ---- grabbing ---------------------------------------------------------------

  grabPointWorld(grabber, out) {
    const src = grabber.inputSource;
    if (src?.hand && grabber.hand) {
      const tip = grabber.hand.joints['index-finger-tip'];
      const thumb = grabber.hand.joints['thumb-tip'];
      if (tip?.visible && thumb?.visible) {
        tip.getWorldPosition(_v1);
        thumb.getWorldPosition(_v2);
        return out.addVectors(_v1, _v2).multiplyScalar(0.5);
      }
    }
    return grabber.grip ? grabber.grip.getWorldPosition(out) : out.copy(grabber.worldPos);
  }

  // Nearest free planet or nursery seed within reach of a garden-space point.
  // Reach grows as the garden shrinks, so a zoomed-out garden is still easy
  // to pick from.
  findGrabbable(p) {
    const reach = THROW.grabRadius / this.gardenScale();
    let best = null;
    let bestDist = Infinity;
    for (const body of this.sim.bodies) {
      if (body.held) continue;
      const d = p.distanceTo(body.pos) - body.radius;
      if (d < reach && d < bestDist) {
        best = { kind: 'planet', body };
        bestDist = d;
      }
    }
    for (const slot of this.garden.nursery.slots) {
      if (!slot.mesh || slot.growth < 0.5) continue;
      this.garden.nursery.orbWorldPos(slot, _v3);
      this.toGarden(_v3);
      const d = p.distanceTo(_v3) - slot.radius;
      if (d < reach && d < bestDist) {
        best = { kind: 'seed', slot };
        bestDist = d;
      }
    }
    return best;
  }

  tryGrab(grabber) {
    if (grabber.held) return;
    const target = this.findGrabbable(grabber.pos);
    if (!target) return;

    let body;
    if (target.kind === 'seed') {
      body = this.garden.plantSeed(target.slot);
      if (!body) return;
      grabber.holdOffset.set(0, 0, 0);
    } else {
      body = target.body;
      grabber.holdOffset.subVectors(body.pos, grabber.pos)
        .clampLength(0, 0.05 / this.gardenScale());
      this.garden.trailOf(body)?.reset();
    }
    body.held = true;
    grabber.held = body;
    setShellState(body.mesh, 'held');
    this.audio.grab();
    grabber.pulse(0.35, 40);
  }

  // The velocity a body would leave the hand with right now: smoothed hand
  // velocity, scaled, then bent by orbit assist — capped just under the local
  // escape speed unless the throw is an unmistakable hurl.
  throwVelocity(grabber, pos, out) {
    grabber.velocity(out).multiplyScalar(THROW.velocityScale).clampLength(0, 5);
    const speed = out.length();
    const esc = this.sim.escapeSpeedAt(pos);
    if (speed > esc * ASSIST.cap && speed < esc * ASSIST.yeet) {
      out.setLength(esc * ASSIST.cap);
    }
    return out;
  }

  release(grabber, silent = false) {
    const body = grabber.held;
    grabber.held = null;
    if (!body || !body.alive) return;
    body.held = false;
    this.throwVelocity(grabber, body.pos, body.vel);
    body.acc.set(0, 0, 0);
    this.garden.trailOf(body)?.reset();
    setShellState(body.mesh, 'none');
    if (!silent) {
      this.audio.throw_(body.vel.length());
      grabber.pulse(0.5, 60);
    }
  }

  // ---- per-frame --------------------------------------------------------------

  update(dt, t, inXR) {
    // 1. Raw world poses for the XR hands.
    for (let i = 0; i < 2; i++) {
      const grabber = this.grabbers[i];
      if (!grabber.active) continue;
      this.grabPointWorld(grabber, grabber.worldPos);
    }

    // 2. Two-handed world grip — may move/scale/turn the garden group.
    this.updateWorldGrip();

    // 3. Everything below runs in garden space.
    for (const grabber of this.grabbers) {
      if (!grabber.active) continue;
      grabber.pos.copy(grabber.worldPos);
      this.toGarden(grabber.pos);
      if (this.grip) grabber.history.length = 0; // space itself is moving
      else grabber.recordHistory(t);
    }

    for (let i = 0; i < 2; i++) {
      if (this.grabbers[i].active) this.pollGamepad(this.grabbers[i], dt);
    }
    this.checkViewReset();

    // Carry held bodies, keep their velocity live for gravity and prediction.
    for (const grabber of this.grabbers) {
      const body = grabber.held;
      if (!body) continue;
      if (!body.alive) { grabber.held = null; continue; }
      body.pos.copy(grabber.pos).add(grabber.holdOffset);
      grabber.velocity(body.vel);
    }

    this.updateHover();
    this.updatePredictions();
    this.updateHandJoints(inXR);
  }

  // Both hands pressed on empty space: grab the fabric of the garden itself.
  // Separation scales it, the midpoint drags it, the hand-to-hand bearing
  // turns it. The platform under the player never moves.
  updateWorldGrip() {
    const [gL, gR] = this.grabbers;
    const eligible = (g) => g.active && g.pressCount > 0 && !g.held;
    const group = this.garden.group;

    if (!(eligible(gL) && eligible(gR))) {
      if (this.grip) {
        this.grip = null;
        this.audio.click();
      }
      return;
    }

    const d = Math.max(0.05, gL.worldPos.distanceTo(gR.worldPos));
    _v1.addVectors(gL.worldPos, gR.worldPos).multiplyScalar(0.5); // midpoint M
    _v2.subVectors(gR.worldPos, gL.worldPos);
    const bearing = Math.atan2(_v2.x, _v2.z);

    if (!this.grip) {
      this.grip = {
        d0: d,
        s0: group.scale.x,
        q0: group.quaternion.clone(),
        a0: bearing,
        anchor: this.toGarden(_v3.copy(_v1)).clone(), // garden point under M
      };
      this.audio.grab();
      gL.pulse(0.25, 30);
      gR.pulse(0.25, 30);
      return;
    }

    const g = this.grip;
    const s = Math.min(GRIP.maxScale, Math.max(GRIP.minScale, g.s0 * (d / g.d0)));
    _q.setFromAxisAngle(Y_AXIS, bearing - g.a0);
    group.quaternion.multiplyQuaternions(_q, g.q0);
    group.scale.setScalar(s);
    // Keep the grabbed garden point pinned under the moving midpoint.
    _v3.copy(g.anchor).multiplyScalar(s).applyQuaternion(group.quaternion);
    group.position.subVectors(_v1, _v3);
    group.updateMatrixWorld(true);
  }

  checkViewReset() {
    // Clicking both thumbsticks at once puts the garden back where it started.
    const down = (g) => !!g.inputSource?.gamepad?.buttons[3]?.pressed;
    const both = down(this.grabbers[0]) && down(this.grabbers[1]);
    if (both && !this.resetLatch) this.actions.resetView();
    this.resetLatch = both;
  }

  updateHover() {
    const nowHovered = new Set();
    for (const grabber of this.grabbers) {
      if (!grabber.active || grabber.held) continue;
      const target = this.findGrabbable(grabber.pos);
      if (target?.kind === 'planet') nowHovered.add(target.body.mesh);
      else if (target?.kind === 'seed' && target.slot.mesh) nowHovered.add(target.slot.mesh);
    }
    for (const mesh of this.hovered) {
      if (!nowHovered.has(mesh)) setShellState(mesh, 'none');
    }
    for (const mesh of nowHovered) {
      if (!this.hovered.has(mesh)) setShellState(mesh, 'hover');
    }
    this.hovered = nowHovered;
  }

  updatePredictions() {
    for (let i = 0; i < this.grabbers.length; i++) {
      const grabber = this.grabbers[i];
      const line = this.predictLines[i];
      const body = grabber.held;
      if (!body) { line.visible = false; continue; }

      this.throwVelocity(grabber, body.pos, _v1);
      const { count, hitSun } = this.sim.predict(body.pos, _v1, body, this.predictBuf);
      const attr = line.geometry.getAttribute('position');
      attr.array.set(this.predictBuf.subarray(0, count * 3));
      attr.needsUpdate = true;
      line.geometry.setDrawRange(0, count);
      line.material.color.setHex(hitSun ? 0xff8a4a : 0xbfe9ff);
      line.visible = count > 1;
    }
  }

  updateHandJoints(inXR) {
    for (let i = 0; i < this.hands.length; i++) {
      const { hand, jointMesh } = this.hands[i];
      // Only draw joints while this input actually IS a tracked hand —
      // otherwise stale poses would hang in the air after a controller swap.
      const isHand = inXR && !!this.grabbers[i].inputSource?.hand;
      let n = 0;
      if (isHand && hand.joints) {
        for (const joint of Object.values(hand.joints)) {
          if (n >= 25) break;
          if (!joint.visible) continue;
          joint.getWorldPosition(_v1);
          _m.setPosition(_v1);
          jointMesh.setMatrixAt(n++, _m);
        }
      }
      jointMesh.count = n;
      jointMesh.instanceMatrix.needsUpdate = true;
      jointMesh.visible = n > 0;
    }
  }

  pollGamepad(grabber, dt) {
    const gp = grabber.inputSource?.gamepad;
    if (!gp) return;

    // Thumbstick Y: exponential time-scale control, either hand.
    const y = gp.axes[3] ?? 0;
    if (Math.abs(y) > 0.25) {
      const s = this.sim.timeScale * Math.exp(-y * TIME.stickRate * dt);
      this.sim.timeScale = Math.min(TIME.max, Math.max(TIME.min, s));
    }

    // Buttons 4/5 are A/B on the right controller, X/Y on the left.
    const right = grabber.inputSource.handedness === 'right';
    const pressedNow = (idx) => !!gp.buttons[idx]?.pressed;
    const edge = (idx) => {
      const now = pressedNow(idx);
      const was = grabber.buttonsPrev[idx];
      grabber.buttonsPrev[idx] = now;
      return now && !was;
    };
    if (edge(4)) right ? this.actions.toggleTrails() : this.actions.clearPlanets();
    if (edge(5)) right ? this.actions.togglePause() : this.actions.togglePanel();
  }

  // ---- desktop fallback ---------------------------------------------------------

  setupDesktop(dom) {
    this.orbit = {
      pivot: new THREE.Vector3(...SUN.pos),
      radius: 2.1,
      theta: 0,
      phi: 1.35,
      dragging: false,
    };
    this.raycaster = new THREE.Raycaster();
    this.dragPlane = new THREE.Plane();
    this.pointer = new THREE.Vector2();

    const toPointer = (e) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
    };

    dom.addEventListener('pointerdown', (e) => {
      if (this.renderer.xr.isPresenting) return;
      this.audio.start();
      toPointer(e);
      this.raycaster.setFromCamera(this.pointer, this.camera);

      const meshes = [];
      for (const body of this.sim.bodies) if (!body.held && body.mesh) meshes.push(body.mesh);
      for (const slot of this.garden.nursery.slots) if (slot.mesh) meshes.push(slot.mesh);
      const hits = this.raycaster.intersectObjects(meshes, true);

      if (hits.length) {
        let mesh = hits[0].object;
        while (mesh.parent && !meshes.includes(mesh)) mesh = mesh.parent;
        mesh.getWorldPosition(_v1);
        this.dragPlane.setFromNormalAndCoplanarPoint(
          this.camera.getWorldDirection(_v2), _v1);
        this.mouseGrabber.active = true;
        this.mouseGrabber.worldPos.copy(_v1);
        this.mouseGrabber.pos.copy(_v1);
        this.toGarden(this.mouseGrabber.pos);
        this.mouseGrabber.history.length = 0;
        this.mouseGrabber.pressCount = 1;
        this.tryGrab(this.mouseGrabber);
        if (!this.mouseGrabber.held) this.orbit.dragging = true;
      } else {
        this.orbit.dragging = true;
      }
      dom.setPointerCapture(e.pointerId);
    });

    dom.addEventListener('pointermove', (e) => {
      if (this.renderer.xr.isPresenting) return;
      if (this.mouseGrabber.held) {
        toPointer(e);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        if (this.raycaster.ray.intersectPlane(this.dragPlane, _v1)) {
          this.mouseGrabber.worldPos.copy(_v1);
        }
      } else if (this.orbit.dragging) {
        this.orbit.theta -= e.movementX * 0.005;
        this.orbit.phi = Math.min(2.6, Math.max(0.35, this.orbit.phi - e.movementY * 0.005));
      }
    });

    const endDrag = () => {
      if (this.mouseGrabber.held) {
        this.release(this.mouseGrabber);
      }
      this.mouseGrabber.active = false;
      this.mouseGrabber.pressCount = 0;
      this.orbit.dragging = false;
    };
    dom.addEventListener('pointerup', endDrag);
    dom.addEventListener('pointercancel', endDrag);

    dom.addEventListener('wheel', (e) => {
      if (this.renderer.xr.isPresenting) return;
      e.preventDefault();
      this.orbit.radius = Math.min(6, Math.max(0.7, this.orbit.radius * (1 + e.deltaY * 0.001)));
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (this.renderer.xr.isPresenting) return;
      if (e.key === 't' || e.key === 'T') this.actions.toggleTrails();
      if (e.key === 'p' || e.key === 'P' || e.key === ' ') this.actions.togglePause();
      if (e.key === 'c' || e.key === 'C') this.actions.clearPlanets();
      if (e.key === 'h' || e.key === 'H') this.actions.togglePanel();
      if (e.key === '0') this.actions.resetView();
      if (e.key === '1') this.sim.timeScale = Math.max(TIME.min, this.sim.timeScale / 1.5);
      if (e.key === '2') this.sim.timeScale = Math.min(TIME.max, this.sim.timeScale * 1.5);
    });
  }

  // Desktop camera glide; called only when not presenting in XR.
  updateDesktopCamera() {
    const o = this.orbit;
    const sp = Math.sin(o.phi), cp = Math.cos(o.phi);
    this.camera.position.set(
      o.pivot.x + o.radius * sp * Math.sin(o.theta),
      o.pivot.y + o.radius * cp,
      o.pivot.z + o.radius * sp * Math.cos(o.theta)
    );
    this.camera.lookAt(o.pivot);
  }
}
