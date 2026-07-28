// Every shader in this project is written in GLSL ES 3.00 directly, which means
// three's #include <tonemapping_fragment> / <colorspace_fragment> chunks are not
// available to it: those still write through gl_FragColor, an identifier that
// only exists in the compatibility path.  So the last two steps of the pipeline
// are spelled out here and used by every pass, which also makes the exposure a
// single number in one place rather than a renderer setting that half the
// materials quietly ignore.

export const OUTPUT_GLSL = /* glsl */ `
uniform float uExposure;

// ACES filmic, the RRT+ODT fit from Narkowicz/Hill as three implements it.
vec3 acesFilmic(vec3 colour) {
  const mat3 ACES_INPUT = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 ACES_OUTPUT = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602)
  );
  colour *= uExposure / 0.6;
  colour = ACES_INPUT * colour;
  vec3 a = colour * (colour + 0.0245786) - 0.000090537;
  vec3 b = colour * (0.983729 * colour + 0.4329510) + 0.238081;
  colour = ACES_OUTPUT * (a / b);
  return clamp(colour, 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec4 encodeOutput(vec3 radiance, float alpha) {
  return vec4(linearToSrgb(acesFilmic(max(radiance, vec3(0.0)))), alpha);
}
`;

// Two set points, because a single one cannot serve both ends of this trip.
//
// Standing in a field, the thing that has to land correctly is the sky: too
// dim and it goes navy, too bright and it goes white.  From orbit, the thing
// that has to land correctly is a sunlit planet filling your entire field of
// view, which is a far brighter subject -- and a real eye would have stopped
// down by about a stop and a half by then.  So the exposure travels with you,
// on a slow enough time constant to read as your eyes adjusting rather than as
// a fader being pulled.
export const GROUND_EXPOSURE = 15.0;
export const ORBIT_EXPOSURE = 5.2;
export const EXPOSURE = GROUND_EXPOSURE;
