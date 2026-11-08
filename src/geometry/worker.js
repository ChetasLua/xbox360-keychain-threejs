// SPDX-License-Identifier: MIT
// Module worker: meshes one SDF part (or one Z slab of it) and transfers the buffers back.
import { PARTS, initOutline, setOutline } from './sdf.js';
import { polygonize } from './mesh.js';

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'outline') { const buf = initOutline(); self.postMessage({ id: m.id, outline: buf.slice() }); return; }
    if (m.outline) setOutline(m.outline);
    const p = PARTS[m.name];
    const r = polygonize(p.fn, p.lo, p.hi, p.h, m.k0 ?? 0, m.k1 ?? Infinity);
    self.postMessage({ id: m.id, ...r }, [r.positions.buffer, r.normals.buffer, r.indices.buffer]);
  } catch (err) { self.postMessage({ id: m.id, error: String(err && err.stack || err) }); }
};
