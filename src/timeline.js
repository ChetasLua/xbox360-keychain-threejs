// SPDX-License-Identifier: MIT
//
// timeline.js — the film's animation state machine.
//
// A faithful port of `set_state(f)` from the Blender build script (x360-3d-film/tools/film.py).
// `applyFrame(f, S)` takes a *float* frame (0 <= f < 390 at 30 fps) and poses the scene built by scene.js:
// visibility, drop/pop springs, carve cutters, the ring-of-light boot, the copper -> steel chain, the final
// turntable spin with palette swaps, and the camera / gizmo for that instant.
//
// Every curve here is continuous in f, so the film plays smoothly at 60/120 fps; at integer frames the
// output is identical to film.py (tools/test-timeline.mjs cross-checks that against a Python evaluation).
// The ring-of-light boot spin is intentionally stepped (it is a 2-frame "chase" in the original).
//
// All coordinates are model space (cm, X right, Z up, front face toward -Y). Part transforms are relative to
// `S.rig` (scene.js stores each part's rest pose in `obj.userData.base`). The rig itself is unrotated except
// during the turntable shot, so drop() offsets expressed along model axes equal rig-local offsets.
//
// Contract notes (see CONTRACTS.md):
//   * `shot` in the returned state is the 0-based shot index (film.py `si`): 0 = blob ... 9 = turntable.
//   * Ring levels: film.py emission strengths are divided by 3.0 and clamped to 0..1 before S.setRing().
//   * Cutters: film.py places them in world/model space; we convert to rig-local by subtracting
//     S.rig.position (the rig is unrotated during shot 2), so the world result matches film.py exactly.
//   * The rig uses Euler order 'ZYX' (three.js) == Blender 'XYZ', so the pendulum tilt (X) is applied
//     before the spin (Z), exactly as in Blender.

import { faceY } from './layout.js';

// ------------------------------------------------------------------ easing (film.py, verbatim)
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lin = (f, a, b) => clamp((f - a) / Math.max(b - a, 1e-6));
export const ease = (t) => t * t * (3 - 2 * t);
export const eio = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
export const eout = (t) => 1 - (1 - t) ** 3;
/** Damped spring step response, 0 -> 1 with overshoot; flat 1 after t >= 1.4 (as in film.py). */
export function spring(t, w = 13.0, z = 0.32) {
  if (t <= 0) return 0;
  if (t >= 1.4) return 1;
  return 1 - Math.exp(-z * w * t) * Math.cos(w * Math.sqrt(1 - z * z) * t);
}
const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

// ------------------------------------------------------------------ shot table
// [start, end, cam0, cam1, target0, target1, lens(mm), fstop]  — model space, matches film.py SHOTS.
export const SHOTS = [
  [0, 30, [-24, -48, 17], [-17, -41, 12], [0, 0, -1.6], [0, 0, -1.4], 70, 8.0],                       // 1 blob
  [30, 60, [-11, -33, 11], [-5, -30, 8.5], [-0.5, -1, 0.0], [0, -1, 0.0], 70, 6.0],                   // 2 carve
  [60, 90, [-9.6, -13.6, 7.6], [-8.4, -12.6, 6.4], [-4.45, -2.3, 1.25], [-4.45, -2.3, 1.2], 90, 2.4], // 3 left stick
  [90, 120, [-6.8, -12.5, -6.4], [-5.6, -11.8, -5.0], [-2.25, -1.9, -1.55], [-2.25, -1.9, -1.5], 95, 2.4], // 4 d-pad
  [120, 165, [7.0, -15.5, 7.4], [11.0, -14.2, 4.6], [4.45, -1.45, 1.35], [4.45, -1.45, 1.15], 95, 3.2], // 5 ABXY
  [165, 210, [-1.8, -13.2, 5.8], [1.6, -12.4, 5.0], [0, -1.6, 1.85], [0, -1.6, 1.95], 100, 3.0],      // 6 guide
  [210, 240, [7.5, -35, 9.0], [-6.0, -33, 6.5], [0, -0.6, 0.2], [0, -0.6, 0.0], 70, 5.6],             // 7 front pass
  [240, 270, [-24, 29, 10], [-16, 33, 4.5], [0, 1.4, -1.2], [0, 1.4, -1.0], 70, 5.6],                 // 8 rear battery
  [270, 300, [-5.5, -27, 7.0], [-3.5, -25.5, 8.6], [0, -0.2, 6.0], [0, -0.2, 6.7], 80, 5.6],          // 9 chain
  [300, 390, [0, -54, 2.2], [0, -48.5, 1.6], [0, -0.15, 1.4], [0, -0.15, 1.2], 70, 11.0],             // 10 turntable
];

/** Index of the shot containing frame f (last shot for f past the end). */
export function shotOf(f) {
  for (let i = 0; i < SHOTS.length; i++) if (SHOTS[i][0] <= f && f < SHOTS[i][1]) return i;
  return SHOTS.length - 1;
}

// Carve cutters, in the same order film.py creates them (the order sets each cutter's stagger).
// scene.js builds S.cutters in this order too: lstick, rstick, dpad, guide, back, start, Y, A, X, B.

// Palette swap thresholds during the spin (degrees of accumulated rotation; edge-on angles).
const PAL_STEPS = [[90, 'black'], [270, 'red'], [450, 'blue'], [630, 'white']];

// ------------------------------------------------------------------ transform helpers (three.js or plain objects)
function setV(dst, x, y, z) {
  if (typeof dst.set === 'function') dst.set(x, y, z); else { dst.x = x; dst.y = y; dst.z = z; }
}
function copyV(dst, src) {
  if (!src) return;
  setV(dst, src.x, src.y, src.z);
  if (src.order !== undefined && dst.order !== undefined) dst.order = src.order;
}
/** film.py reset(): restore the part's rest transform from userData.base. */
function reset(o) {
  const b = o.userData && o.userData.base;
  if (!b) return;
  copyV(o.position, b.position);
  copyV(o.rotation, b.rotation);
  copyV(o.scale, b.scale);
}
const show = (o, vis) => { o.visible = vis; }; // three.js hides children with their parent

/** Appear at f0 displaced by `dist` along `axis`, spring into the rest pose. */
function drop(o, f, f0, dur = 14, dist = 3.2, axis = [0, -1, 0]) {
  if (!o) return 0;
  reset(o);
  if (f < f0) { show(o, false); return 0; }
  show(o, true);
  const t = (f - f0) / dur;
  const e = t > 0 ? spring(t, 11.0, 0.42) : 0;
  const off = (1 - e) * dist;
  const p = o.userData.base.position;
  setV(o.position, p.x + axis[0] * off, p.y + axis[1] * off, p.z + axis[2] * off);
  return clamp(t);
}

/** Appear at f0 by scaling up from (almost) zero with a springy overshoot. */
function pop(o, f, f0, dur = 12) {
  if (!o) return 0;
  reset(o);
  if (f < f0) { show(o, false); return 0; }
  show(o, true);
  const t = (f - f0) / dur;
  const s = Math.max(spring(t, 12.0, 0.35), 0.001);
  const b = o.userData.base.scale;
  setV(o.scale, b.x * s, b.y * s, b.z * s);
  return clamp(t);
}

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ------------------------------------------------------------------ main entry
/**
 * Pose the scene for (float) frame f.
 * @param {number} f  frame, 0 <= f < 390 (30 fps)
 * @param {object} S  scene handle from scene.js (parts, cutters, rig, setPalette, setRing, setChainMix, setBackLight)
 * @returns {{shot:number, camera:{pos:number[], target:number[], lens:number, fstop:number, focus:number},
 *            gizmo:{names:string[], alpha:number}}}
 */
export function applyFrame(f, S) {
  const P = S.parts;
  const si = shotOf(f);
  const s = SHOTS[si];
  const t = lin(f, s[0], s[1] - 1);
  const te = si !== 9 ? eio(t) : ease(t);
  const pos = lerp3(s[2], s[3], te);
  const target = lerp3(s[4], s[5], te);
  const focus = Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
  const camera = { pos, target, lens: s[6], fstop: s[7], focus };

  // gizmo: like film.py's GIZ dict, the last assignment in a frame wins
  let gizmo = { names: [], alpha: 0 };
  const giz = (names, alpha) => { gizmo = { names, alpha }; };

  // lights: the rear key only burns in the battery shot (scene.js also dims the front rig to 0.55)
  S.setBackLight(si === 7);

  // --- body: blank blob springs in, carved shell swaps in at f 44
  const b = P.body, bb = P.body_blank;
  reset(b); reset(bb);
  const carved = f >= 44;
  show(b, carved); show(bb, !carved);
  if (f < 26) {
    const tt = (f + 5) / 24.0;
    const sy = spring(tt, 9.0, 0.45), sxz = spring(tt * 1.15, 9.0, 0.5);
    const x = Math.max(sxz, 0.01), y = Math.max(sy, 0.01);
    setV(b.scale, x, y, x); setV(bb.scale, x, y, x);
    giz(['body_blank'], 1.0);
  } else if (f < 30) giz(['body_blank'], 1 - lin(f, 26, 30));

  // --- carve cutters: plunge into the face, then pull out the front
  const rp = S.rig.position;
  (S.cutters || []).forEach((c, i) => {
    const o = c.obj;
    const st = 33 + (i % 5);
    if (f < st || f >= 58) { show(o, false); return; }
    show(o, true);
    const yf = faceY(c.cx, c.cz);
    const tin = eout(lin(f, st, st + 10)), tout = ease(lin(f, 48, 57));
    const y = yf - 2.4 + 2.2 * tin - 2.6 * tout;
    setV(o.position, c.cx - rp.x, y - rp.y, c.cz - rp.z); // model -> rig-local (rig unrotated here)
    setV(o.scale, 1, 1, 1);
  });
  if (f >= 33 && f < 58) giz([], 0);

  // --- face parts
  drop(P.lstick, f, 64, 16, 3.4);
  if (f >= 60 && f < 90) giz(['lstick'], 1 - lin(f, 82, 89));
  drop(P.dpad, f, 94, 16, 3.0);
  if (f >= 90 && f < 120) giz(['dpad'], 1 - lin(f, 112, 119));
  const order = [['gemY', 124], ['gemX', 131], ['gemB', 138], ['gemA', 145]];
  for (const [k, f0] of order) drop(P[k], f, f0, 13, 2.4);
  if (f >= 120 && f < 165) {
    const cur = order.filter(([, f0]) => f >= f0).map(([k]) => k);
    giz(cur.slice(-1), 1 - lin(f, 156, 164));
  }

  // guide: bezel + ring pop first, then the chrome button drops in
  for (const k of ['bezel', 'ringq0', 'ringq1', 'ringq2', 'ringq3']) pop(P[k], f, 168, 12);
  drop(P.guide, f, 175, 14, 2.6);
  if (f >= 165 && f < 210) giz(f >= 175 ? ['guide'] : ['bezel'], 1 - lin(f, 198, 206));

  // ring of light boot: two chase laps, all-on flash, settle on player 1 (film.py strengths / 3)
  let lv;
  if (f < 186) lv = [0, 0, 0, 0];
  else if (f < 200) {
    const k = Math.floor((f - 186) / 2) % 4; // stepped 2-frame chase, like the original
    lv = [0, 0, 0, 0]; lv[k] = 3.0; lv[(k + 3) % 4] = 0.8;
  } else if (f < 204) lv = [2.2, 2.2, 2.2, 2.2];
  else lv = [2.8, 0, 0, 0];
  S.setRing(lv.map((v) => clamp(v / 3.0)));

  drop(P.back, f, 214, 12, 2.0); drop(P.start, f, 217, 12, 2.0);
  drop(P.rstick, f, 221, 14, 3.2);
  drop(P.bumperL, f, 226, 12, 2.4, [0, 0, 1]); drop(P.bumperR, f, 229, 12, 2.4, [0, 0, 1]);
  if (f >= 210 && f < 240) giz(f >= 221 ? ['rstick'] : ['back', 'start'], 1 - lin(f, 233, 239));

  drop(P.battery, f, 245, 16, 3.5, [0, 1, 0]);
  drop(P.triggerL, f, 252, 12, 2.0, [0, 0.6, 0.8]); drop(P.triggerR, f, 254, 12, 2.0, [0, 0.6, 0.8]);
  if (f >= 240 && f < 270) giz(['battery'], 1 - lin(f, 262, 269));

  // keychain hardware
  pop(P.eyelet, f, 272, 10);
  drop(P.jumpring, f, 277, 10, 1.2, [0, 0, 1]);
  const links = [];
  for (let i = 0; i < 6; i++) { links.push('link' + i); drop(P['link' + i], f, 281 + i * 2, 9, 0.9, [0, 0, 1]); }
  drop(P.splitring, f, 293, 12, 1.6, [0, 0, 1]);
  if (f >= 270 && f < 300) {
    if (f < 277) giz(['eyelet'], 1);
    else if (f < 293) giz(['jumpring', ...links], 1);
    else giz(['splitring'], 1 - lin(f, 296, 299));
  }

  // chain metal: copper -> steel during shot 9
  S.setChainMix(ease(lin(f, 286, 298)));

  // --- turntable: two eased laps, palette swaps while edge-on, damped pendulum sway
  const rig = S.rig;
  if (rig.rotation.order !== undefined) rig.rotation.order = 'ZYX'; // == Blender 'XYZ'
  setV(rig.rotation, 0, 0, 0);
  let pal = 'white';
  if (f >= 300) {
    const tt = lin(f, 302, 384);
    const ang = eio(tt) * 2 * TAU;
    const deg = ang / RAD;
    for (const [thr, pn] of PAL_STEPS) if (deg >= thr) pal = pn;
    setV(rig.rotation, 1.2 * RAD * Math.sin(f * 0.21) * (1 - tt), 0, ang);
  }
  S.setPalette(pal);

  return { shot: si, camera, gizmo };
}
