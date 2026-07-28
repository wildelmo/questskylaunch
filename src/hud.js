import * as THREE from 'three';

// Two head-referenced overlays: a readout that tells you how high you are, and
// a vignette that keeps the early part of the climb comfortable.
//
// The readout follows your head lazily rather than being welded to it.  A panel
// locked rigidly to the view reads as dirt on your glasses; one that drifts back
// to centre over half a second reads as something floating nearby, and you stop
// noticing it is there.

const MILESTONES = [
  { alt: 0.0, text: 'Sierra foothills, California — 4:30 in the afternoon' },
  { alt: 0.12, text: 'Above the treetops' },
  { alt: 0.6, text: 'Higher than any building ever built' },
  { alt: 2.4, text: 'Cloud base' },
  { alt: 9.5, text: 'Airliner cruise' },
  { alt: 20.0, text: 'Above 99% of the atmosphere by mass' },
  { alt: 34.0, text: 'The sky is running out of air to be blue with' },
  { alt: 55.0, text: 'Look at the edge — that thin blue line is all of it' },
  { alt: 100.0, text: 'Kármán line. You are in space' },
  { alt: 210.0, text: 'Below you: where the space station flies' },
  { alt: 420.0, text: 'The horizon has started to curve back on itself' },
  { alt: 900.0, text: 'Above the aurora' },
  { alt: 2400.0, text: 'The whole planet is closing into a circle' },
  { alt: 6000.0, text: 'One Earth radius out' },
  { alt: 11000.0, text: 'Everyone who has ever lived, in one glance' },
  { alt: 16000.0, text: 'Nothing between you and it' },
];

function formatAltitude(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  if (km < 10000) return `${Math.round(km).toLocaleString('en-US')} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

function formatSpeed(kmPerSecond) {
  const kmh = Math.abs(kmPerSecond) * 3600;
  if (kmh < 10000) return `${Math.round(kmh).toLocaleString('en-US')} km/h`;
  return `${(kmh / 1000).toFixed(0)},000 km/h`;
}

export function createHud() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.00030, 0.0000938), // 30 cm x 9.4 cm, in km
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
  );
  panel.renderOrder = 9000;
  panel.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'hud';
  group.add(panel);
  panel.position.set(0, -0.00026, -0.00090); // 26 cm below the eye line, 90 cm out

  let lastText = '';
  let lastDraw = -1;
  let opacity = 0;

  function draw(altitude, speed, caption, hint) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(232, 240, 255, 0.95)';
    ctx.font = '600 116px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif';
    ctx.fillText(formatAltitude(altitude), canvas.width / 2, 118);

    ctx.fillStyle = 'rgba(168, 196, 232, 0.80)';
    ctx.font = '400 40px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif';
    ctx.fillText(speed, canvas.width / 2, 176);

    ctx.fillStyle = 'rgba(206, 224, 250, 0.72)';
    ctx.font = '400 38px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif';
    ctx.fillText(caption, canvas.width / 2, 238);

    if (hint) {
      ctx.fillStyle = 'rgba(150, 176, 208, 0.55)';
      ctx.font = '400 30px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif';
      ctx.fillText(hint, canvas.width / 2, 292);
    }

    texture.needsUpdate = true;
  }

  const targetPosition = new THREE.Vector3();
  const targetQuaternion = new THREE.Quaternion();

  return {
    group,

    setVisible(visible) {
      group.visible = visible;
    },

    /** @param camera the XR camera, whose world transform we trail. */
    update(camera, dt, { altitude, climbRate, hint }) {
      camera.getWorldPosition(targetPosition);
      camera.getWorldQuaternion(targetQuaternion);

      // Critically-damped-ish trailing: snappy enough to keep up with a glance,
      // slow enough that it never feels attached to your eyeballs.
      const follow = 1 - Math.exp(-dt * 5.0);
      group.position.lerp(targetPosition, follow);
      group.quaternion.slerp(targetQuaternion, 1 - Math.exp(-dt * 3.2));

      const now = performance.now();
      if (now - lastDraw > 120) {
        lastDraw = now;
        let caption = MILESTONES[0].text;
        for (const m of MILESTONES) if (altitude >= m.alt) caption = m.text;
        const key = `${formatAltitude(altitude)}|${caption}|${hint || ''}`;
        if (key !== lastText) {
          lastText = key;
          draw(altitude, formatSpeed(climbRate), caption, hint);
        }
      }

      // Fade the whole thing away once you are high enough that a number is
      // just something in the way.
      const wanted = altitude > 12000 ? 0.0 : 1.0;
      opacity += (wanted - opacity) * (1 - Math.exp(-dt * 0.8));
      panel.material.opacity = opacity;
      panel.visible = opacity > 0.01;
    },

    dispose() {
      panel.geometry.dispose();
      panel.material.dispose();
      texture.dispose();
    },
  };
}

// ---------------------------------------------------------------------------

const VIGNETTE_VERTEX = /* glsl */ `
out vec2 vPosition;
void main() {
  vPosition = position.xy;
  gl_Position = vec4(position.xy, 0.999, 1.0);
}
`;

const VIGNETTE_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vPosition;
layout(location = 0) out vec4 fragColor;
uniform float uStrength;

void main() {
  // Elliptical, because the field of view is not square and a circular tunnel
  // crops more off the top and bottom than it needs to.
  float r = length(vPosition * vec2(0.82, 1.0));
  float inner = mix(1.35, 0.42, uStrength);
  float outer = inner + 0.42;
  float a = smoothstep(inner, outer, r) * clamp(uStrength * 1.15, 0.0, 1.0);
  fragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

/**
 * A soft black tunnel around the edge of vision.  It is doing real work: the
 * periphery is where vection is detected, and hiding it during the parts of the
 * climb with the strongest optical flow is the difference between a comfortable
 * three minutes and a short one.
 */
export function createVignette() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  );

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VIGNETTE_VERTEX,
    fragmentShader: VIGNETTE_FRAGMENT,
    uniforms: { uStrength: { value: 0 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9500;
  mesh.name = 'vignette';

  let smoothed = 0;
  return {
    mesh,
    material,
    update(dt, wanted, enabled) {
      const target = enabled ? wanted : 0;
      smoothed += (target - smoothed) * (1 - Math.exp(-dt * 2.5));
      material.uniforms.uStrength.value = smoothed;
      mesh.visible = smoothed > 0.01;
    },
  };
}
