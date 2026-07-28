import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

import { PLANET, LAUNCH_SITE, EPOCH, QUALITY, METRE } from './config.js';
import { GROUND_EXPOSURE, ORBIT_EXPOSURE } from './render/output.js';
import { bakeAtmosphereLuts, probeLut } from './atmosphere/luts.js';
import { createSharedUniforms } from './render/environment.js';
import { createSpacePass } from './space/spacePass.js';
import { createStarfield, loadStarCatalogue } from './space/starfield.js';
import { buildLaunchFrame, epochDate } from './space/ephemeris.js';
import { createTerrain, probeTerrainHeight } from './ground/terrain.js';
import { createGroundProps } from './ground/scatter.js';
import { createFlight } from './flight.js';
import { createAudio } from './audio.js';
import { createHud, createVignette } from './hud.js';

const status = document.getElementById('status');
const overlay = document.getElementById('overlay');

function report(message) {
  if (status) status.textContent = message;
}

// --------------------------------------------------------------------------
// loading
// --------------------------------------------------------------------------

function loadTexture(loader, url, { srgb }) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (texture) => {
        // Every shader here decodes sRGB by hand, so three must not also do it.
        texture.colorSpace = THREE.NoColorSpace;
        texture.wrapS = THREE.RepeatWrapping;   // longitude wraps
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.userData.srgb = srgb;
        resolve(texture);
      },
      undefined,
      reject
    );
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

/**
 * The 8k day side is 134 MB of GPU memory once it has mipmaps.  A Quest 3 has
 * room for it; a phone browser or an older headset does not, so ask before
 * committing.
 */
function pickAlbedo(renderer) {
  const gl = renderer.getContext();
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const memory = navigator.deviceMemory || 4;
  if (maxTexture >= 8192 && memory >= 4) return 'textures/earth_albedo_8k.jpg';
  return 'textures/earth_albedo_4k.jpg';
}

// --------------------------------------------------------------------------

async function main() {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping and sRGB encoding happen inside each shader (see
  // render/output.js); the renderer must not do it a second time.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFramebufferScaleFactor(QUALITY.framebufferScale);
  document.body.appendChild(renderer.domElement);

  if (!renderer.capabilities.isWebGL2) {
    report('This needs WebGL 2. Try the Meta Quest Browser or a recent desktop browser.');
    return;
  }

  report('Baking atmosphere tables…');
  const luts = bakeAtmosphereLuts(renderer);
  const shared = createSharedUniforms(luts);

  report('Loading the Earth…');
  const loader = new THREE.TextureLoader();
  const albedoUrl = pickAlbedo(renderer);
  const [albedo, night, clouds, surface, catalogue] = await Promise.all([
    loadTexture(loader, albedoUrl, { srgb: true }),
    loadTexture(loader, 'textures/earth_night_4k.jpg', { srgb: true }),
    loadTexture(loader, 'textures/earth_clouds_4k.jpg', { srgb: false }),
    loadTexture(loader, 'textures/earth_surface_4k.jpg', { srgb: false }),
    loadStarCatalogue('data/stars.bin'),
  ]);

  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  albedo.anisotropy = maxAnisotropy;
  surface.anisotropy = Math.min(maxAnisotropy, 8);
  clouds.anisotropy = Math.min(maxAnisotropy, 8);
  const textures = { albedo, night, clouds, surface };

  // --- where and when -------------------------------------------------------
  const date = epochDate(EPOCH);
  const frame = buildLaunchFrame(LAUNCH_SITE, date);
  shared.uWorldToPlanet.value.copy(frame.worldToPlanet);
  shared.uSunDirection.value.copy(frame.sunPlanet);
  shared.uPlanetCentre.value.set(0, -PLANET.radius, 0);

  // --- scene ----------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = null;

  const starfield = createStarfield(catalogue, { radius: 0.5 });
  // Equatorial coordinates -> planet-fixed (one spin about the pole by the
  // sidereal angle) -> world.
  const celestialToPlanet = new THREE.Matrix4().makeRotationY(-frame.sidereal);
  const planetToWorld4 = new THREE.Matrix4().setFromMatrix3(frame.planetToWorld);
  starfield.group.quaternion.setFromRotationMatrix(planetToWorld4.multiply(celestialToPlanet));
  scene.add(starfield.group);

  const space = createSpacePass(textures, shared);
  scene.add(space.mesh);

  const terrain = createTerrain(textures, shared);
  scene.add(terrain.mesh);

  // How high the ground is under your feet, answered by the same shader that
  // draws it.  Everything else is measured from here.
  const groundHeight = probeTerrainHeight(renderer, terrain.uniforms);

  const props = createGroundProps(shared, terrain.uniforms);
  scene.add(props.group);

  const hud = createHud();
  scene.add(hud.group);
  const vignette = createVignette();
  scene.add(vignette.mesh);

  // --- the rig --------------------------------------------------------------
  // rig      where you are, in the world
  //   pivot  rotates about a point roughly where your head is, so tipping onto
  //          your back does not swing you around your own ankles
  //     head carries the camera back down to the floor the tracker reports
  const rig = new THREE.Group();
  const pivot = new THREE.Group();
  const head = new THREE.Group();
  const HEAD_HEIGHT = 1.65 * METRE;
  pivot.position.set(0, HEAD_HEIGHT, 0);
  head.position.set(0, -HEAD_HEIGHT, 0);
  rig.add(pivot);
  pivot.add(head);
  scene.add(rig);

  const camera = new THREE.PerspectiveCamera(
    72,
    window.innerWidth / window.innerHeight,
    0.05 * METRE,   // 5 cm
    200.0           // km; the sky and planet are drawn without depth anyway
  );
  camera.position.set(0, 1.7 * METRE, 0);
  head.add(camera);

  // --- flight, sound, input -------------------------------------------------
  const flight = createFlight();
  const audio = createAudio();

  const settings = { comfortVignette: true, autoStart: true };
  // Naming controls that do not exist on the device you are holding is worse
  // than saying nothing, so the hint follows the input you actually have.
  const XR_HINT = 'Trigger: launch  ·  Stick: speed  ·  B/Y: comfort';
  const DESKTOP_HINT = 'Space: launch  ·  R: restart  ·  H: hide all text';
  let hint = DESKTOP_HINT;
  let startDelay = 4.0;

  function restart() {
    flight.restart();
    startDelay = 1.5;
  }

  const session = { pressed: new Set() };

  function readInput(dt) {
    const xrSession = renderer.xr.getSession();
    if (!xrSession) return;

    let stick = 0;
    for (const source of xrSession.inputSources) {
      const pad = source.gamepad;
      if (!pad) continue;

      const axes = pad.axes;
      if (axes.length >= 4 && Math.abs(axes[3]) > 0.15) stick = -axes[3];
      else if (axes.length >= 2 && Math.abs(axes[1]) > 0.15) stick = -axes[1];

      const handed = source.handedness || 'none';
      const press = (index, name) => {
        const button = pad.buttons[index];
        if (!button) return false;
        const key = `${handed}:${name}`;
        const was = session.pressed.has(key);
        if (button.pressed) session.pressed.add(key);
        else session.pressed.delete(key);
        return button.pressed && !was;
      };

      if (press(0, 'trigger') || press(4, 'a')) {
        if (flight.state.finished) restart();
        else if (!flight.state.running && flight.state.clock === 0) {
          flight.start();
          startDelay = 0;
        } else flight.toggle();
        hint = '';
      }
      if (press(5, 'b')) {
        settings.comfortVignette = !settings.comfortVignette;
        hint = settings.comfortVignette ? 'Comfort vignette on' : 'Comfort vignette off';
        hintTimer = 2.5;
      }
      if (press(3, 'stickPress')) {
        flight.setRate(1);
        hint = 'Speed reset';
        hintTimer = 1.5;
      }
    }

    // Push forward to speed up, pull back to slow down or rewind.  Dead-zoned,
    // and squared so small pushes are gentle.
    if (Math.abs(stick) > 0.15) {
      const t = (Math.abs(stick) - 0.15) / 0.85;
      const magnitude = t * t;
      const rate = stick > 0 ? 1 + magnitude * 4 : 1 - magnitude * 3.2;
      flight.setRate(rate);
    } else if (Math.abs(flight.state.rate - 1) > 0.01) {
      flight.setRate(flight.state.rate + (1 - flight.state.rate) * Math.min(dt * 3, 1));
    }
  }

  let hintTimer = 8;

  // --- desktop preview ------------------------------------------------------
  // Not the point of the project, but being able to look around on a laptop is
  // the difference between iterating in seconds and iterating in minutes.
  const look = { yaw: 0, pitch: 0, dragging: false, x: 0, y: 0 };
  renderer.domElement.addEventListener('pointerdown', (event) => {
    look.dragging = true;
    look.x = event.clientX;
    look.y = event.clientY;
  });
  window.addEventListener('pointerup', () => { look.dragging = false; });
  window.addEventListener('pointermove', (event) => {
    if (!look.dragging) return;
    look.yaw -= (event.clientX - look.x) * 0.0035;
    look.pitch -= (event.clientY - look.y) * 0.0035;
    look.pitch = Math.min(Math.max(look.pitch, -1.5), 1.5);
    look.x = event.clientX;
    look.y = event.clientY;
  });
  // --- screen furniture -----------------------------------------------------
  // The intro panel is only in the way once you have read it, so it goes as
  // soon as the ascent begins.  H clears everything, including the in-world
  // readout and the Enter VR button, for a frame with nothing written on it.
  let textVisible = true;

  function setChrome(visible) {
    if (overlay) overlay.classList.toggle('dismissed', !visible);
  }

  function setAllText(visible) {
    textVisible = visible;
    // The class hides the page furniture on its own; the intro panel keeps its
    // own dismissed state underneath, so toggling back does not bring it
    // returning from the dead once the ascent has started.
    document.body.classList.toggle('no-chrome', !visible);
    hud.setVisible(visible);
  }

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
      flight.toggle();
      startDelay = 0;
      setChrome(false);
    }
    if (event.code === 'KeyR') restart();
    if (event.code === 'KeyH') setAllText(!textVisible);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- session lifecycle ----------------------------------------------------
  renderer.xr.addEventListener('sessionstart', () => {
    setChrome(false);
    renderer.xr.setFoveation(QUALITY.foveation);
    audio.resume();
    flight.restart();
    flight.pause();
    startDelay = settings.autoStart ? 5.0 : Infinity;
    hint = XR_HINT;
    hintTimer = 9;
  });
  renderer.xr.addEventListener('sessionend', () => {
    setChrome(true);
  });

  document.body.appendChild(VRButton.createButton(renderer, {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
  }));

  report('Ready. Put the headset on and press Enter VR.');

  // --- adaptive quality -----------------------------------------------------
  let frameMs = QUALITY.targetFrameMs;
  let skySteps = 26;

  function governQuality(dt) {
    frameMs += (dt * 1000 - frameMs) * 0.06;
    const target = QUALITY.targetFrameMs;
    if (frameMs > target * 1.12) skySteps -= 0.55;
    else if (frameMs < target * 0.82) skySteps += 0.22;
    skySteps = Math.min(Math.max(skySteps, QUALITY.skyStepsMin), QUALITY.skyStepsMax);
    shared.uSkySteps.value = Math.round(skySteps);
  }

  // --- inspection hook ------------------------------------------------------
  // Lets tools/smoke.mjs park the rig at a given altitude and attitude in a
  // real browser and photograph the result.  Rendering bugs at 400 km are not
  // things you want to find by putting a headset on eleven times.
  const override = { active: false, altitude: 0, pitch: 0 };
  window.__skylaunch = {
    ready: true,
    pose({ alt = 0, pitch = 0, look: [yaw = 0, pitchLook = 0] = [] }) {
      setChrome(false);
      override.active = true;
      override.altitude = alt;
      override.pitch = pitch;
      // Snap eye adaptation so a still frame shows the settled state rather
      // than whatever it happened to be a fifth of a second in.
      adaptation = smoothstep(18, 220, alt);
      flight.pause();
      startDelay = Infinity;
      look.yaw = yaw;
      look.pitch = pitchLook;
    },
    release() {
      override.active = false;
    },
    setUniform(name, value) {
      if (!terrain.uniforms[name]) return `no uniform ${name}`;
      terrain.uniforms[name].value = value;
      return `${name}=${terrain.uniforms[name].value}`;
    },
    /** Swap a prop's material for a flat colour, to separate "the geometry is
     * not there" from "my shader is not drawing it". */
    debugMaterial(name) {
      const target = { grass: props.grass.mesh, trees: props.group.children[1] }[name];
      if (target) target.material = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    },
    /** Layer isolation, so a smoke shot can answer "is it missing or is it dark?" */
    show(name, visible) {
      const map = {
        terrain: terrain.mesh,
        space: space.mesh,
        stars: starfield.group,
        props: props.group,
        grass: props.grass.mesh,
        hud: hud.group,
      };
      if (!map[name]) return `no object ${name}`;
      map[name].userData.forceHidden = !visible;
      return `${name} hidden=${!visible}`;
    },
    probe() {
      // muSun runs across x, altitude up y.  Column 55 of 64 is a sun about 53
      // degrees up, row 0 is sea level.
      return {
        skyIrradianceGroundSunHigh: probeLut(renderer, luts.targets.skyIrradiance, 55, 0),
        skyIrradianceGroundSunLow: probeLut(renderer, luts.targets.skyIrradiance, 34, 0),
        skyIrradianceAt50km: probeLut(renderer, luts.targets.skyIrradiance, 55, 16),
        multiScatterGround: probeLut(renderer, luts.targets.multiScatter, 28, 0),
        transmittanceZenith: probeLut(renderer, luts.targets.transmittance, 255, 0),
      };
    },
    inspect() {
      const m = new THREE.Matrix4();
      return props.group.children.map((child) => {
        const info = {
          name: child.name,
          visible: child.visible,
          type: child.material.type,
          count: child.count || null,
          triangles: (child.geometry.index ? child.geometry.index.count : 0) / 3,
        };
        if (child.isInstancedMesh) {
          child.getMatrixAt(0, m);
          info.instance0 = m.elements.map((v) => Number(v.toPrecision(4)));
        }
        const box = child.geometry.boundingBox;
        info.bounds = box ? [box.min.toArray(), box.max.toArray()] : null;
        return info;
      });
    },
    stats() {
      return {
        flightClock: Number(flight.state.clock.toFixed(2)),
        hudVisible: hud.group.visible,
        textVisible,
        running: flight.state.running,
        altitudeKm: Number(flight.state.altitude.toFixed(3)),
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs.length,
        skySteps: shared.uSkySteps.value,
        groundHeightKm: groundHeight,
        albedo: albedoUrl,
      };
    },
  };

  // --- the loop -------------------------------------------------------------
  const clock = new THREE.Clock();
  const cameraWorld = new THREE.Vector3();
  let adaptation = 0;

  function smoothstep(a, b, x) {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  }

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const elapsed = clock.elapsedTime;

    readInput(dt);
    if (startDelay > 0 && startDelay !== Infinity) {
      startDelay -= dt;
      if (startDelay <= 0) {
        flight.start();
        setChrome(false);
      }
    }
    flight.update(dt);

    const altitude = override.active ? override.altitude : flight.state.altitude;
    const pitch = override.active ? override.pitch : flight.state.pitch;

    // Place the rig.  Everything below the launch site's own ground height is
    // the terrain's business, so the flight profile is measured from there.
    rig.position.set(0, groundHeight + altitude, 0);
    pivot.rotation.x = -pitch;

    // --- level of detail across nine orders of magnitude --------------------
    terrain.uniforms.uDetailFade.value = 1 - smoothstep(9, 26, altitude);
    terrain.uniforms.uReliefFade.value = 1 - smoothstep(28, 56, altitude);
    // The higher you go the longer the sight line through the air, and a
    // seven-step march across fifty kilometres of exponentially varying density
    // turns into a smear.  Cost is bounded by the terrain being switched off
    // entirely not long after.
    // The terrain's own aerial perspective rides the same governor as the sky,
    // since at forty kilometres up it covers half the screen and a march that
    // long is not cheap.
    terrain.uniforms.uGroundSteps.value = altitude < 2
      ? 10
      : Math.min(Math.max(Math.round(shared.uSkySteps.value * 0.55), 6), 14);
    // By 60 km the mesh has relaxed onto the sphere the space pass draws, which
    // shades the same imagery with better normals and its own clouds.  Handing
    // over here costs nothing and saves a quarter of a million triangles.
    terrain.mesh.visible = altitude < 60;

    // Procedural grain on the analytic planet, but only while a texel is big
    // enough on screen for the blur to show.
    space.uniforms.uSurfaceDetail.value = smoothstep(400, 90, altitude) * (altitude > 20 ? 1 : 0);

    props.update(elapsed, altitude);

    // Eye adaptation.  Below the atmosphere the sky sets the exposure; once the
    // lit planet fills the view it does, and it is far brighter.  Four-second
    // time constant, which is roughly how long real light adaptation takes and
    // slow enough that you notice the world settling rather than a control
    // being moved.
    const adaptTarget = smoothstep(18, 220, altitude);
    adaptation += (adaptTarget - adaptation) * (1 - Math.exp(-dt / 4));
    shared.uExposure.value = GROUND_EXPOSURE + (ORBIT_EXPOSURE - GROUND_EXPOSURE) * adaptation;
    for (const object of [terrain.mesh, space.mesh, starfield.group, props.group, props.grass.mesh, hud.group]) {
      if (object.userData.forceHidden) object.visible = false;
    }

    governQuality(dt);

    const xrCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;

    if (!renderer.xr.isPresenting) {
      head.rotation.set(0, 0, 0);
      camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
    }

    // Keep the celestial sphere centred on the eye so it stays at infinity.
    xrCamera.getWorldPosition(cameraWorld);
    starfield.group.position.copy(cameraWorld);
    starfield.setSkyGlow(altitude, frame.sunWorld.y);
    starfield.starMaterial.uniforms.uViewHeight.value = renderer.xr.isPresenting
      ? (renderer.xr.getSession() ? 1832 : 1100)
      : renderer.getDrawingBufferSize(new THREE.Vector2()).y;

    if (hintTimer > 0) {
      hintTimer -= dt;
      if (hintTimer <= 0) hint = '';
    }

    hud.update(xrCamera, dt, {
      altitude,
      climbRate: flight.state.climbRate,
      hint,
    });
    vignette.update(dt, flight.comfort(), settings.comfortVignette);

    audio.update(altitude, flight.state.climbRate);

    renderer.render(scene, camera);
  });
}

main().catch((error) => {
  console.error(error);
  report(`Something went wrong: ${error && error.message ? error.message : error}`);
});
