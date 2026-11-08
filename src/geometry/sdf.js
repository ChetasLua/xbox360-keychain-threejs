// SPDX-License-Identifier: MIT
// sdf.js — every part of the controller as a signed distance function (cm, model space: X right, Z up, front = -Y).
// Direct port of the numpy modelling script used for the Cycles film. Pure JS, no three.js — runs in workers.
import { POS, ABXY_OFF, outlineControlPoints, sstep, faceY } from '../layout.js';

const { sqrt, abs, max, min, cos, sin, atan2, PI } = Math;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export function smin(a, b, k) { if (k <= 0) return min(a, b); const h = clamp01(0.5 + 0.5 * (b - a) / k); return b + (a - b) * h - k * h * (1 - h); }
export function smax(a, b, k) { return -smin(-a, -b, k); }
const len2 = (a, b) => sqrt(a * a + b * b);
const len3 = (a, b, c) => sqrt(a * a + b * b + c * c);
function torus(x, y, z, R, r) { const q = len2(x, z) - R; return len2(q, y) - r; } // axis = y
function rbox(x, y, z, bx, by, bz, r) {
  const qx = abs(x) - bx + r, qy = abs(y) - by + r, qz = abs(z) - bz + r;
  return len3(max(qx, 0), max(qy, 0), max(qz, 0)) + min(max(qx, max(qy, qz)), 0) - r;
}
function cylY(x, y, z, r, y0, y1, rr = 0) { // capped cylinder along y, edge round rr
  const dr = len2(x, z) - r + rr, dy = abs(y - (y0 + y1) / 2) - (y1 - y0) / 2 + rr;
  return len2(max(dr, 0), max(dy, 0)) + min(max(dr, dy), 0) - rr;
}
function cylZ(x, y, z, r, z0, z1, rr = 0) { // capped cylinder along z
  const dr = len2(x, y) - r + rr, dz = abs(z - (z0 + z1) / 2) - (z1 - z0) / 2 + rr;
  return len2(max(dr, 0), max(dz, 0)) + min(max(dr, dz), 0) - rr;
}
function roundSlab(a, b, r) { const qa = a + r, qb = b + r; return len2(max(qa, 0), max(qb, 0)) + min(max(qa, qb), 0) - r; }

// ------------------------------------------------------------------ outline (2D SDF cached on a grid)
let D2 = null; const G = { x0: -8.8, z0: -8.0, h: 0.025, nx: 0, nz: 0 };
function catmull(pts, n) {
  const m = pts.length, out = [], per = Math.floor(n / m);
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m], p3 = pts[(i + 2) % m];
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  return out;
}
/** Use an outline grid computed elsewhere (shared between workers). */
export function setOutline(buf) { D2 = buf; G.nx = Math.round((8.8 - G.x0) / G.h) + 1; G.nz = Math.round((4.8 - G.z0) / G.h) + 1; }
/** Exact polygon distance on a 0.025 cm grid (~0.3 s); returns the Float32Array so it can be shared. */
export function outlineDims() { return [Math.round((8.8 - G.x0) / G.h) + 1, Math.round((4.8 - G.z0) / G.h) + 1]; }
export function initOutline(j0 = 0, j1 = Infinity) {
  if (D2 && j0 === 0 && j1 === Infinity) return D2;
  const poly = catmull(outlineControlPoints(), 720), n = poly.length;
  G.nx = Math.round((8.8 - G.x0) / G.h) + 1; G.nz = Math.round((4.8 - G.z0) / G.h) + 1;
  j1 = Math.min(j1, G.nz);
  const out = new Float32Array(G.nx * (j1 - j0));
  const ax = new Float64Array(n), az = new Float64Array(n), ex = new Float64Array(n), ez = new Float64Array(n), il = new Float64Array(n), bzA = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = poly[(i - 1 + n) % n], b = poly[i]; ax[i] = a[0]; az[i] = a[1]; ex[i] = b[0] - a[0]; ez[i] = b[1] - a[1]; bzA[i] = b[1]; il[i] = 1 / (ex[i] * ex[i] + ez[i] * ez[i]); }
  // exact distance to the polygon; points far from the curve (judged from a 0.2 cm coarse pass) only need
  // the sign and a lower bound, so the expensive segment scan runs on a thin band around the outline
  const exact = (px, pz) => {
    let d = 1e9, inside = false;
    for (let s = 0; s < n; s++) {
      const wx = px - ax[s], wz = pz - az[s];
      let t = (wx * ex[s] + wz * ez[s]) * il[s]; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = wx - ex[s] * t, dz = wz - ez[s] * t, dd = dx * dx + dz * dz; if (dd < d) d = dd;
      const bz = bzA[s]; // exact shared endpoint keeps the half-open test consistent
      if ((az[s] > pz) !== (bz > pz) && px < ax[s] + (pz - az[s]) * ex[s] / ez[s]) inside = !inside;
    }
    return (inside ? -1 : 1) * sqrt(d);
  };
  const CH = 0.2, cnx = Math.ceil((G.nx - 1) * G.h / CH) + 2, czLo = Math.floor(j0 * G.h / CH), czHi = Math.ceil((j1 - 1) * G.h / CH) + 1;
  const coarse = new Float64Array(cnx * (czHi - czLo + 1));
  for (let cj = czLo; cj <= czHi; cj++) for (let ci = 0; ci < cnx; ci++) coarse[(cj - czLo) * cnx + ci] = exact(G.x0 + ci * CH, G.z0 + cj * CH);
  for (let j = j0; j < j1; j++) {
    const pz = G.z0 + j * G.h, fz = (j * G.h) / CH, cj = Math.min(Math.floor(fz), czHi - 1), v = fz - cj;
    for (let i = 0; i < G.nx; i++) {
      const fx = (i * G.h) / CH, ci = Math.min(Math.floor(fx), cnx - 2), u = fx - ci, b0 = (cj - czLo) * cnx + ci;
      const est = (coarse[b0] * (1 - u) + coarse[b0 + 1] * u) * (1 - v) + (coarse[b0 + cnx] * (1 - u) + coarse[b0 + cnx + 1] * u) * v;
      // bilinear of an SDF is within ~CH*0.71 of the truth: outside a 0.5 cm band the estimate is plenty
      out[(j - j0) * G.nx + i] = abs(est) > 0.5 ? est : exact(G.x0 + i * G.h, pz);
    }
  }
  if (j0 === 0 && j1 === G.nz) D2 = out;
  return out;
}
export function d2(x, z) {
  let fx = (x - G.x0) / G.h, fz = (z - G.z0) / G.h;
  fx = fx < 0 ? 0 : fx > G.nx - 1.001 ? G.nx - 1.001 : fx; fz = fz < 0 ? 0 : fz > G.nz - 1.001 ? G.nz - 1.001 : fz;
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * G.nx + i;
  return (D2[k] * (1 - u) + D2[k + 1] * u) * (1 - v) + (D2[k + G.nx] * (1 - u) + D2[k + G.nx + 1] * u) * v;
}

// ------------------------------------------------------------------ body
function backY(x, z) {
  const ax = abs(x), g = sstep(-0.3, -4.5, z) * sstep(1.4, 4.4, ax), top = sstep(1.2, 3.4, z);
  return 0.75 + 1.55 * g + 0.75 * top - 0.25 * sstep(5.5, 7.6, ax) * top;
}
function bodyCore(x, y, z) {
  const dd = d2(x, z), yf = faceY(x, z), yb = backY(x, z);
  const g = sstep(-0.5, -5.0, z) * sstep(1.5, 4.5, abs(x)), r = 1.05 + 0.65 * g;
  return roundSlab(dd, max(yf - y, y - yb), r);
}
function seam(d, y) { const groove = max(abs(y + 0.30) - 0.045, -(d + 0.07)); return max(d, -groove); }
const FY = (k) => faceY(POS[k][0], POS[k][1]);
const ST = ['lstick', 'rstick'].map((k) => [POS[k][0], POS[k][1], FY(k)]);
const DP = [POS.dpad[0], POS.dpad[1], FY('dpad')];
const GEMS = Object.values(ABXY_OFF).map(([ox, oz]) => { const cx = POS.abxy[0] + ox, cz = POS.abxy[1] + oz; return [cx, cz, faceY(cx, cz)]; });
const GU = [POS.guide[0], POS.guide[1], FY('guide')];
const BS = ['back', 'start'].map((k) => [POS[k][0], POS[k][1], FY(k)]);

export function body(x, y, z) {
  let d = bodyCore(x, y, z);
  if (d > 1.2) return d; // far outside: features cannot matter
  for (const [cx, cz, yf] of ST) {
    const lx = x - cx, lz = z - cz;
    d = smin(d, torus(lx, y - yf + 0.02, lz, 1.42, 0.24), 0.30);
    d = smax(d, -cylY(lx, y, lz, 1.13, yf - 1.0, yf + 0.9), 0.07);
  }
  { const [cx, cz, yf] = DP, lx = x - cx, lz = z - cz;
    d = smin(d, torus(lx, y - yf + 0.02, lz, 1.28, 0.15), 0.22);
    d = smax(d, -cylY(lx, y, lz, 1.17, yf - 1.0, yf + 0.32), 0.05); }
  for (const [cx, cz, yf] of GEMS) d = smax(d, -cylY(x - cx, y, z - cz, 0.52, yf - 1.0, yf + 0.6), 0.05);
  { const [cx, cz, yf] = GU, lx = x - cx, lz = z - cz;
    d = smin(d, torus(lx, y - yf, lz, 1.38, 0.16), 0.25);
    d = smax(d, -cylY(lx, y, lz, 1.24, yf - 1.0, yf + 0.40), 0.05); }
  for (const [cx, cz, yf] of BS) d = smax(d, -cylY(x - cx, y, z - cz, 0.37, yf - 1.0, yf + 0.5), 0.04);
  d = seam(d, y);
  d = smax(d, -max(len2(x, y + 0.55) - 0.13, abs(z + 3.2) - 0.6), 0.02);      // headset jack
  d = smax(d, -rbox(x, y - 0.35, z + 3.1, 0.75, 0.16, 0.6, 0.06), 0.03);      // expansion port
  d = smax(d, -rbox(x, y - 0.1, z - 3.35, 0.55, 0.12, 0.5, 0.05), 0.02);      // charge slot
  d = smin(d, rbox(x, y - 0.1, z - 3.3, 0.66, 0.22, 0.12, 0.08), 0.06);       // raised lip framing the charge slot
  d = smax(d, -rbox(x, y - 0.1, z - 3.35, 0.55, 0.12, 0.5, 0.05), 0.015);
  d = smax(d, -cylZ(x + 1.25, y + 0.05, z, 0.205, 3.0, 4.0), 0.02);           // sync-button well (top, left of the port)
  for (const sx of [-2.85, 2.85]) {                                            // two screw recesses on the back shell
    d = smax(d, -cylY(x - sx, y, z - 1.55, 0.17, 0.62, 2.5), 0.025);
  }
  return d;
}
export function bodyBlank(x, y, z) { return seam(bodyCore(x, y, z), y); }
export function eyelet(x, y, z) { return smin(torus(x, y + 0.15, z - 3.78, 0.36, 0.12), rbox(x, y + 0.15, z - 3.35, 0.22, 0.12, 0.25, 0.1), 0.1); }

// ------------------------------------------------------------------ small parts (local: face plane y=0, -y toward camera)
export function stick(x, Y, z) {
  const y = Y - 0.22, rad = len2(x, z), th = atan2(z, x);
  let d = smin(max(len3(x, y - 0.30, z) - 1.04, y - 0.6), cylY(x, y, z, 0.43, -0.95, 0.0), 0.18);
  let cap = cylY(x, y, z, 1.0, -1.36, -0.92, 0.14);
  const dish = len3(x, y - (-1.36 - 4.2 + 0.075), z) - 4.2;
  cap = smax(cap, -max(dish, rad - 0.80), 0.05);
  const rim = sstep(0.74, 0.86, rad);
  cap -= 0.010 * rim * (0.5 + 0.5 * cos(th * 36));
  cap += 0.004 * (1 - rim) * cos(rad * 80) * sstep(0.1, 0.25, rad);
  const side = sstep(0.93, 0.99, rad) * sstep(-0.95, -1.05, y) * sstep(-1.36, -1.26, y);
  cap -= 0.006 * side * (0.5 + 0.5 * cos(th * 72));                              // fine vertical grip ribs on the cap wall
  d += 0.0025 * cos(atan2(rad, 0.30 - y) * 48) * sstep(0.45, 0.7, rad);        // concentric rings on the pivot dome
  return smin(d, cap, 0.10);
}
const ARMS = [0, 90, 180, 270].map((a) => [cos(a * PI / 180), sin(a * PI / 180)]);
export function dpad(x, y, z) {
  const disc = cylY(x, y, z, 1.06, -0.30, 0.25, 0.08);
  let cross = min(rbox(x, y + 0.36, z, 1.0, 0.14, 0.33, 0.10), rbox(x, y + 0.36, z, 0.33, 0.14, 1.0, 0.10));
  cross = smax(cross, len2(x, z) - 1.0, 0.06);
  let d = smin(disc, cross, 0.07);
  d = smax(d, -(len3(x, y + 0.62, z) - 0.17), 0.04);
  d = smax(d, -(len3(x, y + 0.50 + 4.0 - 0.012, z) - 4.0), 0.02);              // shallow dish across the arm tops
  d = smax(d, -max(abs(len2(x, z) - 0.985) - 0.012, abs(y + 0.30) - 0.02), 0.006); // engraved ring near the disc rim
  for (const s2 of [1, -1]) {                                                     // diagonal parting seams between arms
    const u = (x + s2 * z) * 0.7071, v = (x - s2 * z) * 0.7071;
    d = smax(d, -max(max(abs(u) - 0.008, abs(v) - 1.02), max(0.45 - abs(v), y + 0.27)), 0.004);
  }
  for (const [ca, sa] of ARMS) {
    const u = x * ca + z * sa, v = -x * sa + z * ca;
    const tri = max(max(abs(v) * 1.2 + (u - 0.80), 0.62 - u), -(y + 0.60));
    d = smax(d, -max(tri, abs(y + 0.50) - 0.03), 0.01);
  }
  return d;
}
export function gem(x, y, z) {
  let d = smax(cylY(x, y, z, 0.47, -0.36, 0.30, 0.10), len3(x, y - 0.55, z) - 0.98, 0.06);
  d = smax(d, -max(abs(len2(x, z) - 0.405) - 0.01, abs(y + 0.34) - 0.025), 0.006);  // fine step where the dome meets the wall
  return smin(d, cylY(x, y, z, 0.515, 0.12, 0.30, 0.03), 0.02);                  // retaining flange (seen inside the hole)
}
export function guide(x, y, z) { return smin(max(len3(x, y - 0.42, z) - 0.86, y - 0.25), cylY(x, y, z, 0.80, -0.28, 0.25, 0.05), 0.08); }
function ringQ(q) {
  const c = [135, 45, -45, -135][q] * PI / 180;
  return (x, y, z) => {
    const rad = len2(x, z), th = atan2(z, x);
    const ring = max(abs(rad - 1.02) - 0.17, abs(y + 0.04) - 0.10);
    let dth = abs(th - c); dth = dth > PI ? 2 * PI - dth : dth;
    return smax(ring, (dth - (PI / 4 - 0.055)) * rad, 0.04);
  };
}
export function bezel(x, y, z) { return max(abs(len2(x, z) - 1.215) - 0.035, abs(y + 0.06) - 0.11) - 0.012; }
// clear acrylic lens that covers the four ring-of-light segments
export function ringlens(x, y, z) { return roundSlab(abs(len2(x, z) - 1.02) - 0.18, abs(y + 0.155) - 0.022, 0.018); }
export function smallbtn(x, y, z) { return smax(cylY(x, y, z, 0.31, -0.20, 0.25, 0.07), len3(x, y - 1.2, z) - 1.42, 0.04); }
function bumper(s) {
  return (x, y, z) => {
    const dd = d2(x, z), u = s * x;
    let band = max(-dd - 0.25, dd - 0.42);
    band = smax(band, -(z - 2.35), 0.25);
    band = smax(band, max(2.35 - u, u - 7.25), 0.35);
    let d = roundSlab(band, abs(y + 0.45) - 0.80, 0.28);
    d += 0.0045 * cos(dd * 130) * sstep(3.0, 3.4, z) * sstep(2.6, 3.2, u) * sstep(7.0, 6.4, u); // finger ribs along the top
    return d;
  };
}
// Trigger: a curved finger blade wrapping the top-back corner behind the bumper (polished vs the Cycles box).
function trigger(s) {
  const a = -32 * PI / 180, ca = cos(a), sa = sin(a);
  return (x, y, z) => {
    const u = s * x - 5.0, yy = y - 1.45, zz = z - 3.0;
    const ry = yy * ca - zz * sa, rz = yy * sa + zz * ca;
    // blade: thick arc in the (ry,rz) plane, tapered at the ends
    const arc = len2(ry + 0.35, rz + 1.25) - 1.75;
    let d = max(abs(arc) - 0.30 + 0.06 * ry, max(-rz + 0.0 - 0.15, ry - 0.95));
    d = max(d, -ry - 1.05);
    d = roundSlab(d, abs(u) - 1.05 + 0.12 * max(rz, 0), 0.22);
    d += 0.005 * cos(ry * 55) * sstep(0.0, 0.3, rz);   // fine grip lines on the finger face
    return d;
  };
}
export function battery(x, y, z) {
  const yb = 0.95;
  let d = smin(rbox(x, y - (yb + 0.25), z + 1.15, 2.25, 0.42, 1.65, 0.38), rbox(x, y - (yb + 0.72), z - 0.25, 0.55, 0.08, 0.22, 0.06), 0.06);
  for (let i = 0; i < 5; i++) d = smax(d, -rbox(x, y - (yb + 0.81), z - (0.10 + i * 0.075), 0.48, 0.03, 0.014, 0.005), 0.005);
  return d;
}
const tor = (R, r) => (x, y, z) => torus(x, y, z, R, r);
export function link(x, y, z) { const zz = max(abs(z) - 0.16, 0); return len2(len2(x, zz) - 0.13, y) - 0.042; }
function angGap(th, c, w, R) { let dt = abs(th - c); dt = dt > PI ? 2 * PI - dt : dt; return (w - dt) * R; } // >0 inside the gap
export function splitring(x, y, z) {
  const th = atan2(z, x);
  const a = max(torus(x, y - 0.062, z, 1.15, 0.075), angGap(th, 1.15, 0.09, 1.15));   // back coil, cut end
  const b = max(torus(x, y + 0.062, z, 1.15, 0.075), angGap(th, -2.2, 0.06, 1.15));   // front coil, cut end
  return min(a, b);
}
export function jumpring(x, y, z) { return max(torus(x, y, z, 0.30, 0.055), angGap(atan2(z, x), 0, 0.05, 0.30)); }
export function screw(x, y, z) { // pan-head screw, cross recess, axis +y (head faces +y / backwards)
  let d = smax(cylY(x, y, z, 0.13, 0.0, 0.06, 0.03), len3(x, y + 0.5, z) - 0.58, 0.02);
  const cross = min(max(abs(x) - 0.022, abs(z) - 0.075), max(abs(z) - 0.022, abs(x) - 0.075));
  return smax(d, -max(cross, -(y - 0.035)), 0.008);
}
export function syncbtn(x, y, z) { return smax(cylZ(x, y, z, 0.17, -0.25, 0.06, 0.05), len3(x, y, z + 1.2) - 1.28, 0.02); }
// dark rubber membrane cup that lines each face-button hole (makes the glass gems read deep, like the real pad)
export function cup(x, y, z) { const r = len2(x, z); return smin(max(abs(r - 0.505) - 0.012, abs(y - 0.33) - 0.33), cylY(x, y, z, 0.52, 0.55, 0.64), 0.01); }
export function pins(x, y, z) { let d = 1e9; for (const px of [-0.3, -0.1, 0.1, 0.3]) d = min(d, rbox(x - px, y, z, 0.035, 0.05, 0.12, 0.012)); return d; }
export function logo(x, y, z) { return len3(x, y, z) - 0.62; }
// Xbox-style X: two smooth symmetric swooshes embossed on the sphere, thick at the centre, tapering to the rim.
export function logox(x, y, z) {
  const r = len3(x, y, z), shell = max(r - 0.662, 0.60 - r);
  const bar = (sg) => {
    const ca = cos(sg * PI / 4), sa = sin(sg * PI / 4);
    const u = x * ca + z * sa, v = -x * sa + z * ca, t = min(abs(u) / 0.44, 1);
    const w = 0.072 + 0.058 * (1 - t * t);
    const vv = v;                                   // straight tapered arms keep the X symmetric
    return max(abs(vv) - w, abs(u) - 0.44);
  };
  return max(shell, max(min(bar(1), bar(-1)), y));
}

// ------------------------------------------------------------------ glyphs (rounded strokes, readable from -Y, +Z up)
function seg(px, pz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, wx = px - ax, wz = pz - az;
  const t = clamp01((wx * ex + wz * ez) / (ex * ex + ez * ez));
  return len2(wx - ex * t, wz - ez * t);
}
function halfRing(px, pz, cx, cz, R) { // right half of a ring
  if (px >= cx) return abs(len2(px - cx, pz - cz) - R);
  return min(len2(px - cx, pz - (cz + R)), len2(px - cx, pz - (cz - R)));
}
const STROKE = 0.052, THICK = 0.0175;
function glyph(fn2) { return (x, y, z) => roundSlab(fn2(x, z) - STROKE, abs(y) - THICK, 0.012); }
const GLYPH = {
  A: (x, z) => min(seg(x, z, -0.19, -0.25, 0, 0.25), seg(x, z, 0, 0.25, 0.19, -0.25), seg(x, z, -0.105, -0.07, 0.105, -0.07)),
  X: (x, z) => min(seg(x, z, -0.17, -0.25, 0.17, 0.25), seg(x, z, -0.17, 0.25, 0.17, -0.25)),
  Y: (x, z) => min(seg(x, z, -0.17, 0.25, 0, 0.0), seg(x, z, 0.17, 0.25, 0, 0.0), seg(x, z, 0, 0.0, 0, -0.25)),
  B: (x, z) => min(seg(x, z, -0.15, -0.25, -0.15, 0.25), seg(x, z, -0.15, 0.25, 0.03, 0.25), seg(x, z, -0.15, 0.005, 0.05, 0.005),
    seg(x, z, -0.15, -0.25, 0.05, -0.25), halfRing(x, z, 0.03, 0.1275, 0.1225), halfRing(x, z, 0.05, -0.1225, 0.1275)),
};
function tri(dir) { // rounded ◀ / ▶ glyph, 0.24 cm, pointing toward +X*dir
  const s = 0.24, n = 1.156;
  return (x, y, z) => {
    const px = x * dir;
    const d = max(-(px + 0.5 * s), (0.58 * px + abs(z) - 0.29 * s) / n);
    return roundSlab(d + 0.012, abs(y) - 0.02, 0.015);
  };
}

// ------------------------------------------------------------------ jobs: name -> {fn, lo, hi, h}
// h = voxel size used for in-browser meshing (Surface Nets + SDF-gradient normals keep it smooth).
export const PARTS = {
  body: { fn: body, lo: [-8.4, -2.0, -7.7], hi: [8.4, 3.2, 4.4], h: 0.031, slabs: true },
  body_blank: { fn: bodyBlank, lo: [-8.4, -2.0, -7.7], hi: [8.4, 3.2, 4.4], h: 0.05, slabs: true },
  eyelet: { fn: eyelet, lo: [-0.6, -0.45, 2.9], hi: [0.6, 0.15, 4.3], h: 0.012 },
  stick: { fn: stick, lo: [-1.15, -1.5, -1.15], hi: [1.15, 0.7, 1.15], h: 0.0105 },
  dpad: { fn: dpad, lo: [-1.15, -0.65, -1.15], hi: [1.15, 0.35, 1.15], h: 0.01 },
  gem: { fn: gem, lo: [-0.55, -0.45, -0.55], hi: [0.55, 0.38, 0.55], h: 0.009 },
  guide: { fn: guide, lo: [-0.95, -0.5, -0.95], hi: [0.95, 0.35, 0.95], h: 0.012 },
  logo: { fn: logo, lo: [-0.68, -0.68, -0.68], hi: [0.68, 0.68, 0.68], h: 0.012 },
  logox: { fn: logox, lo: [-0.68, -0.68, -0.68], hi: [0.68, 0.1, 0.68], h: 0.006 },
  ringq0: { fn: ringQ(0), lo: [-1.3, -0.25, -1.3], hi: [1.3, 0.15, 1.3], h: 0.012 },
  ringq1: { fn: ringQ(1), lo: [-1.3, -0.25, -1.3], hi: [1.3, 0.15, 1.3], h: 0.012 },
  ringq2: { fn: ringQ(2), lo: [-1.3, -0.25, -1.3], hi: [1.3, 0.15, 1.3], h: 0.012 },
  ringq3: { fn: ringQ(3), lo: [-1.3, -0.25, -1.3], hi: [1.3, 0.15, 1.3], h: 0.012 },
  bezel: { fn: bezel, lo: [-1.35, -0.25, -1.35], hi: [1.35, 0.12, 1.35], h: 0.009 },
  smallbtn: { fn: smallbtn, lo: [-0.4, -0.3, -0.4], hi: [0.4, 0.3, 0.4], h: 0.008 },
  ringlens: { fn: ringlens, lo: [-1.3, -0.25, -1.3], hi: [1.3, -0.08, 1.3], h: 0.01 },
  screw: { fn: screw, lo: [-0.18, -0.12, -0.18], hi: [0.18, 0.12, 0.18], h: 0.005 },
  syncbtn: { fn: syncbtn, lo: [-0.24, -0.24, -0.33], hi: [0.24, 0.24, 0.14], h: 0.006 },
  cup: { fn: cup, lo: [-0.6, -0.1, -0.6], hi: [0.6, 0.75, 0.6], h: 0.01 },
  pins: { fn: pins, lo: [-0.4, -0.1, -0.18], hi: [0.4, 0.1, 0.18], h: 0.006 },
  bumperL: { fn: bumper(-1), lo: [-7.9, -1.4, 2.0], hi: [-2.0, 0.3, 4.3], h: 0.025 },
  bumperR: { fn: bumper(1), lo: [2.0, -1.4, 2.0], hi: [7.9, 0.3, 4.3], h: 0.025 },
  triggerL: { fn: trigger(-1), lo: [-6.6, -0.6, 1.2], hi: [-3.4, 3.4, 4.8], h: 0.025 },
  triggerR: { fn: trigger(1), lo: [3.4, -0.6, 1.2], hi: [6.6, 3.4, 4.8], h: 0.025 },
  battery: { fn: battery, lo: [-2.6, 0.6, -3.2], hi: [2.6, 2.0, 0.9], h: 0.016 },
  jumpring: { fn: jumpring, lo: [-0.4, -0.1, -0.4], hi: [0.4, 0.1, 0.4], h: 0.008 },
  link: { fn: link, lo: [-0.2, -0.06, -0.36], hi: [0.2, 0.06, 0.36], h: 0.007 },
  splitring: { fn: splitring, lo: [-1.25, -0.2, -1.25], hi: [1.25, 0.2, 1.25], h: 0.01 },
  letA: { fn: glyph(GLYPH.A), lo: [-0.3, -0.06, -0.33], hi: [0.3, 0.06, 0.33], h: 0.005 },
  letB: { fn: glyph(GLYPH.B), lo: [-0.3, -0.06, -0.33], hi: [0.3, 0.06, 0.33], h: 0.005 },
  letX: { fn: glyph(GLYPH.X), lo: [-0.3, -0.06, -0.33], hi: [0.3, 0.06, 0.33], h: 0.005 },
  letY: { fn: glyph(GLYPH.Y), lo: [-0.3, -0.06, -0.33], hi: [0.3, 0.06, 0.33], h: 0.005 },
  triL: { fn: tri(-1), lo: [-0.2, -0.05, -0.2], hi: [0.2, 0.05, 0.2], h: 0.004 },
  triR: { fn: tri(1), lo: [-0.2, -0.05, -0.2], hi: [0.2, 0.05, 0.2], h: 0.004 },
};
export const NEEDS_OUTLINE = new Set(['body', 'body_blank', 'bumperL', 'bumperR']);
