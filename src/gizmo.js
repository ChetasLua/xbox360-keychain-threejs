// SPDX-License-Identifier: MIT
//
// Womp-style transform gizmo, drawn on a 2D canvas stacked over the WebGL canvas.
// Port of x360-3d-film/tools/overlay.py (look) + film.py bake_and_project (box selection):
//
//   * one name   -> that object's own oriented local bounding box (Blender `bound_box`, children excluded)
//   * >1 names   -> the union AABB of every visible object's oriented box, axis-aligned in MODEL space
//                   (Blender world == our model space == `S.root` local space)
//
// Corners use Blender's bound_box order so the edge/face tables (and the "right-most vertical edge"
// choice for the resize glyph) are identical to overlay.py:
//
//        index : (x, y, z)  with 0 = min, 1 = max along each local axis
//          0   : (0,0,0)    4 : (1,0,0)
//          1   : (0,0,1)    5 : (1,0,1)
//          2   : (0,1,1)    6 : (1,1,1)
//          3   : (0,1,0)    7 : (1,1,0)
//
// Pixel metrics are the film's (authored for a 1440x1080 frame) and are multiplied by the canvas
// backing-store ratio (canvas.width / CSS width), so lines stay crisp and the same CSS size at any DPR.
// `gizmo.uiScale` is an extra multiplier if a host wants the gizmo larger/smaller.

import * as THREE from 'three';

const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
// local-Z ("vertical") edges, candidates for the resize glyph
const VERT = [[0, 1], [3, 2], [4, 5], [7, 6]];
const ORDER = [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0], [1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]];

const FACE_RGB = '60,120,255';
const LINE_RGB = '120,170,255';
const INK_RGB = '40,60,110';

// scratch objects (no per-frame allocation in the hot path)
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _rootInv = new THREE.Matrix4();
const _box = new THREE.Box3();
const _lo = new THREE.Vector3();
const _hi = new THREE.Vector3();

/** True when the object and all of its ancestors are visible. */
function isShown(obj) {
  for (let o = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Geometry-local bounding box of one object (Blender bound_box: own mesh only). */
function localBox(obj, out) {
  const g = obj.geometry;
  if (g) {
    if (!g.boundingBox) g.computeBoundingBox();
    return out.copy(g.boundingBox);
  }
  // Group / empty: union of descendants expressed in this object's local frame
  out.makeEmpty();
  const inv = _m.copy(obj.matrixWorld).invert();
  const tmp = new THREE.Box3();
  obj.traverse((c) => {
    if (c === obj || !c.geometry) return;
    if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
    tmp.copy(c.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld));
    out.union(tmp);
  });
  return out;
}

/** 8 corners (Blender order) of box `b`, transformed by `mat`, written into `out` (Vector3[8]). */
function corners(b, mat, out) {
  for (let i = 0; i < 8; i++) {
    const [a, c, d] = ORDER[i];
    out[i].set(a ? b.max.x : b.min.x, c ? b.max.y : b.min.y, d ? b.max.z : b.min.z).applyMatrix4(mat);
  }
  return out;
}

/** Andrew's monotone chain convex hull of 2D points [[x,y],...] -> hull in CCW order. */
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

export class Gizmo {
  /** @param {HTMLCanvasElement} canvas 2D overlay canvas, stacked over the WebGL canvas. */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.uiScale = 1;
    this._world = Array.from({ length: 8 }, () => new THREE.Vector3());
  }

  /** Look up a part by film name: S.parts first, then by object name in the scene. */
  _find(S, name) {
    return (S.parts && S.parts[name]) || (S.scene && S.scene.getObjectByName(name)) || null;
  }

  /**
   * Compute the boxes for this frame (exported for tests / capture tooling).
   * @returns {Array<{c: Array<[x,y,viewDepth]>, m: [x,y]}>} pixel-space corners (Blender order) + centre
   */
  boxes(camera, S, names, w, h) {
    const out = [];
    if (!names || !names.length) return out;
    camera.updateMatrixWorld();
    const list = names.map((n) => this._find(S, n)).filter((o) => o && isShown(o));
    if (!list.length) return out;

    const W = this._world;
    if (names.length > 1) {
      // union AABB in model space (root-local), film.py bake_and_project
      const root = S.root || null;
      if (root) _rootInv.copy(root.matrixWorld).invert(); else _rootInv.identity();
      _lo.set(Infinity, Infinity, Infinity); _hi.set(-Infinity, -Infinity, -Infinity);
      for (const o of list) {
        localBox(o, _box);
        if (_box.isEmpty()) continue;
        corners(_box, _m.multiplyMatrices(_rootInv, o.matrixWorld), W);
        for (const p of W) { _lo.min(p); _hi.max(p); }
      }
      if (!isFinite(_lo.x)) return out;
      _box.set(_lo, _hi);
      const toWorld = root ? root.matrixWorld : _m.identity();
      out.push(this._project(camera, _box, toWorld, w, h));
    } else {
      const o = list[0];
      localBox(o, _box);
      if (!_box.isEmpty()) out.push(this._project(camera, _box, o.matrixWorld, w, h));
    }
    return out.filter(Boolean);
  }

  _project(camera, box, mat, w, h) {
    const W = corners(box, mat, this._world);
    const c = [];
    for (const p of W) {
      // behind-camera test in view space (Blender: camera-view z <= 0)
      _v.copy(p).applyMatrix4(camera.matrixWorldInverse);
      const depth = -_v.z;
      if (depth <= (camera.near || 1e-4)) return null;
      _v.copy(p).project(camera);
      c.push([(_v.x + 1) * 0.5 * w, (1 - _v.y) * 0.5 * h, depth]);
    }
    box.getCenter(_v).applyMatrix4(mat).project(camera);
    return { c, m: [(_v.x + 1) * 0.5 * w, (1 - _v.y) * 0.5 * h] };
  }

  /**
   * Clear the overlay and draw this frame's gizmo.
   * @param {THREE.Camera} camera
   * @param {object} S          scene bundle from buildScene (uses S.parts, S.root, S.scene)
   * @param {{names:string[], alpha:number}} gizmoState  from timeline.applyFrame(...).gizmo
   * @param {number} w,h        canvas backing-store size in pixels
   */
  draw(camera, S, gizmoState, w, h) {
    const cv = this.canvas, ctx = this.ctx;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const a = gizmoState ? +gizmoState.alpha || 0 : 0;
    if (a <= 0.01 || !gizmoState.names || !gizmoState.names.length) return;

    const cssW = cv.clientWidth || w;
    const k = (w / cssW) * this.uiScale; // backing pixels per CSS pixel
    for (const b of this.boxes(camera, S, gizmoState.names, w, h)) this._drawBox(ctx, b, a, k);
  }

  _drawBox(ctx, b, a, k) {
    const P = b.c;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // faces: overlay.py paints each face with replace semantics, so overlaps never darken;
    // the visual result is one uniform fill over the silhouette = convex hull of the 8 corners.
    const hl = hull(P.map((p) => [p[0], p[1]]));
    ctx.beginPath();
    hl.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = `rgba(${FACE_RGB},${0.063 * a})`;
    ctx.fill();

    // edges
    ctx.beginPath();
    for (const [i, j] of EDGES) { ctx.moveTo(P[i][0], P[i][1]); ctx.lineTo(P[j][0], P[j][1]); }
    ctx.strokeStyle = `rgba(${LINE_RGB},${0.92 * a})`;
    ctx.lineWidth = 1.6 * k;
    ctx.stroke();

    // corner handles: white 7.2 px squares, blue 1 px outline (snapped to the pixel grid for crispness)
    const hs = 3.6 * k;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.strokeStyle = `rgba(${LINE_RGB},${a})`;
    ctx.lineWidth = Math.max(1, k);
    for (const [x, y] of P) {
      const x0 = Math.round(x - hs) + 0.5, y0 = Math.round(y - hs) + 0.5, s = Math.round(2 * hs);
      ctx.fillRect(x0, y0, s, s);
      ctx.strokeRect(x0, y0, s, s);
    }

    // resize glyph (<->) at the mid of the right-most local-Z edge
    let best = VERT[0], bx = -Infinity;
    for (const e of VERT) { const sx = P[e[0]][0] + P[e[1]][0]; if (sx > bx) { bx = sx; best = e; } }
    const mx = (P[best[0]][0] + P[best[1]][0]) / 2, my = (P[best[0]][1] + P[best[1]][1]) / 2;
    const s = 7 * k, white = `rgba(255,255,255,${a})`;
    ctx.strokeStyle = white;
    ctx.fillStyle = white;
    ctx.lineWidth = 1.4 * k;
    ctx.beginPath(); ctx.moveTo(mx - s, my); ctx.lineTo(mx + s, my); ctx.stroke();
    for (const sg of [-1, 1]) {
      const tip = mx + sg * s;
      ctx.beginPath();
      ctx.moveTo(tip + sg * 2.5 * k, my);
      ctx.lineTo(tip - sg * 2 * k, my - 3 * k);
      ctx.lineTo(tip - sg * 2 * k, my + 3 * k);
      ctx.closePath(); ctx.fill();
    }

    // move glyph: white diamond with 4 dark-navy arrowheads at the projected centre
    const [cx, cy] = b.m, r = 11 * k, ink = `rgba(${INK_RGB},${a})`;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${0.92 * a})`;
    ctx.fill();
    ctx.strokeStyle = ink; ctx.lineWidth = 0.75 * k; ctx.stroke();
    const q = r * 0.55, kk = r * 0.22;
    ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineWidth = 1.2 * k;
    for (let ang = 0; ang < 4; ang++) {
      const ca = Math.round(Math.cos(ang * Math.PI / 2)), sa = Math.round(Math.sin(ang * Math.PI / 2));
      const tx = cx + ca * q, ty = cy + sa * q;
      ctx.beginPath();
      ctx.moveTo(tx + ca * kk, ty + sa * kk);
      ctx.lineTo(tx - sa * kk - ca * kk * 0.3, ty + ca * kk - sa * kk * 0.3);
      ctx.lineTo(tx + sa * kk - ca * kk * 0.3, ty - ca * kk - sa * kk * 0.3);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke();
    }
    ctx.restore();
  }
}
