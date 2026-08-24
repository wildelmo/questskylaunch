import * as THREE from 'three';
import { SUN } from './config.js';

// The setting: a deep-space backdrop and the sun at the heart of the garden.
// Everything is generated — no textures ship with the app.

// ---- starfield --------------------------------------------------------------

export function makeStarfield() {
  const group = new THREE.Group();
  group.add(makeStarLayer(2600, 55, false));
  group.add(makeStarLayer(1800, 50, true)); // the milky-way band
  group.add(makeNebulae());
  return group;
}

function makeStarLayer(count, dist, band) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const size = new Float32Array(count);
  const tints = [
    new THREE.Color(0xffffff), new THREE.Color(0xaac4ff),
    new THREE.Color(0xffe9c4), new THREE.Color(0xffd2a1),
  ];
  const bandAxis = new THREE.Vector3(0.35, 1, 0.2).normalize();
  const v = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    // Uniform on the sphere, then squashed toward a tilted plane for the band.
    do {
      v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
    } while (v.lengthSq() > 1 || v.lengthSq() < 0.01);
    v.normalize();
    if (band) {
      const d = v.dot(bandAxis);
      v.addScaledVector(bandAxis, -d * (1 - Math.pow(Math.random(), 3) * 0.35)).normalize();
    }
    v.multiplyScalar(dist * (0.9 + Math.random() * 0.2));
    pos.set([v.x, v.y, v.z], i * 3);

    const c = tints[(Math.random() * tints.length) | 0];
    const b = band ? 0.25 + Math.random() * 0.4 : 0.4 + Math.random() * 0.6;
    col.set([c.r * b, c.g * b, c.b * b], i * 3);
    phase[i] = Math.random() * Math.PI * 2;
    size[i] = band ? 0.5 + Math.random() : 0.7 + Math.random() * 1.9;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 color;
      attribute float phase;
      attribute float size;
      uniform float uTime;
      varying vec3 vColor;
      void main() {
        float tw = 0.75 + 0.25 * sin(uTime * (0.6 + fract(phase) * 1.7) + phase * 7.0);
        vColor = color * tw;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * 190.0 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.05, length(uv));
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.starMat = mat;
  return points;
}

function makeNebulae() {
  const group = new THREE.Group();
  const tex = softDiscTexture();
  const tints = [0x2b3f78, 0x5a2b66, 0x1e4d5a, 0x4a2b3a];
  for (let i = 0; i < 7; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: tints[i % tints.length],
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.16 + Math.random() * 0.1,
      rotation: Math.random() * Math.PI,
    });
    const s = new THREE.Sprite(mat);
    const dir = new THREE.Vector3().randomDirection();
    dir.y = Math.abs(dir.y) * (Math.random() < 0.5 ? -0.3 : 0.6);
    s.position.copy(dir.normalize().multiplyScalar(46));
    const sc = 18 + Math.random() * 26;
    s.scale.set(sc, sc * (0.55 + Math.random() * 0.5), 1);
    group.add(s);
  }
  return group;
}

export function softDiscTexture(inner = 'rgba(255,255,255,1)') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- the sun ----------------------------------------------------------------

export function makeSun() {
  const group = new THREE.Group();
  group.position.set(...SUN.pos);

  const uniforms = {
    uTime: { value: 0 },
    uFlare: { value: 0 }, // pushed to ~1 during a nova, decays back
  };

  const surface = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 4),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN;
        varying vec3 vP;
        varying vec3 vView;
        void main() {
          vN = normalize(normalMatrix * normal);
          vP = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform float uFlare;
        varying vec3 vN;
        varying vec3 vP;
        varying vec3 vView;

        float hash(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }
        float noise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
            f.z);
        }
        void main() {
          vec3 p = vP * 3.4 + vec3(uTime * 0.11, uTime * 0.07, -uTime * 0.05);
          float n = noise(p) * 0.55 + noise(p * 2.3) * 0.3 + noise(p * 5.1) * 0.15;
          n = pow(n, 1.4);
          vec3 deep = vec3(0.72, 0.16, 0.02);
          vec3 mid  = vec3(1.00, 0.45, 0.05);
          vec3 hot  = vec3(1.00, 0.86, 0.55);
          vec3 col = mix(deep, mid, smoothstep(0.15, 0.6, n));
          col = mix(col, hot, smoothstep(0.55, 0.95, n));
          float rim = pow(1.0 - abs(dot(normalize(vN), vView)), 2.2);
          col += vec3(1.0, 0.75, 0.4) * rim * 0.9;
          col *= 1.0 + uFlare * 2.6;
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  group.add(surface);

  const glowTex = softDiscTexture('rgba(255,214,150,1)');
  const glowNear = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffb865, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.85,
  }));
  const glowFar = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xff8a3c, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.3,
  }));
  group.add(glowNear, glowFar);

  const light = new THREE.PointLight(0xffd9a6, 1.9, 0, 2);
  group.add(light);

  // Nova shockwave: an expanding fresnel shell, off until triggered.
  const shockUniforms = { uAlpha: { value: 0 } };
  const shock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 3),
    new THREE.ShaderMaterial({
      uniforms: shockUniforms,
      vertexShader: /* glsl */`
        varying float vRim;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vRim = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 2.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uAlpha;
        varying float vRim;
        void main() {
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * vRim * uAlpha, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  shock.visible = false;
  group.add(shock);

  const state = {
    group, light, uniforms,
    baseLight: 1.9,
    shock, shockUniforms,
    shockLife: -1,
    radius: SUN.radius,
    eatFlash: 0,
  };

  state.setRadius = (r) => {
    state.radius = r;
    surface.scale.setScalar(r);
    glowNear.scale.setScalar(r * 4.6);
    glowFar.scale.setScalar(r * 11);
  };
  state.setRadius(SUN.radius);

  state.eat = () => { state.eatFlash = 1; };

  state.nova = () => {
    state.shockLife = 0;
    shock.visible = true;
    state.uniforms.uFlare.value = 1;
  };

  state.update = (t, dt) => {
    uniforms.uTime.value = t;
    const pulse = 1 + Math.sin(t * 1.7) * 0.035 + state.eatFlash * 0.5;
    glowNear.material.opacity = 0.85 * Math.min(1.6, pulse);
    glowFar.material.opacity = 0.3 * pulse;
    light.intensity = state.baseLight * (1 + state.eatFlash * 1.6 + uniforms.uFlare.value * 2.2);
    state.eatFlash = Math.max(0, state.eatFlash - dt * 2.2);
    uniforms.uFlare.value = Math.max(0, uniforms.uFlare.value - dt * 0.85);

    if (state.shockLife >= 0) {
      state.shockLife += dt;
      const k = state.shockLife / 1.25;
      if (k >= 1) {
        state.shockLife = -1;
        shock.visible = false;
      } else {
        const r = state.radius + k * k * 3.2;
        shock.scale.setScalar(r);
        shockUniforms.uAlpha.value = (1 - k) * 1.4;
      }
    }
  };

  return state;
}

// ---- the platform you stand on ----------------------------------------------

export function makePlatform(radius) {
  const group = new THREE.Group();

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 64),
    new THREE.MeshBasicMaterial({
      color: 0x0a1424, transparent: true, opacity: 0.55, depthWrite: false,
    })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.001;
  group.add(disc);

  // Fine concentric rings, drawn once into a canvas.
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(120,190,255,0.5)';
  for (let i = 1; i <= 5; i++) {
    g.lineWidth = i === 5 ? 5 : 1.2;
    g.beginPath();
    g.arc(256, 256, (i / 5) * 250, 0, Math.PI * 2);
    g.stroke();
  }
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(120,190,255,0.22)';
  for (let i = 0; i < 12; i++) {
    g.beginPath();
    g.moveTo(256, 256);
    g.lineTo(256 + Math.cos(i / 12 * Math.PI * 2) * 250, 256 + Math.sin(i / 12 * Math.PI * 2) * 250);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const rings = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 64),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  rings.rotation.x = -Math.PI / 2;
  rings.position.y = 0.002;
  group.add(rings);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.012, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0x67d7ff, transparent: true, opacity: 0.8 })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.01;
  group.add(rim);

  return group;
}
