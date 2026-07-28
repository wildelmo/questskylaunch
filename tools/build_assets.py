#!/usr/bin/env python3
"""
Asset pipeline for the Quest 3 "Skylaunch" WebXR experience.

Everything the experience renders is derived from public-domain NASA imagery and
the (CC BY-SA) HYG star catalogue.  Neither of those is reachable from a sandbox
that only allows package registries, so we source them from published packages:

  * PyPI  `basemap-data`  -> NASA Blue Marble Next Generation (5400x2700)
                             NASA/NGDC shaded relief          (10800x5400)
                             NOAA ETOPO1 colour relief        (5400x2700)
  * npm   `three-globe`   -> NASA Black Marble city lights    (4096x2048)
                             NASA cloud coverage composite    (4096x2048)
                             land/water mask, topography bump
  * npm   `three-starmap` -> HYG v3 naked-eye star catalogue  (~9k stars)

Outputs (all committed, so the site is self contained):

  public/textures/earth_albedo_8k.jpg   true-colour day side, relief-sharpened
  public/textures/earth_albedo_4k.jpg   low-memory fallback
  public/textures/earth_night_4k.jpg    warm city lights
  public/textures/earth_clouds_4k.jpg   cloud coverage (grayscale)
  public/textures/earth_surface_4k.jpg  R=elevation G=ocean B=snow/ice
  public/data/stars.bin                 x,y,z,mag,colour-index per star

Usage:  python3 tools/build_assets.py [--work DIR] [--out DIR]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import struct
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

NPM = "https://registry.npmjs.org"
PYPI = "https://pypi.org/pypi"

DAY_W, DAY_H = 8192, 4096
MED_W, MED_H = 4096, 2048


# --------------------------------------------------------------------------- #
# source acquisition
# --------------------------------------------------------------------------- #

def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetch {url}")
    with urllib.request.urlopen(url, timeout=300) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def npm_tarball(name: str) -> str:
    with urllib.request.urlopen(f"{NPM}/{name.replace('/', '%2f')}", timeout=120) as r:
        meta = json.load(r)
    return meta["versions"][meta["dist-tags"]["latest"]]["dist"]["tarball"]


def pypi_wheel(name: str, version: str) -> str:
    with urllib.request.urlopen(f"{PYPI}/{name}/json", timeout=120) as r:
        meta = json.load(r)
    for f in meta["releases"][version]:
        if f["filename"].endswith(".whl"):
            return f["url"]
    raise RuntimeError(f"no wheel for {name} {version}")


def acquire(work: Path) -> Path:
    """Download the source packages and unpack the images we need."""
    src = work / "src"
    src.mkdir(parents=True, exist_ok=True)
    if (src / "bmng.jpg").exists() and (src / "clouds.png").exists():
        return src

    print("acquiring source imagery")
    whl = fetch(pypi_wheel("basemap-data", "2.0.0"), work / "basemap_data.whl")
    with zipfile.ZipFile(whl) as z:
        for member, out in (
            ("mpl_toolkits/basemap_data/bmng.jpg", "bmng.jpg"),
            ("mpl_toolkits/basemap_data/shadedrelief.jpg", "shadedrelief.jpg"),
            ("mpl_toolkits/basemap_data/etopo1.jpg", "etopo1.jpg"),
        ):
            (src / out).write_bytes(z.read(member))

    tgz = fetch(npm_tarball("three-globe"), work / "three-globe.tgz")
    with tarfile.open(tgz) as t:
        for member, out in (
            ("package/example/img/earth-night.jpg", "night.jpg"),
            ("package/example/clouds/clouds.png", "clouds.png"),
            ("package/example/img/earth-water.png", "water.png"),
            ("package/example/img/earth-topology.png", "topology.png"),
        ):
            fh = t.extractfile(member)
            if fh is None:
                raise RuntimeError(f"missing {member}")
            (src / out).write_bytes(fh.read())

    tgz = fetch(npm_tarball("three-starmap"), work / "three-starmap.tgz")
    with tarfile.open(tgz) as t:
        fh = t.extractfile("package/data/visibleStarsFormatted.json")
        if fh is None:
            raise RuntimeError("missing star catalogue")
        (src / "stars.json").write_bytes(fh.read())

    return src


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def load_resized(path: Path, size, mode="RGB") -> np.ndarray:
    im = Image.open(path).convert(mode)
    if im.size != tuple(size):
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def lowpass(arr: np.ndarray, size, small=(512, 256)) -> np.ndarray:
    """Cheap wide blur: shrink hard, blur, blow back up."""
    a = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
    im = Image.fromarray(a.squeeze())
    im = im.resize(small, Image.LANCZOS).filter(ImageFilter.GaussianBlur(2.0))
    im = im.resize(size, Image.BICUBIC)
    out = np.asarray(im).astype(np.float32) / 255.0
    return out if out.ndim == arr.ndim else out[..., None]


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def save_jpeg(arr: np.ndarray, path: Path, quality=92, subsampling=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    a = np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(a.squeeze()).save(path, quality=quality, subsampling=subsampling,
                                      optimize=True, progressive=False)
    print(f"  wrote {path}  {path.stat().st_size / 1e6:.2f} MB")


# --------------------------------------------------------------------------- #
# masks derived from the shaded-relief plate (highest resolution source we have)
# --------------------------------------------------------------------------- #

def build_masks(src: Path, size):
    """Return (land, relief_detail) at `size`.

    land          1 on land, 0 on open water, coastline sharp to the relief plate
    relief_detail zero-mean high-frequency terrain structure

    Water is decided by two independent signals ANDed together: the shaded
    relief plate paints all water (including continental shelves) blue, which is
    sharp but also flags snow and ice; the low-resolution land/water mask is
    blunt but never confuses ice for sea.  A pixel is water only if both agree,
    which keeps Antarctica and Greenland on land and small islands out of the
    ocean.
    """
    relief = load_resized(src / "shadedrelief.jpg", size)
    blueness = relief[..., 2] - np.maximum(relief[..., 0], relief[..., 1])
    ocean_sharp = smoothstep(0.030, 0.055, blueness)[..., None]

    water_lo = load_resized(src / "water.png", size, mode="L")[..., None]
    water_lo = smoothstep(0.15, 0.40, water_lo)

    # Ice shelves and sea ice are pale blue and sit over water in the coarse
    # mask, so veto anything the true-colour plate says is brilliantly bright:
    # the open ocean never is.
    day = load_resized(src / "bmng.jpg", size)
    bright = smoothstep(0.45, 0.62, day.max(-1)[..., None])

    land = np.clip(1.0 - ocean_sharp * water_lo * (1.0 - bright), 0.0, 1.0)

    lum = (relief * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1)[..., None]
    detail = lum - lowpass(lum, size)

    # The relief plate draws a pale stroke along every coastline.  Left alone it
    # survives sharpening as a glowing outline around each continent, so fade
    # the detail term out wherever the land mask is changing.
    coast = np.clip(np.abs(land - lowpass(land, size, small=(1024, 512))) * 3.0, 0.0, 1.0)
    detail = detail * (1.0 - coast)
    return land.astype(np.float32), detail.astype(np.float32)


# --------------------------------------------------------------------------- #
# day-side albedo
# --------------------------------------------------------------------------- #

def build_albedo(src: Path, out: Path):
    print("building day albedo")
    size = (DAY_W, DAY_H)
    base = load_resized(src / "bmng.jpg", size)
    land, detail = build_masks(src, size)

    # This plate is the topography+bathymetry Blue Marble, so its oceans are
    # painted with sea-floor depth — continental shelves glow bright blue in a
    # way no astronaut ever sees.  Rebuild the water from scratch: a very dark
    # blue that lifts slightly toward the poles (rougher water, more
    # whitecaps), plus a restrained shallow-water tint so the genuinely
    # turquoise places -- the Bahamas, the Great Barrier Reef, the Persian
    # Gulf -- survive.
    yy = np.linspace(1.0, -1.0, DAY_H, dtype=np.float32)[:, None, None]
    lat_t = np.abs(yy)
    deep = np.array([0.016, 0.038, 0.086], np.float32)
    cold = np.array([0.030, 0.058, 0.102], np.float32)
    shelf = np.array([0.043, 0.115, 0.150], np.float32)
    ocean = deep + (cold - deep) * (lat_t ** 2)
    shallow = smoothstep(0.10, 0.46, base.max(-1, keepdims=True))
    ocean = ocean + (shelf - ocean) * (shallow * 0.55)
    ocean = ocean + detail * 0.015 * (1.0 - land)

    # Land: sharpen with real relief structure.  bmng is 5400px wide, so at 8k
    # it is soft; the 10800px relief plate puts genuine ridge/valley detail back
    # instead of the usual unsharp-mask halo.
    land_rgb = np.clip(base, 0, 1)
    land_rgb = land_rgb * (1.0 + detail * 2.15)
    land_rgb = np.clip(land_rgb + detail * 0.055, 0, 1)

    lum = (land_rgb * np.array([0.299, 0.587, 0.114], np.float32)).sum(-1, keepdims=True)
    land_rgb = np.clip(lum + (land_rgb - lum) * 1.16, 0, 1)  # gentle saturation

    rgb = ocean * (1.0 - land) + land_rgb * land
    rgb = np.clip(rgb, 0.0, 1.0)

    save_jpeg(rgb, out / "textures" / "earth_albedo_8k.jpg", quality=91, subsampling=1)

    small = Image.fromarray((rgb * 255).astype(np.uint8)).resize((MED_W, MED_H), Image.LANCZOS)
    small.save(out / "textures" / "earth_albedo_4k.jpg", quality=92, subsampling=1, optimize=True)
    print(f"  wrote {out / 'textures' / 'earth_albedo_4k.jpg'}")
    return land


# --------------------------------------------------------------------------- #
# night lights
# --------------------------------------------------------------------------- #

def build_night(src: Path, out: Path):
    print("building night lights")
    size = (MED_W, MED_H)
    n = load_resized(src / "night.jpg", size)
    r, g, b = n[..., 0], n[..., 1], n[..., 2]

    # The Black Marble composite sits on a dark blue globe.  City light is
    # neutral-to-warm, the backdrop is strongly blue biased, so subtracting a
    # fraction of blue from the min(R,G) isolates the lights cleanly.
    lights = np.clip(np.minimum(r, g) - 0.42 * b, 0.0, 1.0)
    lights = lights / max(float(lights.max()), 1e-4)
    lights = np.power(lights, 0.78)[..., None]

    sodium = np.array([1.00, 0.71, 0.42], np.float32)
    mercury = np.array([1.00, 0.96, 0.88], np.float32)
    tint = sodium + (mercury - sodium) * smoothstep(0.35, 0.95, lights)
    rgb = np.clip(lights * tint, 0.0, 1.0)
    save_jpeg(rgb, out / "textures" / "earth_night_4k.jpg", quality=90, subsampling=1)


# --------------------------------------------------------------------------- #
# clouds
# --------------------------------------------------------------------------- #

def build_clouds(src: Path, out: Path):
    print("building cloud coverage")
    size = (MED_W, MED_H)
    # Coverage lives in the alpha channel of the composite; the RGB plane is a
    # flat white.  A mild lift, no more: pushing this toward the ~2/3 figure for
    # global cloud cover buries the continents, and the views that are worth
    # having are the ones with weather systems over visible ground.
    im = Image.open(src / "clouds.png").convert("RGBA").resize(size, Image.LANCZOS)
    c = np.asarray(im)[..., 3].astype(np.float32)[..., None] / 255.0
    c = np.clip(np.power(c, 0.86) * 1.04, 0.0, 1.0)
    save_jpeg(c, out / "textures" / "earth_clouds_4k.jpg", quality=90, subsampling=0)


# --------------------------------------------------------------------------- #
# packed surface data: elevation / ocean / snow
# --------------------------------------------------------------------------- #

def build_surface(src: Path, out: Path):
    print("building packed surface map (R=elevation G=ocean B=snow)")
    size = (MED_W, MED_H)
    land, detail = build_masks(src, size)

    topo = load_resized(src / "topology.png", size, mode="L")[..., None]
    topo = topo / max(float(topo.max()), 1e-4)
    # blend real elevation with relief high-frequencies so normals have bite
    elev = np.clip(topo + detail * 0.30 * land, 0.0, 1.0)

    water = load_resized(src / "water.png", size, mode="L")[..., None]
    ocean = np.clip(np.maximum(water, 1.0 - land), 0.0, 1.0)
    ocean = np.clip((ocean - 0.35) / 0.5, 0.0, 1.0)

    day = load_resized(src / "bmng.jpg", size)
    lum = day.max(-1, keepdims=True)
    sat = day.max(-1, keepdims=True) - day.min(-1, keepdims=True)
    snow = smoothstep(0.62, 0.86, lum) * (1.0 - smoothstep(0.05, 0.18, sat)) * land
    snow = np.clip(snow, 0.0, 1.0)

    packed = np.concatenate([elev, 1.0 - ocean, snow], axis=-1)
    save_jpeg(packed, out / "textures" / "earth_surface_4k.jpg", quality=94, subsampling=0)


# --------------------------------------------------------------------------- #
# star catalogue -> compact binary
# --------------------------------------------------------------------------- #

def build_stars(src: Path, out: Path):
    print("building star catalogue")
    stars = json.loads((src / "stars.json").read_text())
    rows = []
    for s in stars:
        mag = s.get("mag")
        ra = s.get("ra")
        dec = s.get("dec")
        if mag is None or ra is None or dec is None or mag > 6.5:
            continue
        ci = s.get("ci")
        ci = 0.6 if ci is None else float(ci)
        # RA in hours -> radians, dec in degrees -> radians.  Equatorial J2000
        # in the same convention as the planet-fixed frame: +x at RA 0, +y at
        # the north celestial pole, +z at RA 18h.  A single rotation about y by
        # the sidereal angle then carries the sky onto the ground.
        a = float(ra) * (np.pi / 12.0)
        d = float(dec) * (np.pi / 180.0)
        cd = np.cos(d)
        rows.append((cd * np.cos(a), np.sin(d), -cd * np.sin(a), float(mag), ci))

    rows.sort(key=lambda r: r[3])
    arr = np.asarray(rows, dtype=np.float32)
    path = out / "data" / "stars.bin"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"SKY1")
        f.write(struct.pack("<I", arr.shape[0]))
        f.write(arr.tobytes())
    print(f"  wrote {path}  {arr.shape[0]} stars, {path.stat().st_size / 1e3:.1f} kB")


# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=".asset-cache")
    ap.add_argument("--out", default="public")
    ap.add_argument("--only", default="", help="comma list: albedo,night,clouds,surface,stars")
    args = ap.parse_args()

    work = Path(args.work).resolve()
    out = Path(args.out).resolve()
    src = acquire(work)

    only = {s for s in args.only.split(",") if s}
    steps = {
        "albedo": lambda: build_albedo(src, out),
        "night": lambda: build_night(src, out),
        "clouds": lambda: build_clouds(src, out),
        "surface": lambda: build_surface(src, out),
        "stars": lambda: build_stars(src, out),
    }
    for name, fn in steps.items():
        if only and name not in only:
            continue
        fn()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
