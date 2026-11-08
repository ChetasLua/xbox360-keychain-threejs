// SPDX-License-Identifier: MIT
// build.js — meshes every SDF part in a worker pool and returns three.js BufferGeometries (model space, cm).
import * as THREE from 'three';
import { PARTS, NEEDS_OUTLINE, outlineDims } from './sdf.js';
import { gridNZ } from './mesh.js';

export const BUILD = '2026-11-09d'; // bump on every deploy: versions the worker and its imports
const SLAB = +(new URLSearchParams(location.search).get('slab') || 16); // z layers per slab job for the big parts

export async function buildAllGeometry({ onProgress = () => {} } = {}) {
  const n = Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 12));
  const workers = Array.from({ length: n }, () => new Worker(new URL('./worker.js?v=' + BUILD, import.meta.url), { type: 'module' }));
  let nextId = 1; const waiting = new Map();
  for (const w of workers) w.onmessage = (e) => { const cb = waiting.get(e.data.id); waiting.delete(e.data.id); cb(e.data); };
  const call = (w, msg, transfer) => new Promise((res, rej) => {
    const id = nextId++; waiting.set(id, (d) => (d.error ? rej(new Error(d.error)) : res(d))); w.postMessage({ ...msg, id }, transfer || []);
  });

  onProgress(0, 'tracing the outline');
  // the 2D outline SDF is computed in row bands across the whole pool, then shared with every worker
  const [onx, onz] = outlineDims(), band = Math.ceil(onz / n);
  const parts = await Promise.all(workers.map((w, i) => call(w, { type: 'outline', j0: i * band, j1: Math.min(onz, (i + 1) * band) })));
  const outline = new Float32Array(onx * onz);
  parts.forEach((r, i) => outline.set(r.rows, i * band * onx));

  // plan jobs (largest first so the pool stays busy)
  const jobs = [];
  for (const [name, p] of Object.entries(PARTS)) {
    if (p.slabs) { const nz = gridNZ(p.lo, p.hi, p.h); for (let k = 0; k < nz; k += SLAB) jobs.push({ name, k0: k, k1: k + SLAB, cost: SLAB * 4 }); }
    else jobs.push({ name, cost: 1 });
  }
  jobs.sort((a, b) => b.cost - a.cost);
  const total = jobs.length; let done = 0;
  const pieces = new Map();
  let cursor = 0;
  await Promise.all(workers.map(async (w) => {
    while (cursor < jobs.length) {
      const j = jobs[cursor++];
      const msg = { name: j.name, k0: j.k0, k1: j.k1 };
      if (NEEDS_OUTLINE.has(j.name)) msg.outline = outline;
      const r = await call(w, msg);
      if (!pieces.has(j.name)) pieces.set(j.name, []);
      pieces.get(j.name).push(r);
      onProgress(++done / total, 'carving SDFs');
    }
  }));
  workers.forEach((w) => w.terminate());

  const out = new Map();
  for (const [name, list] of pieces) {
    let nv = 0, ni = 0; for (const r of list) { nv += r.positions.length; ni += r.indices.length; }
    const P = new Float32Array(nv), N = new Float32Array(nv), I = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const r of list) {
      P.set(r.positions, ov); N.set(r.normals, ov);
      const base = ov / 3; for (let t = 0; t < r.indices.length; t++) I[oi + t] = r.indices[t] + base;
      ov += r.positions.length; oi += r.indices.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setIndex(new THREE.BufferAttribute(I, 1));
    g.computeBoundingBox(); g.computeBoundingSphere();
    g.name = name;
    out.set(name, g);
  }
  return out;
}
