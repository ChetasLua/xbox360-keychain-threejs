// SPDX-License-Identifier: MIT
// build.js — meshes every SDF part in a worker pool and returns three.js BufferGeometries (model space, cm).
import * as THREE from 'three';
import { PARTS, NEEDS_OUTLINE } from './sdf.js';
import { gridNZ } from './mesh.js';

const SLAB = +(new URLSearchParams(location.search).get("slab") || 22); // z layers per slab job for the big parts

export async function buildAllGeometry({ onProgress = () => {} } = {}) {
  const n = Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 8));
  const workers = Array.from({ length: n }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
  let nextId = 1; const waiting = new Map();
  for (const w of workers) w.onmessage = (e) => { const cb = waiting.get(e.data.id); waiting.delete(e.data.id); cb(e.data); };
  const call = (w, msg, transfer) => new Promise((res, rej) => {
    const id = nextId++; waiting.set(id, (d) => (d.error ? rej(new Error(d.error)) : res(d))); w.postMessage({ ...msg, id }, transfer || []);
  });

  onProgress(0, 'tracing the outline');
  const { outline } = await call(workers[0], { type: 'outline' });

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
