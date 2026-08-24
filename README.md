# Gravity Garden

A WebXR orbital sandbox for the Meta Quest. You stand on a glass platform in
deep space. A small sun burns in front of you at tabletop height, and a stand
beside it grows planet seeds in three sizes. Take one and throw it.

The speed of your hand becomes its orbital velocity — that's the whole game,
and it turns out to be everything. While you hold a planet, a ghost arc shows
the exact path it will take when you let go, so you can aim an ellipse the way
you'd aim a paper aeroplane. Gravity is really simulated (velocity Verlet,
sun + planet-planet attraction), so orbits precess, close pairs capture each
other, and a careless toss falls into the sun.

Which is fine, because **the sun eats what falls in** — and grows. Feed it
eight planets and it goes nova: a shockwave that hurls your whole garden
outward at once, and the sun shrinks back to start.

Planets that collide merge, conserving momentum. Every time a planet completes
a full orbit it plays a soft pentatonic note from where it is in space —
plant a few planets at different radii and the garden slowly becomes a
generative music box.

**Live:** <https://wildelmo.github.io/questskylaunch/> — open it in the Meta
Quest Browser and press **Enter VR**. Every push to `main` redeploys it.

There are no assets. Every texture, model, and sound — the starfield, the
sun's boiling surface, the bell when two worlds merge — is generated from code
at load. The whole experience is one ~138 kB gzipped bundle, and three.js is
the only dependency.

## Controls

| In the headset | |
|---|---|
| **Trigger / grip** (or **pinch**, with hand tracking) | grab a seed or a planet |
| **Throw** | your release velocity becomes its orbit |
| **Hold** | see the predicted path |
| **Right stick ↑↓** | time slower / faster (×0.15 – ×6) |
| **A** | trails on / off |
| **B** | pause / resume |
| **X** | clear all planets |
| **Y** | hide the info panel |

On a flat screen it degrades gracefully: drag a planet to throw it, drag empty
space to look around, scroll to zoom, <kbd>T</kbd>/<kbd>Space</kbd>/<kbd>C</kbd>
and <kbd>1</kbd>/<kbd>2</kbd> for trails, pause, clear, and time.

## Running it

```bash
npm install
npm run dev          # serves over HTTPS on port 5173
```

WebXR needs a secure context, so the dev server uses a self-signed
certificate. On the Quest: put the headset and computer on the same network,
open `https://<your-computer's-LAN-IP>:5173` in the Quest Browser, and accept
the certificate warning once.

```bash
npm test             # physics sanity checks (orbits, merges, conservation)
npm run build        # production bundle in dist/
node tools/smoke.mjs # loads the built app in headless Chromium and pokes it
```

## How it's put together

```
src/
  config.js    every tunable number, with the reasoning
  physics.js   the n-body sim: Verlet integration, merges, orbit tracking,
               trajectory prediction, the nova blast
  cosmos.js    starfield + milky way + nebulae, the sun shader, the platform
  planets.js   planet meshes (vertex-noise colouring), atmosphere shells,
               rings, orbit trails, the seed nursery
  interact.js  grabbing/throwing for controllers, tracked hands, and mouse;
               velocity smoothing; the prediction arc; gamepad polling
  audio.js     all sound, synthesized in WebAudio — spatialised notes,
               FM bells, the nova; nothing is a file
  panel.js     the floating help/stats card (canvas texture)
  main.js      scene, XR session, the garden orchestration, the loop
```

The sim runs in real units (metres, seconds) with the sun's `GM` tuned so a
gentle toss at half a metre orbits in about three seconds and a hard throw
escapes. Everything renderable is budgeted for the Quest's mobile GPU: no
shadows, no post-processing, one point light, additive sprites for all glow,
and fixed foveation — a full garden stays comfortably at the native frame rate.
