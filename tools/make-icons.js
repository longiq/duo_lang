// Generates the PWA icons: three flags -- Vietnam, Japan, United Kingdom --
// meeting at the centre as 120-degree wedges.
//
// Drawn pixel by pixel with a hand-rolled PNG writer because the machine has no
// SVG rasteriser, and shaded with 4x4 supersampling so the wedge edges, star
// points and cross arms come out smooth rather than jagged.
//
// Full bleed on purpose: the manifest marks these maskable, so Android may crop
// to a circle or squircle. Emblems sit inside the safe radius; only wedge colour
// reaches the corners.
//
// Run with: npm run icons
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const SIZES = [180, 192, 512];
const SS = 4; // supersampling factor per axis

const COLORS = {
  vnRed: [218, 37, 29],
  vnYellow: [255, 205, 0],
  jpWhite: [255, 255, 255],
  jpRed: [188, 0, 45],
  ukBlue: [1, 33, 105],
  ukWhite: [255, 255, 255],
  ukRed: [200, 16, 46],
  seam: [26, 27, 46], // #1a1b2e, the manifest background_color
};

const TAU = Math.PI * 2;

// Wedge bisectors: Vietnam points up, Japan lower right, UK lower left.
const WEDGES = [
  { key: 'vn', centre: -Math.PI / 2 },
  { key: 'jp', centre: Math.PI / 6 },
  { key: 'uk', centre: (5 * Math.PI) / 6 },
];

function normaliseAngle(a) {
  let x = a;
  while (x <= -Math.PI) x += TAU;
  while (x > Math.PI) x -= TAU;
  return x;
}

function wedgeAt(dx, dy) {
  const angle = Math.atan2(dy, dx);
  for (const wedge of WEDGES) {
    if (Math.abs(normaliseAngle(angle - wedge.centre)) <= Math.PI / 3) return wedge;
  }
  return WEDGES[0];
}

// Distance from the nearest wedge boundary, used to draw the seams.
function seamDistance(dx, dy, size) {
  const r = Math.hypot(dx, dy);
  if (r < 1e-6) return 0;
  const angle = Math.atan2(dy, dx);
  let closest = Infinity;
  for (const wedge of WEDGES) {
    for (const edge of [wedge.centre - Math.PI / 3, wedge.centre + Math.PI / 3]) {
      const delta = Math.abs(normaliseAngle(angle - edge));
      closest = Math.min(closest, delta * r); // arc length approximates distance
    }
  }
  return closest;
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function starPolygon(cx, cy, outer, rotation) {
  const inner = outer * 0.382; // regular five-pointed star
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (i * Math.PI) / 5;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// A complete miniature union flag inside its own circle, so it stays legible
// instead of becoming an unreadable fragment. Coordinates are local to the
// roundel, not the icon.
function unionRoundel(lx, ly, r) {
  const diag1 = Math.abs(lx - ly) / Math.SQRT2;
  const diag2 = Math.abs(lx + ly) / Math.SQRT2;

  if (Math.abs(lx) < r * 0.17 || Math.abs(ly) < r * 0.17) return COLORS.ukRed;
  if (Math.abs(lx) < r * 0.30 || Math.abs(ly) < r * 0.30) return COLORS.ukWhite;
  if (diag1 < r * 0.13 || diag2 < r * 0.13) return COLORS.ukRed;
  if (diag1 < r * 0.26 || diag2 < r * 0.26) return COLORS.ukWhite;
  return COLORS.ukBlue;
}

// Colour of one sample point.
function sample(x, y, size, geom) {
  const dx = x - geom.c;
  const dy = y - geom.c;
  const r = Math.hypot(dx, dy);

  // Outside the disc is the app's own background, which also gives iOS a small
  // margin inside its rounded square.
  if (r > geom.discR) return COLORS.seam;
  if (seamDistance(dx, dy, size) < geom.seam) return COLORS.seam;

  const wedge = wedgeAt(dx, dy);

  if (wedge.key === 'vn') {
    if (pointInPolygon(x, y, geom.star)) return COLORS.vnYellow;
    return COLORS.vnRed;
  }

  if (wedge.key === 'jp') {
    if (Math.hypot(x - geom.jp[0], y - geom.jp[1]) <= geom.hinomaruR) return COLORS.jpRed;
    return COLORS.jpWhite;
  }

  const lx = x - geom.uk[0];
  const ly = y - geom.uk[1];
  if (Math.hypot(lx, ly) <= geom.roundelR) return unionRoundel(lx, ly, geom.roundelR);
  return COLORS.ukBlue;
}

function render(size) {
  const c = size / 2;
  const discR = size * 0.46;
  // Centroid of a 120-degree sector sits at about 0.55 of the radius; pull the
  // emblems in slightly so they clear the seams and the maskable safe zone.
  const emblemR = discR * 0.52;
  const at = (angle) => [c + emblemR * Math.cos(angle), c + emblemR * Math.sin(angle)];

  const geom = {
    c,
    discR,
    seam: size * 0.011,
    star: starPolygon(c, c - emblemR, discR * 0.3, -Math.PI / 2),
    jp: at(Math.PI / 6),
    hinomaruR: discR * 0.23,
    uk: at((5 * Math.PI) / 6),
    roundelR: discR * 0.27,
  };

  const raw = Buffer.alloc(size * (size * 3 + 1));
  const step = 1 / SS;
  const offset = step / 2;

  for (let py = 0; py < size; py++) {
    const rowStart = py * (size * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const col = sample(px + offset + sx * step, py + offset + sy * step, size, geom);
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const n = SS * SS;
      const i = rowStart + 1 + px * 3;
      raw[i] = Math.round(r / n);
      raw[i + 1] = Math.round(g / n);
      raw[i + 2] = Math.round(b / n);
    }
  }
  return { raw, size };
}

// --- minimal PNG writer -----------------------------------------------------

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function toPng({ raw, size }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, toPng(render(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${size}x${size})`);
}
