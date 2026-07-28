// Every distance in this project is in kilometres unless a name says otherwise.
// One scene unit == 1 km.  That keeps the planet, the atmosphere and a blade of
// grass in the same coordinate system without ever running out of float
// precision in a place where it matters: near the ground we only ever look at
// the low bits, and from orbit only the high ones.

export const KM = 1.0;
export const METRE = 0.001;

export const PLANET = {
  // Mean Earth radius.  The imagery is equirectangular over a sphere, so a
  // spheroid would only buy us a lie we cannot see.
  radius: 6371.0,
  atmosphereTop: 6471.0, // 100 km, the Karman line, where the sky is done
};

// Where you are standing when the experience begins.  The western slope of the
// Sierra Nevada above the San Joaquin Valley: 660 m up, real mountains 30 km to
// the east, a flat valley 30 km to the west and the Pacific coast 250 km beyond
// that — so the ascent hands you a horizon, then a coastline, then a continent,
// then a planet, roughly one every twenty seconds.
export const LAUNCH_SITE = {
  latitude: 36.95,
  longitude: -119.35,
  // Compass bearing you face at t=0.  Looking south-south-east down the line of
  // the Sierra foothills: the range climbs away on your left, the Central
  // Valley opens on your right, and the afternoon sun is off your right
  // shoulder so the land is side-lit instead of flattened by glare.  Once you
  // are a hundred kilometres up this is the view that hands you California,
  // then the coastline, then the whole west of the continent.
  heading: 155,
  eyeHeight: 1.7 * METRE,
};

// Sun position is derived from a real date and time so the terminator, the
// shadow lengths and the colour of the light all agree with each other.
// 2024-06-21 22:38 UTC == mid-afternoon at the launch site on the solstice.
export const EPOCH = {
  dayOfYear: 173,
  utcHours: 22.63,
};

export const FLIGHT = {
  // Altitude waypoints, in km, reached at the given times in seconds.
  //
  // The pacing is built around where the Earth actually is at each height.  It
  // swells to fill your entire field of view somewhere around 300-800 km and
  // starts shrinking again past 3,000, so the run lingers hardest in that band
  // and only then pulls back for the whole-disc view.
  keyframes: [
    { t: 0, alt: 0 },
    { t: 5, alt: 0.05 },
    { t: 11, alt: 0.8 },
    { t: 18, alt: 4.0 },
    { t: 26, alt: 14.0 },
    { t: 34, alt: 42.0 },     // above the weather, sky going indigo
    { t: 44, alt: 110.0 },    // Karman line; the black arrives
    { t: 56, alt: 260.0 },
    { t: 70, alt: 520.0 },    // Earth is everything you can see
    { t: 86, alt: 1100.0 },
    { t: 104, alt: 2600.0 },  // the horizon closes into a full circle
    { t: 124, alt: 6200.0 },
    { t: 148, alt: 14000.0 },
    { t: 176, alt: 18000.0 }, // blue marble: a 30-degree disc, still an object
                              // you could reach out and hold rather than a dot
  ],
  // You leave the ground upright and rotate back-first onto your stomach, so
  // the planet swings around from beneath your feet to straight ahead of you
  // and then falls away.  Degrees nose-down from the horizon, against the same
  // clock as the altitude, and never faster than about one degree a second --
  // slow enough to read as drifting rather than as being spun.
  //
  // It keeps going gently past the point where the planet fills your view,
  // because once the disc starts shrinking again it needs to be centred rather
  // than sitting low, and 90 degrees is exactly nose-down at the planet.
  pitch: [
    { t: 0, deg: 0 },
    { t: 7, deg: 0 },
    { t: 40, deg: 38 },
    { t: 66, deg: 72 },
    { t: 120, deg: 82 },
    { t: 176, deg: 87 },
  ],
};

export const QUALITY = {
  // Fragment cost of the sky is the whole ballgame on a standalone headset, so
  // the ray-march step count floats with measured frame time.
  skyStepsMin: 14,
  skyStepsMax: 40,
  targetFrameMs: 12.5, // 72 Hz with headroom for the compositor
  framebufferScale: 1.0,
  foveation: 0.6,
};
