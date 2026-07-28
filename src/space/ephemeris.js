import * as THREE from 'three';

// Low-precision but honest astronomy.  Everything here is good to a fraction of
// a degree, which is far tighter than anyone can judge by eye and is enough to
// put the terminator, the sun and the constellations in mutually consistent
// places.

const DEG = Math.PI / 180;

function julianCenturiesSinceJ2000(date) {
  return (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
}

function daysSinceJ2000(date) {
  return date.getTime() / 86400000 + 2440587.5 - 2451545.0;
}

/** Right ascension and declination of the sun, in radians. */
export function sunEquatorial(date) {
  const n = daysSinceJ2000(date);
  const meanLongitude = (280.46 + 0.9856474 * n) * DEG;
  const meanAnomaly = (357.528 + 0.9856003 * n) * DEG;
  const eclipticLongitude =
    meanLongitude + 1.915 * DEG * Math.sin(meanAnomaly) + 0.02 * DEG * Math.sin(2 * meanAnomaly);
  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  return { ra, dec };
}

/** Greenwich mean sidereal time, in radians. */
export function greenwichSiderealAngle(date) {
  const n = daysSinceJ2000(date);
  const t = julianCenturiesSinceJ2000(date);
  let degrees = 280.46061837 + 360.98564736629 * n + 0.000387933 * t * t;
  degrees = ((degrees % 360) + 360) % 360;
  return degrees * DEG;
}

/**
 * Equatorial (RA/dec) to the planet-fixed frame.
 *
 * The frame is +x through 0°N 0°E, +y through the north pole, +z through
 * 0°N 90°W.  West, not east: that is what makes (east, north, up) right-handed
 * at every point on the surface, and therefore what stops the entire planet
 * from rendering as its own mirror image.
 */
export function equatorialToPlanet(ra, dec, siderealAngle) {
  const longitude = ra - siderealAngle;
  const cd = Math.cos(dec);
  return new THREE.Vector3(cd * Math.cos(longitude), Math.sin(dec), -cd * Math.sin(longitude));
}

/** Planet-frame unit vector for a geographic latitude and longitude, in radians. */
export function geographicToPlanet(latitude, longitude) {
  const cl = Math.cos(latitude);
  return new THREE.Vector3(cl * Math.cos(longitude), Math.sin(latitude), -cl * Math.sin(longitude));
}

/**
 * The basis that carries the launch site to the world origin with local up
 * along +y and the requested compass heading along -z (the direction a
 * three.js camera looks).
 *
 * Returns matrices both ways plus the sun direction expressed in each frame.
 */
export function buildLaunchFrame({ latitude, longitude, heading }, date) {
  const lat = latitude * DEG;
  const lon = longitude * DEG;

  const up = geographicToPlanet(lat, lon);
  const east = new THREE.Vector3(-Math.sin(lon), 0, -Math.cos(lon)).normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();

  const bearing = heading * DEG;
  const forward = new THREE.Vector3()
    .addScaledVector(north, Math.cos(bearing))
    .addScaledVector(east, Math.sin(bearing))
    .normalize();

  // World axes expressed in planet coordinates.
  const worldZ = forward.clone().negate();
  const worldY = up.clone();
  const worldX = new THREE.Vector3().crossVectors(worldY, worldZ).normalize();

  const worldToPlanet4 = new THREE.Matrix4().makeBasis(worldX, worldY, worldZ);
  const worldToPlanet = new THREE.Matrix3().setFromMatrix4(worldToPlanet4);
  const planetToWorld = worldToPlanet.clone().transpose();

  const sidereal = greenwichSiderealAngle(date);
  const { ra, dec } = sunEquatorial(date);
  const sunPlanet = equatorialToPlanet(ra, dec, sidereal);
  const sunWorld = sunPlanet.clone().applyMatrix3(planetToWorld);

  return { up, east, north, forward, worldToPlanet, planetToWorld, sidereal, sunPlanet, sunWorld };
}

/** The date the experience is set on, from the configured day-of-year and UTC hour. */
export function epochDate({ dayOfYear, utcHours }, year = 2024) {
  const ms = Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86400000 + utcHours * 3600000;
  return new Date(ms);
}
