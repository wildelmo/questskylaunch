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

## The Poachers

Something out there has noticed your garden. Beside the info panel floats a
small caged ember — the **beacon**. Press it (or <kbd>G</kbd>) and the sky
answers: violet rifts tear open around you and alien poachers come through
them, for your worlds.

Your controllers become **ray blasters**. Hold the trigger and they hose out
laser bolts — nine a second, with a heat vein that runs cyan to red and an
overheat if you never let go. There are three silhouettes to learn:

- **Stingers** — magenta darts that weave in, snatch seeds off the nursery
  (and pocket-sized planets straight out of orbit), and sprint for a rift.
  Every theft is telegraphed: the stinger hovers with its grab beam lit for
  a beat before the snatch lands — that beam is your window to shoot it.
  One bolt kills them. Kill a courier and it *drops its cargo back into the
  garden*, where a lucky trajectory falls into a brand-new orbit.
- **Harvesters** — armoured green barges that fly a real intercept on your
  biggest planet (orbits are faster than they are, so they aim where it's
  *going*), latch on at beam range, reel it up, and tow it toward a rift.
  The planet stays in the sim while it's towed — its gravity still tugs its
  siblings on the way out. Six bolts, or one well-thrown planet, set it free.
- **Attack runs** — a ship with nothing left to steal never loiters: it
  picks a mark and dives, grazing planets hard enough to rattle their
  orbits in a shower of sparks — and once in a while the mark it picks is
  *your head*.
- **Marauders** — every fourth wave, an ember-red crescent circles the
  garden at range and lobs slow plasma orbs that stun the sun and knock your
  orbits around. The orbs are shootable. So is the marauder, eventually.

Waves escalate and score builds combos — kills within a couple of seconds of
each other climb a ×2…×5 multiplier that literally plays a rising melody up
the garden's own pentatonic scale. And the sandbox stays live the whole
time: grip still grabs, so you can swat ships out of the sky with a planet
held in your fist, and — the deliberate deep cut — **feed the sun to eight
during a siege and the nova scours every ship from the sky at once**.

In **Mixed Reality** the invasion is at its best: the rifts open around your
actual room, and the ships punch straight through your real walls on their
way to your coffee-table solar system. Best score is remembered between
sessions. Nobody shoots back — the stakes are your worlds, not your health.
The siege runs until you press the beacon again and the survivors flee.

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
| **The red beacon** | start / end the invasion |
| **Trigger** (during an invasion) | hold: fire the ray blaster |
| **Grip** (during an invasion) | still grabs and throws |

On a flat screen it degrades gracefully: drag a planet to throw it, drag empty
space to look around, scroll to zoom, click to shoot (<kbd>G</kbd> or the
beacon starts the invasion), <kbd>T</kbd>/<kbd>Space</kbd>/<kbd>C</kbd>
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
npm test             # physics + invasion sanity checks (orbits, merges, waves, heat)
npm run build        # production bundle in dist/
node tools/smoke.mjs # loads the built app in headless Chromium and pokes it —
                     # including starting an invasion and shooting down a ship
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
               the two-handed world grip; orbit assist; the prediction arc;
               the trigger's double life as a blaster
  waves.js     the invasion's pure arithmetic — wave composition, combos,
               blaster heat, swept-segment hits — testable without a browser
  ships.js     procedural enemy hulls (stinger / harvester / marauder),
               rifts, the beacon, the blaster, pooled bolts/debris/popups
  invasion.js  the war itself: the wave state machine, ship AI that steals
               seeds and tractors planets, collisions, scoring, the nova sweep
  audio.js     all sound, synthesized in WebAudio — spatialised notes,
               FM bells, the nova, and the invasion's zaps, klaxons and
               tractor-drones; nothing is a file
  panel.js     the floating help/stats card (canvas texture); turns into a
               red scoreboard while the siege is on
  main.js      scene, XR session, the garden orchestration, the loop
```

The sim runs in real units (metres, seconds) with the sun's `GM` tuned so a
gentle toss at half a metre orbits in about three seconds and a hard throw
escapes. Everything renderable is budgeted for the Quest's mobile GPU: no
shadows, no post-processing, one point light, additive sprites for all glow,
and fixed foveation — a full garden stays comfortably at the native frame rate.
The invasion keeps the same discipline: at most six ships aloft, every laser
bolt one instance of a single instanced mesh (with swept-segment collision so
nothing tunnels), pooled debris and popups, and ship AI that lives in world
space — which is why, in passthrough, the poachers fly through your walls
while the garden they're robbing scales freely in your hands. The player's
side of the fight runs on real time, deliberately outside the sim's
`timeScale`: slowing the orbits down never slows your bolts.
