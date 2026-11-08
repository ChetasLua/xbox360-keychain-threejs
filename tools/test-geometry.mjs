// node tools/test-geometry.mjs [part ...] — meshes parts single-threaded, prints counts/bboxes/timing, writes OBJ to out/geo
import { PARTS, initOutline } from '../src/geometry/sdf.js';
import { polygonize } from '../src/geometry/mesh.js';
import fs from 'node:fs';
let t = performance.now(); initOutline(); console.log('outline', Math.round(performance.now() - t), 'ms');
fs.mkdirSync('out/geo', { recursive: true });
let tot = 0;
for (const name of (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PARTS))) {
  const p = PARTS[name]; t = performance.now();
  const r = polygonize(p.fn, p.lo, p.hi, p.h); const ms = performance.now() - t; tot += ms;
  const P = r.positions, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); }
  console.log(name.padEnd(11), String(r.indices.length / 3).padStart(8), 'tris', Math.round(ms).toString().padStart(6), 'ms  bbox', lo.map(v => v.toFixed(2)).join(','), '→', hi.map(v => v.toFixed(2)).join(','));
  if (process.env.OBJ) { let s = ''; for (let i = 0; i < P.length; i += 3) s += `v ${P[i]} ${P[i+1]} ${P[i+2]}\n`; for (let i = 0; i < r.indices.length; i += 3) s += `f ${r.indices[i]+1} ${r.indices[i+1]+1} ${r.indices[i+2]+1}\n`; fs.writeFileSync(`out/geo/${name}.obj`, s); }
}
console.log('total single-thread', Math.round(tot), 'ms');
