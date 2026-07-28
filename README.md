# Skylaunch

A WebXR experience for the Meta Quest 3. You are standing in a field in the
Sierra foothills at half past four on a June afternoon. Then you start going up,
and you do not stop until the whole planet fits inside your eyes.

It is one continuous shot from a blade of grass to eighteen thousand kilometres —
no cuts, no loading, no change of scene. The sky darkens through indigo into
black, the horizon bends, the thin blue shell you have spent your whole life
inside becomes a visible object with an edge, and the Earth falls away in front
of you.

**Live:** <https://wildelmo.github.io/questskylaunch/> — open it in the Meta Quest
Browser and press **Enter VR**. Every push to `main` redeploys it.

---

## Running it

```bash
npm install
npm run dev          # serves over HTTPS on port 5173
```

WebXR needs a secure context, so the dev server uses a self-signed certificate.
On the Quest:

1. Put the headset and the computer on the same network.
2. Open the Meta Quest Browser and go to `https://<your-computer's-LAN-IP>:5173`.
3. Accept the certificate warning (once).
4. Press **Enter VR**.

The ascent starts by itself about five seconds after the session begins, so you
can put your hands down.

If you would rather not deal with certificates, the deployed copy above is
already served over HTTPS and works the same way.

For a production build:

```bash
npm run build        # -> dist/, a static site, deploy anywhere
npm run preview
```

Everything is static and self-contained — no server, no API keys, no network
access at runtime. Asset paths are relative, so it works from a subdirectory,
which is how GitHub Pages serves a project repo.

### Deployment

`.github/workflows/deploy-pages.yml` builds and publishes to GitHub Pages on
every push to `main`. It needs the repository's **Settings → Pages → Source**
set to **GitHub Actions**; nothing else is configured. The workflow checks that
the textures and the star catalogue actually made it into the bundle before it
uploads, because a build that quietly dropped them would still deploy, still
load, and just show an empty black sky.

### Controls

| Input | Effect |
| --- | --- |
| **Trigger** | Throttle, analog. Squeeze to launch. Buried, the whole climb takes eighteen seconds |
| **Grip** | Brake, analog. Ease off, stop and hang there, or come back down |
| A / X | Pause and resume; restart once you reach the top |
| Thumbstick | The same throttle and brake, for anyone who would rather not hold a trigger |
| B / Y | Comfort vignette on and off |

Let go of everything and you get the composed three-minute ride. The throttle is
something you add to that, not something you have to hold down to make anything
happen.

On a desktop browser the same scene runs in a window: drag to look, **space** to
launch, **R** to restart, **H** to hide every piece of text — the intro panel,
the Enter VR button and the in-world altitude readout — for a clean frame. The
intro panel also dismisses itself as soon as the ascent begins. It is much
easier to iterate on than the headset, and `tools/smoke.mjs` drives it
headlessly.

---

## How it is put together

### One scene, nine orders of magnitude

Everything is in kilometres, with the world origin at the launch site rather
than at the planet's centre. Near the ground you are only using the low bits of
a float; from orbit only the high ones; neither ever runs out.

The one place this can still go wrong is wrapping a tangent-plane offset back
onto the sphere. Written the obvious way — `planetCentre + normalize(x, R, z) *
(R + height)` — it builds a number near 6371 and then subtracts 6371 from it,
and single-precision floats up there are half a metre apart. The ground comes
out in half-metre terraces and everything standing on it is buried or floating.
`sphereWrap` in `src/ground/terrain.js` computes the curvature drop directly
instead, and never forms an intermediate larger than the distance travelled.

### The planet is not a mesh

There is no Earth model. A single fullscreen triangle intersects the sphere
analytically per pixel and shades whatever it hits. The horizon is therefore an
exact circle at every altitude — it cannot facet as it grows to fill your view,
and there is no LOD to pop. The same pass ray-marches the atmosphere over it, so
the limb, the aerial perspective on the ground and the colour of the sky at your
feet all come out of one function.

The ground-level scene is real geometry standing in front of that: a polar
terrain mesh whose rings subtend a constant angle, grass, oaks, a barn, a power
line. Its outer edge relaxes to exactly the analytic sphere — same height, same
colour — so when you climb high enough to see the rim, there is nothing there.

### Atmosphere

Hillaire's 2020 formulation (a re-parameterisation of Bruneton & Neyret). Three
small tables are baked once at start-up, together under 100 kB:

- **transmittance** (256×64) — how much sunlight survives a given path out to space
- **multiple scattering** (32×32) — the energy that arrives after more than one bounce, which is what keeps the horizon from going black and puts the glow in the twilight limb
- **sky irradiance** (64×32) — what the sky alone lays on an upward-facing surface

That last one is not in the original paper and it earns its place. It is the
term that decides what a shadow looks like, and approximating it as a multiple
of the multiple-scattering table — the tempting shortcut — is wrong by more than
an order of magnitude and washes the entire world out.

Everything visible is then one ray-march, which works unchanged whether the
camera is in a field or 40,000 km out. Samples are packed toward the low point
of the ray, splitting at the perigee when the ray dips and climbs again, because
that is where all the air is.

### Light

Tone mapping and sRGB encoding are written out explicitly
(`src/render/output.js`) rather than using three's shader chunks, which are
unavailable to shaders that declare GLSL ES 3.00 directly. Exposure has two set
points and travels between them: standing in a field the sky sets it, and from
orbit a sunlit planet filling your field of view sets it, which is about a stop
and a half brighter. The transition runs on a four-second time constant —
roughly how long real light adaptation takes.

Stars are the real ones: ~8,900 naked-eye entries from the HYG catalogue at
their true right ascension and declination, coloured from their B-V index, with
a procedural Milky Way behind them in galactic coordinates. Orion is where Orion
should be. Their brightness has to be artistic — a physically correct star is
orders of magnitude below a daylit sky and orders above what a headset panel can
show at night — so they are gated instead by how much lit air is still above
you. On the ground at four in the afternoon that is zero. They start arriving
around forty kilometres and are all there by eighty, which is roughly when a
real ascent hands them to you.

### Sun and time

The experience is set at a real instant, 2024-06-21 22:38 UTC, and the sun's
position is computed from it. The terminator, the shadow directions, the
sidereal angle that orients the constellations and the length of the afternoon
all agree with each other because they are all derived from the same date.

### The throttle

Hands off, the profile runs at the pace it was written for. Pull the trigger and
the multiplier goes on the profile clock, so the climb, the pitch-over and
everything derived from them speed up together — up to ten times, which collapses
the whole ascent to about eighteen seconds and puts you above the Kármán line in
five.

Three things make that feel like a launch rather than a fast-forward, and all
three are driven by the same number: **aerodynamic buffet**, computed as speed
times the square root of air density.

- **The shake.** A few millimetres of translation at ten to twenty hertz. Almost entirely positional — that reads as vibration, whereas the same amount of *rotation* reads as the world moving and is the most reliable way to make someone ill. There is a whisper of rotation for texture, and the comfort setting halves the lot.
- **The engine.** Brown noise through a steep lowpass with resonances at 31 and 62 Hz. It follows the throttle rather than the airspeed, so it arrives the instant you pull.
- **The haptics.** Both controllers, re-pulsed ten times a second because WebXR only offers one-shots.

Because buffet depends on air density, all three peak together around fourteen
kilometres and then die away *while you are still accelerating hard*. That is
max Q, it lands within a kilometre of where a real launch has it, and nothing
about it had to be arranged — it falls out of the ascent profile and the
atmosphere's scale height. The engine drops to a third of its volume at the same
time, with the top end closed right down, because past that there is no air to
carry it and what reaches you is structure-borne. The climb going quiet while
the numbers are still climbing is the best moment in the run.

One thing is deliberately *not* on the throttle. The pitch-over is rate limited
to 4.5°/s no matter how hard you pull; past that the attitude lags the profile
and catches up later. Unlimited, ten times speed would swing you through eighty
degrees in seven seconds, which is the one part of this that could genuinely
make someone ill.

### Comfort

A passive ascent is one of the gentler things to do to someone in VR, but it is
not free. Two mitigations:

- You **rotate onto your stomach at about a degree a second**, over a minute, so the planet swings from beneath your feet round to in front of your face without ever feeling like you are being spun. The rotation happens about a point near your head, not your ankles.
- An optional **vignette** shades the corners between roughly 150 m and 5 km, where the ground is still close enough to stream past you. It is **off by default** — a vertical ascent with no lateral motion is at the gentle end of what VR does to people, and darkening the edge of a view whose entire point is how far it goes is a real cost. **B / Y** turns it on.

The vignette used to be driven by climb rate over altitude plus rotation rate. Both are spline derivatives, so every kink in the ascent profile arrived amplified: it shut hard at ten seconds, sprang open at fourteen, held a shelf, stepped down at twenty and reopened at twenty-five. A vignette you can watch moving is worse than none, because it draws the eye to exactly the periphery it exists to quieten. It is now a single hump in altitude, which only ever increases, so it can rise once and fall once and do nothing else.

Nothing accelerates sharply, nothing moves sideways, and the horizon stays level
the whole way up.

### Performance

Fragment cost is the whole game on a standalone headset, so the sky's ray-march
step count floats with measured frame time (14–40 steps) and fixed foveated
rendering is on. The ground scene switches off in stages as it stops mattering —
grass by 160 m, trees by 7 km, the terrain mesh by 60 km, at which point it has
already converged on what the space pass draws anyway.

---

## Where the imagery came from

Everything rendered here is derived from public-domain NASA imagery and the HYG
star catalogue. `tools/build_assets.py` fetches, processes and packs it:

| Source | Via | Used for |
| --- | --- | --- |
| NASA Blue Marble Next Generation (5400×2700) | PyPI `basemap-data` | day-side true colour |
| NASA/NGDC shaded relief (10800×5400) | PyPI `basemap-data` | sharpening the day side, land/water mask |
| NASA Black Marble city lights | npm `three-globe` | the night side |
| NASA cloud composite | npm `three-globe` | the deck |
| topography, land/water mask | npm `three-globe` | elevation and ocean |
| HYG v3 star catalogue | npm `three-starmap` | the sky |

```bash
npm run assets       # regenerates everything under public/
```

The processed outputs are committed, so a clone runs without this step. A few
notes on what the pipeline does, because the raw plates are not usable as they
come:

- The Blue Marble plate in `basemap-data` is the **bathymetry** variant, so its oceans are painted with sea-floor depth and the continental shelves glow a bright blue no astronaut has ever seen. The water is rebuilt from scratch, with a restrained shallow-water tint so the genuinely turquoise places — the Bahamas, the Great Barrier Reef, the Persian Gulf — survive.
- Land is sharpened with real ridge structure from the 10800px relief plate rather than with an unsharp mask, so mountains gain detail instead of halos.
- Water is decided by two independent signals ANDed together: the relief plate is sharp but flags snow and ice as water, and the coarse land/water mask never confuses ice for sea but has no coastline to speak of.
- That relief plate also draws a pale stroke along every coastline, which survives sharpening as a glowing outline around each continent unless it is suppressed.

Attribution: NASA imagery is public domain. The HYG database is by David Nash /
Astronomy Nexus, CC BY-SA 4.0.

---

## Layout

```
src/
  config.js               launch site, date, ascent profile, quality targets
  main.js                 bootstrap, frame loop, level of detail, input
  flight.js               monotone-cubic ascent profile and the comfort signal
  audio.js                synthesised wind, rumble, meadow, and the drone past 80 km
  hud.js                  altitude readout and the comfort vignette
  atmosphere/
    glsl.js               the medium, the ray-march, and the three LUT shaders
    luts.js               baking them
  space/
    spacePass.js          analytic planet + atmosphere, one fullscreen triangle
    starfield.js          HYG catalogue and a procedural Milky Way
    ephemeris.js          sun position, sidereal time, the launch frame
  ground/
    terrain.js            polar terrain mesh, sphere wrapping, GPU height probe
    heightfield.js        the shared integer-hash noise
    scatter.js            grass, oaks, buildings, a power line
  render/
    environment.js        the uniforms every shader shares
    output.js             ACES + sRGB, written out by hand
tools/
  build_assets.py         the imagery pipeline
  smoke.mjs               headless render check
```

### Checking it without a headset

```bash
npm run build
node tools/smoke.mjs      # writes frames to /tmp/skylaunch-smoke
```

It serves the built site in a real Chromium with a real GL driver, parks the rig
at a list of altitudes and attitudes, and saves a frame at each one, reporting
shader errors, failed requests and draw counts. Two of the more embarrassing
bugs in this project's history — a terrain mesh wound backwards so it was
entirely back-face culled, and a sky pass flagged `transparent` so three drew it
*after* every opaque object and it painted over the whole world — were both
invisible from inside the headset and obvious in a still frame.
