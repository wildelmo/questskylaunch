# Gravity Garden

A WebXR orbital sandbox for the Meta Quest. You stand on a glass platform in
deep space. A small sun burns in front of you at tabletop height, and a stand
beside it grows planet seeds in three sizes. Take one and throw it.

The speed of your hand becomes its orbital velocity — that's the whole game,
and it turns out to be everything. While you hold a planet, a ghost arc shows
the exact path it will take when you let go, so you can aim an ellipse the way
you'd aim a paper aeroplane. Gravity is really simulated (velocity Verlet,
sun + planet-planet attraction), so orbits precess, close pairs capture each
other, and a careless toss falls into the sun. Orbit assist keeps throws
honest but kind: your direction is always yours, but the speed is softly
capped just under local escape velocity, so a casual toss bends into an orbit
and only a deliberate hurl actually leaves the garden.

And it doesn't have to happen in deep space. On a Quest 3 (or any headset
with passthrough), the **Mixed Reality** button floats the same garden in
your real room — the stars and the platform fade away and the sun burns over
your coffee table. Grip it with both hands to shrink the whole solar system
down to a desk ornament, or blow it up to fill the kitchen.

The planets are worlds. Each seed grows into one of nine procedural
archetypes — blue marbles with drifting cloud decks and ice caps, rusty Mars
types, banded gas giants with translucent rings, cracked ice worlds, lava
worlds veined with glowing rock — and some carry tiny moons on tilted orbits.
Pinch or grip empty space with both hands to grab the fabric of the garden
itself: spread them to zoom, drag to pan, turn them to rotate the whole
system (your platform never moves; click both thumbsticks to reset the view).

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
| **Both hands on empty space** | grip the garden — zoom, pan, turn |
| **Both thumbsticks clicked** | reset the view |
| **Right stick ↑↓** | time slower / faster (×0.15 – ×6) |
| **A** | trails on / off |
| **B** | pause / resume |
| **X** | clear all planets |
| **Y** | hide the info panel |

On a flat screen it degrades gracefully: drag a planet to throw it, drag empty
space to look around, scroll to zoom, <kbd>T</kbd>/<kbd>Space</kbd>/<kbd>C</kbd>
and <kbd>1</kbd>/<kbd>2</kbd> for trails, pause, clear, and time;
<kbd>0</kbd> resets the view.

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
               trajectory prediction, orbit assist's escape speed, the nova
  textures.js  the procedural planet-surface pool: terra, Mars, gas giant,
               ice, lava, clouds — periodic noise painted onto canvases
  cosmos.js    starfield + milky way + nebulae, the sun shader, the platform
  planets.js   planet meshes, cloud decks, moons, atmosphere shells, rings,
               orbit trails, the seed nursery
  interact.js  grabbing/throwing for controllers, tracked hands, and mouse;
               the two-handed world grip; orbit assist; the prediction arc
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
