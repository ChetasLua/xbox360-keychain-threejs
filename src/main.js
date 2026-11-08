// SPDX-License-Identifier: MIT
// main.js — boots the film: meshes the SDF parts, builds the scene, synthesises the score, then plays
// in real time locked to the audio clock. `?capture=1` turns it into a deterministic frame renderer
// (window.__renderFrame) used by tools/capture.mjs.
import * as THREE from 'three';
import { FPS, NF, WIDTH, HEIGHT, m2t } from './layout.js';
import { buildAllGeometry } from './geometry/build.js';
import { buildScene } from './scene.js';
import { applyFrame, SHOTS } from './timeline.js';
import { Gizmo } from './gizmo.js';
import { createPost } from './post.js';
import { synthSoundtrack, encodeWavBase64, Player } from './audio.js';
import { UI } from './ui.js';

const Q = new URLSearchParams(location.search);
const CAPTURE = Q.get('capture') === '1';
const DURATION = NF / FPS;
const ui = CAPTURE ? null : new UI();
if (CAPTURE) document.body.classList.add('capture');
const fail = (e) => { console.error(e); window.__ERROR = String(e && e.message || e); ui && ui.showError('Could not start: ' + window.__ERROR); };
window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

const glCanvas = document.getElementById('gl'), gizCanvas = document.getElementById('giz'), accCanvas = document.getElementById('acc');
let W = CAPTURE ? +(Q.get('w') || WIDTH) : 0, H = CAPTURE ? +(Q.get('h') || HEIGHT) : 0;
let DPR = CAPTURE ? 1 : Math.min(devicePixelRatio || 1, 2); // live mode adapts this to hold ~50+ fps

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: CAPTURE });
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r186: PCF is soft (PCFSoft was folded in)
renderer.setPixelRatio(DPR);

const camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.3, 400);
let S, post, gizmo, state;

function frameSize() {
  if (CAPTURE) return [W, H];
  const r = document.getElementById('frame').getBoundingClientRect();
  return [Math.max(2, Math.round(r.width)), Math.max(2, Math.round(r.height))];
}
function resize() {
  const [w, h] = frameSize(); W = w; H = h;
  renderer.setSize(w, h, !CAPTURE ? false : true);
  if (CAPTURE) { glCanvas.style.width = accCanvas.style.width = gizCanvas.style.width = w + 'px'; glCanvas.style.height = accCanvas.style.height = gizCanvas.style.height = h + 'px'; }
  gizCanvas.width = Math.round(w * DPR); gizCanvas.height = Math.round(h * DPR);
  if (post) post.setSize(Math.round(w * DPR), Math.round(h * DPR));
}

/** Pose everything for (float) frame f and aim the camera; returns the timeline state. */
function pose(f, jitter) {
  const st = applyFrame(Math.min(Math.max(f, 0), NF - 1e-3), S);
  const c = st.camera;
  camera.position.set(...m2t(...c.pos));
  camera.up.set(0, 1, 0);
  camera.lookAt(...m2t(...c.target));
  const aspect = W / H, hfov = 2 * Math.atan(18 / c.lens);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect));
  camera.aspect = aspect;
  if (jitter) camera.setViewOffset(W, H, jitter[0], jitter[1], W, H); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  return st;
}
function draw(f, jitter) {
  state = pose(f, jitter);
  post.render(state.camera, f);
  return state;
}
function drawGizmo(f) {
  const st = pose(f); // gizmo always at the exact frame, no jitter
  gizmo.draw(camera, S, st.gizmo, gizCanvas.width, gizCanvas.height);
}

async function boot() {
  const t0 = performance.now();
  resize();
  const geoms = await buildAllGeometry({ onProgress: (p, label) => ui && ui.setProgress(p * 0.85, label) });
  const tGeo = performance.now() - t0;
  ui && ui.setProgress(0.88, 'lighting the studio');
  S = buildScene(renderer, geoms);
  post = createPost(renderer, S.scene, camera, Math.round(W * DPR), Math.round(H * DPR),
    { gtao: Q.get('gtao') !== '0', dof: Q.get('dof') !== '0', bloom: Q.get('bloom') !== '0', lens: Q.get('lens') !== '0' });
  if (Q.get('shadows') === '0') renderer.shadowMap.enabled = false;
  gizmo = new Gizmo(gizCanvas);
  // warm-up: compile every program and touch one frame of each shot so playback never hitches
  for (const s of SHOTS) { draw(s[0] + 2); }
  renderer.compile(S.scene, camera);
  const snd = synthSoundtrack(48000);
  const gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
  window.__INFO = { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown', three: THREE.REVISION,
    geometryMs: Math.round(tGeo), bootMs: Math.round(performance.now() - t0), tris: renderer.info.render.triangles };
  if (CAPTURE) return startCapture(snd);
  return startLive(snd);
}

// ---------------------------------------------------------------- capture: deterministic, supersampled + motion blur
function startCapture(snd) {
  const SPP = Math.max(1, +(Q.get('spp') || 8));
  accCanvas.style.display = 'block'; accCanvas.width = W; accCanvas.height = H;
  const actx = accCanvas.getContext('2d');
  // R2 low-discrepancy jitter
  const jit = (k) => [((0.5 + k * 0.7548776662) % 1 - 0.5), ((0.5 + k * 0.5698402909) % 1 - 0.5)];
  window.__renderFrame = async (n) => {
    actx.globalAlpha = 1; actx.fillStyle = '#000'; actx.fillRect(0, 0, W, H);
    for (let k = 0; k < SPP; k++) {
      const sh = SHOTS.find((s) => n >= s[0] && n < s[1]) || SHOTS[SHOTS.length - 1];
      let sub = SPP > 1 ? n + ((k + 0.5) / SPP - 0.5) * 0.5 : n; // 0.5-frame shutter…
      sub = Math.min(Math.max(sub, sh[0]), sh[1] - 1e-3);       // …that never crosses a cut
      draw(sub, SPP > 1 ? jit(k) : null);
      actx.globalAlpha = 1 / (k + 1);
      actx.drawImage(glCanvas, 0, 0, W, H);
    }
    drawGizmo(n);
    return true;
  };
  window.__exportWav = () => encodeWavBase64(snd);
  window.__READY = true;
}

// ---------------------------------------------------------------- live playback
async function startLive(snd) {
  const player = new Player(snd);
  let playing = false, clock0 = 0, pausedAt = 0, audioOK = true;
  const now = () => {
    if (!playing) return pausedAt;
    if (audioOK) { try { return player.time; } catch { audioOK = false; } }
    return ((performance.now() - clock0) / 1000) % DURATION;
  };
  const play = async (from) => {
    pausedAt = ((from % DURATION) + DURATION) % DURATION;
    clock0 = performance.now() - pausedAt * 1000;
    try { await player.start(pausedAt); audioOK = true; } catch (e) { console.warn('audio unavailable', e); audioOK = false; }
    playing = true;
  };
  const pause = () => { pausedAt = now(); playing = false; try { player.pause(); } catch {} };
  ui.hideLoader();
  draw(0); drawGizmo(0);
  await ui.showStart();
  ui.setMarkers(SHOTS.map((s) => s[0] / NF).slice(1));
  ui.attach({
    duration: DURATION,
    toggle: () => (playing ? pause() : play(pausedAt)),
    seek: (t) => (playing ? play(t) : (pausedAt = Math.max(0, Math.min(DURATION - 1e-3, t)))),
    nudge: (d) => { const t = now() + d; playing ? play(t) : (pausedAt = Math.max(0, Math.min(DURATION - 1e-3, t))); },
    mute: () => { player.muted = !player.muted; },
    restart: () => play(0),
  });
  await play(0);
  // adaptive resolution: every 45 frames compare the mean frame time with the budget and step DPR down / up
  const steps = [2, 1.75, 1.5, 1.25, 1].filter((d) => d <= Math.min(devicePixelRatio || 1, 2));
  if (!steps.length) steps.push(1);
  let si = 0, acc = 0, cnt = 0, last = performance.now();
  const adapt = () => {
    const tnow = performance.now(); acc += tnow - last; last = tnow;
    if (++cnt < 45) return;
    const ms = acc / cnt; acc = 0; cnt = 0;
    const next = ms > 21 ? Math.min(si + 1, steps.length - 1) : ms < 12 ? Math.max(si - 1, 0) : si;
    if (next !== si) { si = next; DPR = steps[si]; renderer.setPixelRatio(DPR); resize(); }
  };
  const loop = () => {
    adapt();
    const t = now();
    const f = t * FPS;
    draw(f);
    gizmo.draw(camera, S, state.gizmo, gizCanvas.width, gizCanvas.height);
    ui.update(t, playing, player.muted);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

if (!CAPTURE) window.addEventListener('resize', resize);
boot().catch(fail);
