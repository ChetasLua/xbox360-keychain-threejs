// SPDX-License-Identifier: MIT
// Module worker: meshes one SDF part (or one Z slab of it) and transfers the buffers back.
// Modules are imported with the worker's own ?v= query, so a worker can never pair a fresh page with stale cached code.
const V = self.location.search;
const ready = Promise.all([import('./sdf.js' + V), import('./mesh.js' + V)]);

self.onmessage = async (e) => {
  const m = e.data;
  try {
    const [{ PARTS, initOutline, setOutline }, { polygonize }] = await ready;
    if (m.type === 'outline') { const buf = initOutline(m.j0, m.j1); self.postMessage({ id: m.id, rows: buf }, [buf.buffer]); return; }
    if (m.outline) setOutline(m.outline);
    const p = PARTS[m.name];
    const r = polygonize(p.fn, p.lo, p.hi, p.h, m.k0 ?? 0, m.k1 ?? Infinity);
    self.postMessage({ id: m.id, ...r }, [r.positions.buffer, r.normals.buffer, r.indices.buffer]);
  } catch (err) { self.postMessage({ id: m.id, error: String(err && err.stack || err) }); }
};
