#!/usr/bin/env node
"use strict";
/**
 * Generate the Android adaptive-icon foreground from the FitShield brand master.
 *
 *   node tools/make-android-icon.js
 *
 * The launcher icon used to be a vector hand-traced from the browser icon. It
 * was close, but "close" is the wrong standard for the mark on someone's home
 * screen, and a second drawing of a logo is a second thing to keep in step with
 * the first. This renders the actual artwork instead, from
 * `brand/fitshield-f-512.png`, which is the same file that goes to the Play
 * listing as the 512x512 store icon.
 *
 * Two properties of that master shape everything here:
 *
 *   1. Its background is OPAQUE WHITE, not transparent. Composited straight
 *      into an adaptive foreground it would paint a white square edge to edge
 *      and the launcher's circular mask would show a white disc with the F
 *      floating in it, over whatever background the theme picked.
 *   2. The F BLEEDS off the bottom edge — its ink runs to the last row of
 *      pixels. Android masks an adaptive icon down to the central 72 of 108dp,
 *      so dropped in at full size the bottom of the letter is simply cut away.
 *
 * So the ink is found, cropped, and scaled to sit inside the 66dp safe circle,
 * on transparency, with the white supplied by the background layer where it
 * belongs. Nothing here is hand-measured: the bounding box is read from the
 * pixels, so re-running after an artwork change produces a correct icon rather
 * than a stale offset.
 *
 * Node built-ins only — zlib does the PNG, and the resampling is a few lines.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "brand", "fitshield-f-512.png");
const RES = path.join(ROOT, "android", "app", "src", "main", "res", "drawable-nodpi");
const OUT = path.join(RES, "ic_launcher_foreground.png");
// Android tints the monochrome layer for themed icons, so only its alpha is
// read. Deriving it from the same master is what stops the themed icon and the
// real icon being two slightly different letters.
const OUT_MONO = path.join(RES, "ic_launcher_monochrome.png");

// 108dp canvas at 4x. Android masks the canvas down to its central 72dp — but
// the SHAPE of that mask belongs to the launcher, and every OEM picks its own:
// circle, squircle, teardrop, rounded square. The only region guaranteed to
// survive all of them is the centred circle of 66dp diameter.
//
// Fitting the artwork to the 72dp SQUARE, which is what this file used to do,
// produces an icon that is clipped on most real launchers, because the corners
// of that square lie well outside the circle. It shipped that way: on a Galaxy
// S24 Ultra (One UI 8.5) the F's stem was sliced flat across the bottom. The
// check meant to catch it compared the bounding box against the same square it
// had just been fitted to, so it agreed with itself and never saw a mask.
//
// The artwork is therefore fitted to the CIRCLE — no ink further than 33dp from
// the centre. SAFE stays as a second, weaker bound; the circle is the one that
// binds for anything taller than it is wide, which a letter F is.
const CANVAS = 432;
const SAFE = Math.round(CANVAS * (72 / 108));
const SAFE_RADIUS = CANVAS * (33 / 108);
// Absorbs the half-pixel of rounding in the origin and the antialiased edge the
// bilinear resample leaves behind, so the generated file clears the circle by
// measurement rather than by intention.
const RADIUS_MARGIN = 2;

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  let bitDepth = 8;
  const idat = [];

  while (off < buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    }

    if (type === "IDAT") {
      idat.push(data);
    }

    off += 12 + length;
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`${path.basename(file)} must be 8-bit RGBA (got depth ${bitDepth}, colour type ${colorType})`);
  }

  const bpp = 4;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  let p = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = raw.subarray(p, p + stride);
    p += stride;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];

      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }

      out[y * stride + x] = v & 255;
    }
  }

  return { width, height, data: out };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  // Filter type 0 on every row: the image is small and this keeps the encoder
  // to something a reader can check by eye.
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, data.length + 8);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// The ink is everything that is neither transparent nor the white field.
function inkBounds({ width, height, data }) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;

      if (data[i + 3] < 128) continue;
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) continue;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    throw new Error("the brand master has no ink in it");
  }

  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// The furthest any ink sits from the centre of its own bounding box, in source
// pixels. Centring that box on the canvas puts the point at "radius * scale"
// from the canvas centre, which is precisely what the mask circle constrains.
// Measured over pixels rather than box corners, because a letter does not fill
// its corners and pretending it does shrinks the icon for no reason.
function inkRadius({ width, data }, ink) {
  const cx = ink.minX + ink.width / 2;
  const cy = ink.minY + ink.height / 2;
  let furthest = 0;

  for (let y = ink.minY; y < ink.minY + ink.height; y += 1) {
    for (let x = ink.minX; x < ink.minX + ink.width; x += 1) {
      const i = (y * width + x) * 4;

      if (data[i + 3] < 128) continue;
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) continue;

      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);

      if (distance > furthest) furthest = distance;
    }
  }

  if (furthest === 0) {
    throw new Error("the brand master has no ink in it");
  }

  return furthest;
}

function build() {
  const source = decodePng(SOURCE);
  const ink = inkBounds(source);

  // Fit the ink inside the safe CIRCLE, preserving aspect. The square bounds
  // stay as a floor so a very wide, very short mark cannot escape sideways.
  const radius = inkRadius(source, ink);
  const scale = Math.min(
    SAFE / ink.width,
    SAFE / ink.height,
    (SAFE_RADIUS - RADIUS_MARGIN) / radius
  );
  const drawW = Math.max(1, Math.round(ink.width * scale));
  const drawH = Math.max(1, Math.round(ink.height * scale));
  const originX = Math.round((CANVAS - drawW) / 2);
  const originY = Math.round((CANVAS - drawH) / 2);

  const out = Buffer.alloc(CANVAS * CANVAS * 4); // transparent

  for (let y = 0; y < drawH; y += 1) {
    for (let x = 0; x < drawW; x += 1) {
      // Bilinear sample from the cropped region of the master.
      const sx = ink.minX + ((x + 0.5) / scale - 0.5);
      const sy = ink.minY + ((y + 0.5) / scale - 0.5);
      const x0 = Math.max(ink.minX, Math.min(source.width - 1, Math.floor(sx)));
      const y0 = Math.max(ink.minY, Math.min(source.height - 1, Math.floor(sy)));
      const x1 = Math.min(source.width - 1, x0 + 1);
      const y1 = Math.min(source.height - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const fy = Math.min(1, Math.max(0, sy - y0));

      const at = (px, py) => (py * source.width + px) * 4;
      const corners = [at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1)];
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];

      let r = 0;
      let g = 0;
      let b = 0;

      for (let k = 0; k < 4; k += 1) {
        r += source.data[corners[k]] * weights[k];
        g += source.data[corners[k] + 1] * weights[k];
        b += source.data[corners[k] + 2] * weights[k];
      }

      // The master's field is opaque white, so alpha comes from how far the
      // pixel is from white rather than from its own alpha channel. That turns
      // the white square into transparency and keeps the letter's antialiased
      // edge, which a hard threshold would turn into stairs.
      const whiteness = Math.min(r, g, b) / 255;
      const alpha = Math.round(Math.min(1, Math.max(0, 1 - whiteness)) * 255);

      if (alpha === 0) continue;

      const o = ((originY + y) * CANVAS + (originX + x)) * 4;
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = alpha;
    }
  }

  fs.mkdirSync(RES, { recursive: true });
  fs.writeFileSync(OUT, encodePng(CANVAS, CANVAS, out));

  // Same silhouette, ink replaced by black. The system supplies the colour.
  const mono = Buffer.from(out);
  for (let i = 0; i < mono.length; i += 4) {
    mono[i] = 0;
    mono[i + 1] = 0;
    mono[i + 2] = 0;
  }
  fs.writeFileSync(OUT_MONO, encodePng(CANVAS, CANVAS, mono));

  return { ink, drawW, drawH, originX, originY, scale, radius: radius * scale };
}

// The most common ink colour, as an uppercase RRGGBB. Exposed so a test can ask
// whether the master and the browser icon are still the same green rather than
// trusting a number typed into a resource file.
function dominantHex(file) {
  const { width, height, data } = decodePng(file);
  const counts = new Map();

  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;

    if (data[o + 3] < 128) continue;
    if (data[o] > 240 && data[o + 1] > 240 && data[o + 2] > 240) continue;

    const key = `${data[o]},${data[o + 1]},${data[o + 2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  return best[0]
    .split(",")
    .map((value) => Number(value).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

module.exports = {
  build, decodePng, inkBounds, inkRadius, dominantHex,
  CANVAS, SAFE, SAFE_RADIUS, SOURCE, OUT, OUT_MONO
};

if (require.main === module) {
  const result = build();
  console.log(
    `wrote ${path.relative(ROOT, OUT).split(path.sep).join("/")} — ` +
      `${CANVAS}x${CANVAS}, artwork ${result.drawW}x${result.drawH} at ${result.originX},${result.originY} ` +
      `(ink reaches ${(result.radius / (CANVAS / 108)).toFixed(1)}dp of the 33dp safe circle), ` +
      `cropped from ink ${result.ink.width}x${result.ink.height} in the master`
  );
}
