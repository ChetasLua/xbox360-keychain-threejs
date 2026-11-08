// SPDX-License-Identifier: MIT
// mesh.js — Surface Nets polygonizer for signed distance functions, with normals taken from the SDF gradient
// (so a fairly coarse voxel grid still shades perfectly smooth). Supports Z-slab splitting for worker pools:
// a slab [k0, k1) emits exactly the quads whose base grid point lies in it, so slabs concatenate seamlessly.

/**
 * @param {(x:number,y:number,z:number)=>number} fn  signed distance (negative inside)
 * @param {number[]} lo  grid min corner  @param {number[]} hi grid max corner  @param {number} h voxel size
 * @param {number} [k0] first z grid index owned by this slab  @param {number} [k1] one past the last
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}}
 */
export function polygonize(fn, lo, hi, h, k0 = 0, k1 = Infinity) {
  const nx = Math.floor((hi[0] - lo[0]) / h) + 2, ny = Math.floor((hi[1] - lo[1]) / h) + 2, nz = Math.floor((hi[2] - lo[2]) / h) + 2;
  k1 = Math.min(k1, nz - 1);
  const za = Math.max(0, k0 - 1), zb = Math.min(nz - 1, k1 + 1), lz = zb - za + 1;
  // ---- sample the field (boundary forced outside so every surface closes)
  const F = new Float32Array(nx * ny * lz);
  const idx = (i, j, k) => i + nx * (j + ny * (k - za));
  for (let k = za; k <= zb; k++) {
    const z = lo[2] + k * h, kb = k === 0 || k === nz - 1;
    for (let j = 0; j < ny; j++) {
      const y = lo[1] + j * h, jb = j === 0 || j === ny - 1;
      let o = idx(0, j, k);
      for (let i = 0; i < nx; i++, o++) F[o] = (kb || jb || i === 0 || i === nx - 1) ? 1 : fn(lo[0] + i * h, y, z);
    }
  }
  // ---- one vertex per sign-changing cell (cells k in [za, zb-1])
  const cellV = new Int32Array((nx - 1) * (ny - 1) * (lz - 1)).fill(-1);
  const cidx = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * (k - za));
  const pos = [], nrm = [];
  const corner = new Float32Array(8);
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const CO = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const eps = h * 0.5;
  for (let k = za; k < zb; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const v = F[idx(i + CO[c][0], j + CO[c][1], k + CO[c][2])]; corner[c] = v; if (v < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of E) {
      const va = corner[a], vb = corner[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += CO[a][0] + (CO[b][0] - CO[a][0]) * t; sy += CO[a][1] + (CO[b][1] - CO[a][1]) * t; sz += CO[a][2] + (CO[b][2] - CO[a][2]) * t; n++;
    }
    const px = lo[0] + (i + sx / n) * h, py = lo[1] + (j + sy / n) * h, pz = lo[2] + (k + sz / n) * h;
    // gradient normal
    let gx = fn(px + eps, py, pz) - fn(px - eps, py, pz), gy = fn(px, py + eps, pz) - fn(px, py - eps, pz), gz = fn(px, py, pz + eps) - fn(px, py, pz - eps);
    const gl = Math.hypot(gx, gy, gz) || 1;
    cellV[cidx(i, j, k)] = pos.length / 3;
    pos.push(px, py, pz); nrm.push(gx / gl, gy / gl, gz / gl);
  }
  // ---- quads across sign-changing grid edges whose base point is owned by this slab
  const tri = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tri.push(a, c, b, a, d, c); else tri.push(a, b, c, a, c, d);
  };
  const kEnd = Math.min(k1, nz - 1);
  for (let k = Math.max(k0, 1); k < kEnd; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = F[idx(i, j, k)], in0 = v0 < 0;
    if (i < nx - 1 && (F[idx(i + 1, j, k)] < 0) !== in0) // x edge: cells (i, j-1..j, k-1..k)
      quad(cellV[cidx(i, j - 1, k - 1)], cellV[cidx(i, j, k - 1)], cellV[cidx(i, j, k)], cellV[cidx(i, j - 1, k)], !in0);
    if (j < ny - 1 && (F[idx(i, j + 1, k)] < 0) !== in0) // y edge: cells (i-1..i, j, k-1..k)
      quad(cellV[cidx(i - 1, j, k - 1)], cellV[cidx(i - 1, j, k)], cellV[cidx(i, j, k)], cellV[cidx(i, j, k - 1)], !in0);
    if ((F[idx(i, j, k + 1)] < 0) !== in0)              // z edge: cells (i-1..i, j-1..j, k)
      quad(cellV[cidx(i - 1, j - 1, k)], cellV[cidx(i, j - 1, k)], cellV[cidx(i, j, k)], cellV[cidx(i - 1, j, k)], !in0);
  }
  // ---- make every triangle face along its vertex normals (robust winding)
  const P = new Float32Array(pos), N = new Float32Array(nrm), I = new Uint32Array(tri);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * (N[a] + N[b] + N[c]) + fy * (N[a + 1] + N[b + 1] + N[c + 1]) + fz * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) { const s = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = s; }
  }
  return { positions: P, normals: N, indices: I };
}

/** Number of z grid points for a part (used to plan slabs). */
export function gridNZ(lo, hi, h) { return Math.floor((hi[2] - lo[2]) / h) + 2; }
