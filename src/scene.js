// SPDX-License-Identifier: MIT
// scene.js — places the SDF parts, builds materials, studio lighting and the environment.
// Everything lives under `root` (rotated so model space X right / Z up / front -Y maps onto three's Y-up world)
// and under `rig` (the keychain pivot that spins in the turntable shot).
import * as THREE from 'three';
import { POS, ABXY_OFF, faceY } from './layout.js';

const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

export const PALETTES = {
  white: { body: [0.74, 0.74, 0.71], grey: [0.075, 0.077, 0.08], dpad: [0.22, 0.225, 0.23], trig: [0.55, 0.55, 0.53], bumper: [0.30, 0.31, 0.31] },
  black: { body: [0.018, 0.018, 0.02], grey: [0.035, 0.035, 0.04], dpad: [0.05, 0.05, 0.055], trig: [0.03, 0.03, 0.033], bumper: [0.035, 0.035, 0.04] },
  red: { body: [0.42, 0.012, 0.01], grey: [0.03, 0.03, 0.033], dpad: [0.05, 0.05, 0.055], trig: [0.03, 0.03, 0.033], bumper: [0.03, 0.03, 0.033] },
  blue: { body: [0.03, 0.14, 0.55], grey: [0.70, 0.71, 0.72], dpad: [0.75, 0.76, 0.77], trig: [0.70, 0.71, 0.72], bumper: [0.70, 0.71, 0.72] },
};

// ---------------------------------------------------------------- micro-texture: object-space noise bump (no UVs needed)
const NOISE_GLSL = /* glsl */`
varying vec3 vObjPos; varying vec3 vAx; varying vec3 vAy; varying vec3 vAz;
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h3(i), h3(i+vec3(1,0,0)), f.x), mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), f.x), mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), f.x), f.y), f.z); }
float grain(vec3 p){ return vnoise(p) * 0.6 + vnoise(p * 2.13 + 7.1) * 0.3 + vnoise(p * 0.12) * 0.25; }
`;
/**
 * Surface micro-detail injected into MeshPhysicalMaterial (object space, so it needs no UVs):
 *  - bump: fine moulding grain (or concentric machining rings when o.brushed) perturbing the normal
 *  - smudge: soft fingerprint-like patches that raise roughness on glossy parts
 *  - grip: matte texture on the controller grips (body only)
 *  - tone: ±2% albedo variation so large plastic areas never look CG-flat
 */
function microBump(mat, scale, strength, o = {}) {
  const U = { uBumpScale: scale, uBumpStr: strength, uBrushed: o.brushed ? 1 : 0, uSmudge: o.smudge ?? 0.0, uGrip: o.grip ?? 0, uTone: o.tone ?? 0.02 };
  mat.onBeforeCompile = (sh) => {
    for (const [k, v] of Object.entries(U)) sh.uniforms[k] = { value: v };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vObjPos; varying vec3 vAx; varying vec3 vAy; varying vec3 vAz;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position; vAx = normalMatrix * vec3(1.0,0.0,0.0); vAy = normalMatrix * vec3(0.0,1.0,0.0); vAz = normalMatrix * vec3(0.0,0.0,1.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBumpScale, uBumpStr, uBrushed, uSmudge, uGrip, uTone;\n' + NOISE_GLSL + `
        float surf(vec3 p) {
          if (uBrushed > 0.5) { float r = length(p.xz); return 0.5 + 0.35 * sin(r * 6.2831) + 0.15 * vnoise(vec3(r * 3.0, p.y, 0.0)); }
          return grain(p);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 1.0 + uTone * (vnoise(vObjPos * 1.7) - 0.5) * 2.0;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float sm = smoothstep(0.62, 0.86, vnoise(vObjPos * 0.65 + 3.1)) * (0.55 + 0.45 * vnoise(vObjPos * vec3(22.0, 22.0, 6.0)));
          float grip = uGrip * smoothstep(-1.2, -3.0, vObjPos.z) * smoothstep(2.2, 3.8, abs(vObjPos.x));
          roughnessFactor = clamp(roughnessFactor + uSmudge * sm + 0.22 * grip, 0.02, 1.0); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { vec3 p = vObjPos * uBumpScale; float e = 0.35;
        float n0 = surf(p);
        vec3 g = vec3(surf(p + vec3(e,0,0)) - n0, surf(p + vec3(0,e,0)) - n0, surf(p + vec3(0,0,e)) - n0) / e;
        float gripB = 1.0 + 2.5 * uGrip * smoothstep(-1.2, -3.0, vObjPos.z) * smoothstep(2.2, 3.8, abs(vObjPos.x));
        vec3 gv = g.x * vAx + g.y * vAy + g.z * vAz;                    // object-space gradient -> view space
        normal = normalize(normal - uBumpStr * gripB * (gv - dot(gv, normal) * normal)); }`);
  };
  mat.customProgramCacheKey = () => 'mb' + JSON.stringify(U);
  return mat;
}

const plastic = (rgb, rough, o = {}) => microBump(new THREE.MeshPhysicalMaterial({
  color: lin(...rgb), roughness: rough, metalness: 0, clearcoat: o.coat ?? 0, clearcoatRoughness: 0.12,
  specularIntensity: o.spec ?? 0.55, sheen: 0, envMapIntensity: o.env ?? 1,
}), o.bscale ?? 90, o.bump ?? 0.035, o);
const metal = (rgb, rough, o = {}) => microBump(new THREE.MeshPhysicalMaterial({ color: lin(...rgb), metalness: 1, roughness: rough, envMapIntensity: o.env ?? 1.2 }),
  o.bscale ?? 160, o.bump ?? 0.012, { tone: 0.0, ...o });

// ---------------------------------------------------------------- studio environment (dark room + softboxes)
function studioEnv(renderer) {
  const s = new THREE.Scene(); s.background = new THREE.Color(0x000000);
  const box = (w, h, pos, look, k, tint = [1, 1, 1]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: lin(tint[0] * k, tint[1] * k, tint[2] * k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(...look); s.add(m);
  };
  // positions in three world (Y up); the controller faces +Z
  box(9, 5, [-7, 6, 7], [0, 0, 0], 5.0, [1, 0.97, 0.93]);    // key softbox (upper left front)
  box(12, 9, [9, 0, 6], [0, 0, 0], 1.1, [0.85, 0.9, 1]);      // broad fill (right)
  box(3, 10, [7, 6, -6], [0, 0, 0], 4.0, [0.9, 0.95, 1]);     // rim strip (behind right)
  box(14, 3, [0, 11, 1], [0, 0, 0], 1.6);                     // top strip -> long highlight along the shell
  box(16, 2, [0, -6, 5], [0, 0, 0], 0.25);                    // faint floor bounce
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.02).texture; pm.dispose();
  return tex;
}

function stickerTexture(renderer) {
  const c = document.createElement('canvas'); c.width = 1080; c.height = 620; const g = c.getContext('2d');
  g.fillStyle = '#e9e8e3'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#b9b8b2'; g.lineWidth = 4; g.strokeRect(14, 14, c.width - 28, c.height - 28);
  g.fillStyle = '#2a2a2a'; g.font = '700 46px ui-sans-serif, Helvetica, Arial'; g.fillText('WIRELESS CONTROLLER', 52, 92);
  g.font = '500 30px ui-sans-serif, Helvetica, Arial'; g.fillStyle = '#4a4a4a';
  g.fillText('AA BATTERY PACK  ·  1.5V ⎓ ×2', 52, 140); g.fillText('MODEL 360-KC  ·  BUILT IN three.js', 52, 182);
  // barcode (deterministic pseudo-random bars)
  let x = 52, seed = 360; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#111';
  while (x < 700) { const w = 3 + Math.floor(rnd() * 4) * 3; if (rnd() > 0.42) g.fillRect(x, 230, w, 190); x += w + 3; }
  g.font = '500 30px ui-monospace, Menlo, monospace'; g.fillText('S/N 0360 2005 1122 0001', 60, 470);
  // generic symbols: battery outline + "do not dispose" bin + recycle loop
  g.lineWidth = 6; g.strokeStyle = '#2a2a2a';
  g.strokeRect(770, 240, 120, 60); g.fillStyle = '#2a2a2a'; g.fillRect(890, 258, 14, 24); g.fillRect(782, 252, 46, 36);
  g.beginPath(); g.moveTo(780, 340); g.lineTo(890, 340); g.lineTo(875, 440); g.lineTo(795, 440); g.closePath(); g.stroke();
  g.beginPath(); g.moveTo(770, 320); g.lineTo(900, 460); g.moveTo(900, 320); g.lineTo(770, 460); g.stroke();
  g.beginPath(); g.arc(980, 390, 48, 0.3, Math.PI * 1.8); g.stroke();
  g.font = '500 24px ui-sans-serif, Helvetica, Arial'; g.fillStyle = '#555';
  g.fillText('Insert batteries with correct polarity. Do not mix old and new batteries.', 52, 548);
  g.fillText('Unofficial fan build · not affiliated with Microsoft', 52, 584);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

export function buildScene(renderer, geoms) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.environment = studioEnv(renderer);
  scene.environmentIntensity = 0.7;

  const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);
  const rig = new THREE.Group(); rig.name = 'rig'; rig.position.set(0, -0.15, 0); rig.rotation.order = 'ZYX'; root.add(rig);
  const RP = rig.position.clone();

  // ---------------------------------------------------------------- materials
  const W = PALETTES.white;
  const M = {
    body: plastic(W.body, 0.30, { coat: 0.18, bump: 0.03, bscale: 85, smudge: 0.16, grip: 1 }),
    grey: plastic(W.grey, 0.55, { bump: 0.09, bscale: 140 }),
    dpad: plastic(W.dpad, 0.38, { coat: 0.2, bump: 0.04 }),
    trig: plastic(W.trig, 0.40, { bump: 0.04 }),
    bumper: plastic(W.bumper, 0.36, { coat: 0.1, bump: 0.04 }),
    chrome: metal([0.90, 0.90, 0.91], 0.14, { brushed: true, bscale: 60, bump: 0.035, smudge: 0.08 }),
    silverbtn: metal([0.78, 0.79, 0.80], 0.32),
    bezel: metal([0.80, 0.80, 0.82], 0.12, { brushed: true, bscale: 120, bump: 0.06 }),
    gold: metal([1.0, 0.72, 0.32], 0.22),
    screw: metal([0.22, 0.22, 0.24], 0.35),
    lens: new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, thickness: 0.05, ior: 1.49, roughness: 0.06, clearcoat: 1, transparent: false }),
    logo: new THREE.MeshPhysicalMaterial({ color: lin(0.06, 0.30, 0.03), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 }),
    inkdark: new THREE.MeshPhysicalMaterial({ color: lin(0.02, 0.02, 0.02), roughness: 0.35 }),
    chain: metal([0.93, 0.56, 0.38], 0.16),
  };
  const GEM = { A: [[0.12, 0.85, 0.15], [0.25, 1.0, 0.2]], B: [[0.95, 0.10, 0.08], [1.0, 0.18, 0.12]],
    X: [[0.08, 0.30, 0.95], [0.18, 0.40, 1.0]], Y: [[1.0, 0.80, 0.06], [1.0, 1.0, 0.25]] };
  const LET = { A: [0.55, 1.0, 0.5], B: [1.0, 0.55, 0.5], X: [0.6, 0.75, 1.0], Y: [1.0, 0.95, 0.6] };
  for (const k of 'ABXY') {
    M['gem' + k] = new THREE.MeshPhysicalMaterial({ color: lin(...GEM[k][0].map((c) => c * 0.75)), transmission: 1, thickness: 0.9, ior: 1.5,
      roughness: 0.03, attenuationColor: lin(...GEM[k][1]), attenuationDistance: 0.14, clearcoat: 1, clearcoatRoughness: 0.03, specularIntensity: 1, envMapIntensity: 1.6 });
    M['let' + k] = new THREE.MeshStandardMaterial({ color: lin(...LET[k]), emissive: lin(...LET[k]), emissiveIntensity: 0.25, roughness: 0.3 });
  }
  for (let q = 0; q < 4; q++) M['ring' + q] = new THREE.MeshPhysicalMaterial({ color: lin(0.035, 0.045, 0.035), roughness: 0.25,
    emissive: lin(0.03, 1.0, 0.0), emissiveIntensity: 0, clearcoat: 0.6 });

  // ---------------------------------------------------------------- parts
  const parts = {};
  const mk = (name, geomName, mat, parent = rig) => {
    const m = new THREE.Mesh(geoms.get(geomName), mat); m.name = name;
    m.castShadow = true; m.receiveShadow = true; parent.add(m); parts[name] = m; return m;
  };
  const at = (o, x, y, z) => { o.position.set(x - RP.x, y - RP.y, z - RP.z); return o; }; // model -> rig-local
  at(mk('body', 'body', M.body), 0, 0, 0);
  at(mk('body_blank', 'body_blank', M.body), 0, 0, 0);
  at(mk('eyelet', 'eyelet', M.body), 0, 0, 0);
  for (const key of ['lstick', 'rstick']) { const [cx, cz] = POS[key]; at(mk(key, 'stick', M.grey), cx, faceY(cx, cz), cz); }
  { const [cx, cz] = POS.dpad; at(mk('dpad', 'dpad', M.dpad), cx, faceY(cx, cz), cz); }
  for (const [k, [ox, oz]] of Object.entries(ABXY_OFF)) {
    const cx = POS.abxy[0] + ox, cz = POS.abxy[1] + oz;
    const g = at(mk('gem' + k, 'gem', M['gem' + k]), cx, faceY(cx, cz), cz);
    const l = mk('let' + k, 'let' + k, M['let' + k], g); l.position.set(0, -0.05, 0); l.scale.setScalar(0.72); l.castShadow = false;
  }
  { const [cx, cz] = POS.guide, gy = faceY(cx, cz);
    const g = at(mk('guide', 'guide', M.chrome), cx, gy, cz);
    mk('logo', 'logo', M.logo, g).position.set(0, 0.12, 0);
    mk('logox', 'logox', M.silverbtn, g).position.set(0, 0.12, 0);
    at(mk('bezel', 'bezel', M.bezel), cx, gy, cz);
    for (let q = 0; q < 4; q++) at(mk('ringq' + q, 'ringq' + q, M['ring' + q]), cx, gy, cz); }
  for (const [key, tri] of [['back', 'triL'], ['start', 'triR']]) {
    const [cx, cz] = POS[key];
    const b = at(mk(key, 'smallbtn', M.silverbtn), cx, faceY(cx, cz), cz);
    mk('tri_' + key, tri, M.inkdark, b).position.set(0, -0.232, 0);
  }
  for (const k of ['bumperL', 'bumperR']) at(mk(k, k, M.bumper), 0, 0, 0);
  // micro parts that ride with the carved shell (children of body, body frame == model frame)
  const body = parts.body;
  mk('ringlens', 'ringlens', M.lens, parts.bezel).castShadow = false;
  mk('syncbtn', 'syncbtn', M.bumper, body).position.set(-1.25, -0.05, 3.27);
  const cupMat = new THREE.MeshStandardMaterial({ color: lin(0.012, 0.012, 0.014), roughness: 0.7 });
  for (const [ox, oz] of Object.values(ABXY_OFF)) { const cx = POS.abxy[0] + ox, cz = POS.abxy[1] + oz; mk('cup', 'cup', cupMat, body).position.set(cx, faceY(cx, cz), cz); }
  mk('pins', 'pins', M.gold, body).position.set(0, 0.1, 3.0);
  for (const sx of [-2.85, 2.85]) mk('screw' + (sx < 0 ? 'L' : 'R'), 'screw', M.screw, body).position.set(sx, 0.64, 1.55);
  for (const k of ['triggerL', 'triggerR']) at(mk(k, k, M.trig), 0, 0, 0);
  at(mk('battery', 'battery', M.body), 0, 0, 0);
  { // procedural compliance sticker on the battery pack (drawn on a canvas at load, no image files)
    const lbl = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 1.55), new THREE.MeshPhysicalMaterial({ map: stickerTexture(renderer), roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4 }));
    lbl.matrixAutoUpdate = true;
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    lbl.quaternion.setFromRotationMatrix(m); lbl.position.set(0, 1.6235, -1.38); lbl.receiveShadow = true;
    parts.battery.add(lbl); parts.label = lbl;
  }
  { const j = at(mk('jumpring', 'jumpring', M.chain), 0, -0.15, 4.05); j.rotation.z = Math.PI / 2; }
  let z = 4.05 + 0.30 + 0.06;
  for (let i = 0; i < 6; i++) {
    z += i === 0 ? 0.36 : 0.50;
    const l = at(mk('link' + i, 'link', M.chain), 0, -0.15, z); l.rotation.z = i % 2 === 0 ? Math.PI / 2 : 0;
  }
  at(mk('splitring', 'splitring', M.chain), 0, -0.15, z + 0.30 + 1.15);

  // carve cutters (shot 2): glassy blue ghosts
  const cutMat = new THREE.MeshPhysicalMaterial({ color: lin(0.35, 0.6, 1.0), emissive: lin(0.2, 0.45, 1.0), emissiveIntensity: 0.35,
    roughness: 0.12, transparent: true, opacity: 0.5, depthWrite: false, clearcoat: 1 });
  const cutters = [];
  const addCut = (cx, cz, r) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.6, 96, 1), cutMat); // axis = local Y = model Y
    m.visible = false; m.renderOrder = 2; rig.add(m); cutters.push({ obj: m, cx, cz });
  };
  for (const [key, r] of [['lstick', 1.13], ['rstick', 1.13], ['dpad', 1.17], ['guide', 1.24], ['back', 0.37], ['start', 0.37]]) addCut(...POS[key], r);
  for (const [ox, oz] of Object.values(ABXY_OFF)) addCut(POS.abxy[0] + ox, POS.abxy[1] + oz, 0.52);

  for (const o of Object.values(parts)) o.userData.base = { position: o.position.clone(), rotation: o.rotation.clone(), scale: o.scale.clone() };

  // ---------------------------------------------------------------- lights (model-space positions, under root)
  const lights = {};
  const dir = (name, pos, intensity, color, shadow) => {
    const l = new THREE.DirectionalLight(color, intensity); l.position.set(...pos); l.target.position.set(0, 0, 0);
    root.add(l); root.add(l.target); lights[name] = l;
    if (shadow) {
      l.castShadow = true; l.shadow.mapSize.set(2048, 2048);
      const c = l.shadow.camera; c.left = -11; c.right = 11; c.top = 11; c.bottom = -11; c.near = 1; c.far = 120;
      l.shadow.bias = -0.0004; l.shadow.normalBias = 0.02; l.shadow.radius = 4;
    }
    return l;
  };
  const base = { key: 2.6, fill: 0.35, rim: 2.2, top: 0.6 };
  dir('key', [-28, -34, 30], base.key, 0xfff6ec, true);
  dir('fill', [36, -30, -6], base.fill, 0xdae6ff);
  dir('rim', [22, 30, 26], base.rim, 0xe6f0ff);
  dir('top', [0, -6, 46], base.top, 0xffffff);
  dir('back', [-26, 40, 18], 0, 0xffffff);

  const S = {
    scene, root, rig, parts, materials: M, cutters, lights,
    setPalette(name) {
      const p = PALETTES[name] || PALETTES.white;
      for (const k of ['body', 'grey', 'dpad', 'trig', 'bumper']) M[k].color.setRGB(...p[k], THREE.LinearSRGBColorSpace);
    },
    setRing(levels) { for (let q = 0; q < 4; q++) M['ring' + q].emissiveIntensity = (levels[q] || 0) * 2.6; },
    setChainMix(t) { M.chain.color.setRGB(0.93 + (0.80 - 0.93) * t, 0.56 + (0.80 - 0.56) * t, 0.38 + (0.82 - 0.38) * t, THREE.LinearSRGBColorSpace); },
    setBackLight(on) {
      lights.back.intensity = on ? 1.3 : 0;
      for (const k of Object.keys(base)) lights[k].intensity = base[k] * (on ? 0.55 : 1);
    },
  };
  return S;
}
