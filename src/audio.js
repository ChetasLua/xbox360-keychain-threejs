// SPDX-License-Identifier: MIT
//
// audio.js — procedural soundtrack for the Xbox 360 keychain build film.
//
// A dependency-free JavaScript port of the original Blender pipeline's `tools/audio.py`, with the same events landing on
// the same film frames (30 fps, 390 frames = 13 s), plus a premium polish pass:
//
//   * band-limited (polyBLEP) saw pad: Fmaj9 - Am7 - Dm9 - G13 under a one-pole lowpass, counter-phased stereo LFO
//   * "plasticky" pops: pitched body sweep + resonant snap click + a short plastic shell mode
//   * metallic chain clinks: inharmonic partials with detuned twins (beating) and a bright strike transient
//   * bells with chorus shimmer, airy whooshes that travel across the stereo field, soft kick pulse at 96 bpm
//   * a Freeverb-style stereo reverb (8 damped combs + 4 allpasses per side) on the pad, bells and clinks; its tail is
//     wrapped around the loop point so the soundtrack loops with no seam
//   * subtle tape stage (gentle HF rolloff + soft saturation), master soft clip, DC blocker, end fade, normalised to
//     0.89 peak
//
// Everything is deterministic: noise comes from a seeded mulberry32 generator (numpy RNG parity is not attempted).
// All DSP runs in tight loops over typed arrays (no per-sample closures), so 13 s of 48 kHz stereo renders in well
// under 400 ms in a browser.
//
// Exports (see CONTRACTS.md):
//   synthSoundtrack(sr = 48000) -> { left: Float32Array, right: Float32Array, sr, duration }
//   encodeWav(snd)              -> Uint8Array   (16-bit PCM stereo RIFF/WAVE)        [extra helper]
//   encodeWavBase64(snd)        -> string       (base64 of the same WAV)
//   class Player                -> WebAudio looping playback; `time` is the film's master clock

const FPS = 30;          // film frame rate (matches src/layout.js)
const NF = 390;          // film length in frames
const DUR = NF / FPS;    // 13.0 s
const TAU = Math.PI * 2;

/** MIDI note number -> Hz. */
const note = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Fast, smooth tanh approximation (Padé 3/2), exact clamp at |x| >= 3. */
function softTanh(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// ---------------------------------------------------------------------------------------------------------------------
// Synth context: buffers, RNG and the generator toolkit. Created per synthSoundtrack() call so the module has no state.
// ---------------------------------------------------------------------------------------------------------------------
function makeSynth(SR) {
  const N = Math.floor(SR * DUR);
  const dryL = new Float32Array(N), dryR = new Float32Array(N);   // direct mix
  const sendL = new Float32Array(N), sendR = new Float32Array(N); // reverb send bus

  // mulberry32 PRNG, seed 7 (same seed as the Python default_rng(7), different stream).
  let seed = 7 >>> 0;
  let spare = 0, hasSpare = false;

  /** Fill `out[0..n)` with standard-normal noise (Box-Muller, mulberry32 inline). */
  function gauss(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (hasSpare) { out[i] = spare; hasSpare = false; continue; }
      seed = (seed + 0x6D2B79F5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const u1 = (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297; // (0, 1)
      seed = (seed + 0x6D2B79F5) >>> 0;
      t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const u2 = ((t ^ (t >>> 14)) >>> 0) / 4294967296;      // [0, 1)
      const r = Math.sqrt(-2 * Math.log(u1));
      out[i] = r * Math.cos(TAU * u2);
      spare = r * Math.sin(TAU * u2); hasSpare = true;
    }
    return out;
  }

  /** Python at(f): film frame (may be fractional) -> sample index. */
  const at = (f) => Math.floor((f / FPS) * SR);

  /**
   * Mix a mono signal into the buses at film frame `f`.
   * Equal-power pan; `pan` may be a number or a [from, to] pair that glides across the signal.
   * `send` is the reverb send level (0 = dry only).
   */
  function add(sig, f, gain = 1, pan = 0, send = 0) {
    const i0 = at(f);
    const n = Math.min(sig.length, N - i0);
    if (n <= 0) return;
    if (typeof pan === 'number') {
      const gl = Math.sqrt(0.5 * (1 - pan)) * gain, gr = Math.sqrt(0.5 * (1 + pan)) * gain;
      for (let k = 0; k < n; k++) {
        const v = sig[k], j = i0 + k;
        dryL[j] += v * gl; dryR[j] += v * gr;
      }
      if (send > 0) {
        const sl = gl * send, sr = gr * send;
        for (let k = 0; k < n; k++) { const j = i0 + k; sendL[j] += sig[k] * sl; sendR[j] += sig[k] * sr; }
      }
    } else {
      const p0 = pan[0], dp = (pan[1] - pan[0]) / Math.max(1, sig.length - 1);
      for (let k = 0; k < n; k++) {
        const p = p0 + dp * k;
        const gl = Math.sqrt(0.5 * (1 - p)) * gain, gr = Math.sqrt(0.5 * (1 + p)) * gain;
        const v = sig[k], j = i0 + k;
        dryL[j] += v * gl; dryR[j] += v * gr;
        if (send > 0) { sendL[j] += v * gl * send; sendR[j] += v * gr * send; }
      }
    }
  }

  /**
   * Accumulate an enveloped sine partial into `out`: amp * min(t/attack, 1) * exp(-t/decay) * sin(2*pi*freq*t).
   * Uses a rotating phasor (4 mults/sample, no Math.sin in the loop) and a multiplicative decay.
   */
  function partial(out, freq, amp, attack, decay) {
    const n = out.length;
    if (freq >= SR * 0.5) return; // above Nyquist: skip (prevents aliasing on high bell partials)
    const w = (TAU * freq) / SR, c = Math.cos(w), s = Math.sin(w);
    const k = Math.exp(-1 / (SR * decay));
    const aInc = 1 / Math.max(1, attack * SR);
    let re = 1, im = 0, e = amp, a = 0;
    for (let i = 0; i < n; i++) {
      a = a < 1 ? Math.min(1, i * aInc) : 1;
      out[i] += im * e * a;
      const nr = re * c - im * s; im = re * s + im * c; re = nr;
      e *= k;
      if (e < 1e-7 * amp && a >= 1) break; // inaudible: stop early
    }
  }

  // ---- generators (each returns a mono Float32Array) ---------------------------------------------------------------

  /**
   * Plasticky pop. Body = the original pitch-swept sine (freq*(1+1.6e^{-60t}), env(1 ms, dur/4)) with a touch of
   * 2nd harmonic; snap = noise through a high resonant bandpass (~2 ms); shell = short inharmonic plastic mode.
   */
  function pop(freq = 520, dur = 0.16) {
    const n = Math.floor(SR * dur);
    const out = new Float32Array(n);
    const dDec = Math.exp(-1 / (SR * (dur / 4)));
    const aInc = 1 / (0.001 * SR);
    let ph = 0, e = 1;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const fr = freq * (1 + 1.6 * Math.exp(-t * 60));
      ph += (TAU * fr) / SR;
      const a = Math.min(1, i * aInc);
      out[i] = (Math.sin(ph) + 0.12 * Math.sin(2 * ph)) * e * a;
      e *= dDec;
    }
    // resonant snap click: 2-pole bandpass on noise, centre rises with pitch
    const nz = gauss(Math.min(n, Math.floor(SR * 0.02)));
    const fc = Math.min(SR * 0.4, 2600 + freq * 3.2), r = Math.exp((-Math.PI * 900) / SR);
    const b1 = 2 * r * Math.cos((TAU * fc) / SR), b2 = -r * r, g0 = (1 - r) * 2.2;
    const cDec = Math.exp(-1 / (SR * 0.0022));
    let y1 = 0, y2 = 0, ce = 1;
    for (let i = 0; i < nz.length; i++) {
      const y = g0 * nz[i] + b1 * y1 + b2 * y2;
      y2 = y1; y1 = y;
      out[i] += y * ce * Math.min(1, i / (0.0003 * SR));
      ce *= cDec;
    }
    // plastic shell mode (short, slightly inharmonic)
    partial(out, freq * 2.31, 0.16, 0.0004, 0.012);
    partial(out, freq * 3.9, 0.06, 0.0003, 0.006);
    return out;
  }

  /** Small mechanical click: sine + bandpassed noise, env(0.3 ms, 8 ms). */
  function click(freq = 2400, dur = 0.05) {
    const n = Math.floor(SR * dur);
    const out = gauss(n);
    const r = Math.exp((-Math.PI * 2200) / SR);
    const b1 = 2 * r * Math.cos((TAU * Math.min(freq * 1.4, SR * 0.4)) / SR), b2 = -r * r, g0 = (1 - r) * 3;
    const w = (TAU * freq) / SR, k = Math.exp(-1 / (SR * 0.008)), aInc = 1 / (0.0003 * SR);
    let y1 = 0, y2 = 0, e = 1;
    for (let i = 0; i < n; i++) {
      const y = g0 * out[i] + b1 * y1 + b2 * y2;
      y2 = y1; y1 = y;
      out[i] = (Math.sin(w * i) * 0.6 + (0.25 * out[i] + 0.5 * y)) * e * Math.min(1, i * aInc);
      e *= k;
    }
    return out;
  }

  /** Metallic chain clink: inharmonic partials (1, 2.76, 5.4, 8.9, 13.2) with detuned twins + strike. */
  function clink(freq) {
    const n = Math.floor(SR * 0.6);
    const out = new Float32Array(n);
    const ms = [1, 2.76, 5.4, 8.9, 13.2];
    for (const m of ms) {
      partial(out, freq * m, 1 / m, 0.0005, 0.25 / m);
      partial(out, freq * m * 1.0031, 0.55 / m, 0.0005, 0.3 / m); // twin -> metallic beating
    }
    // bright strike transient
    const sN = Math.floor(SR * 0.004), nz = gauss(sN);
    let prev = 0;
    for (let i = 0; i < sN; i++) {
      const hp = nz[i] - prev; prev = nz[i];      // first difference = crude highpass
      out[i] += hp * 0.18 * (1 - i / sN);
    }
    for (let i = 0; i < n; i++) out[i] *= 0.6 / 1.55;
    return out;
  }

  /**
   * Whoosh: the original swept one-pole-lowpassed noise (a: 0.02 -> 0.12 rising, or falling), sin^2 window, *3,
   * plus a soft resonant band layer sweeping with it for an "air past the lens" swish.
   */
  function whoosh(dur = 0.5, up = true) {
    const n = Math.floor(SR * dur);
    const w = gauss(n), out = new Float32Array(n);
    let s = 0, lo = 0, bp = 0;
    for (let i = 0; i < n; i++) {
      const x = n > 1 ? i / (n - 1) : 0;
      const sh = Math.sin(Math.PI * x); const shape = sh * sh;
      const a = 0.02 + 0.10 * (up ? x : 1 - x);
      s += a * (w[i] - s);
      // Chamberlin SVF band layer, cutoff 400 Hz -> 3.2 kHz along the sweep
      const fc = 400 + 2800 * (up ? x : 1 - x);
      const f = 2 * Math.sin((Math.PI * fc) / SR);
      lo += f * bp; const hi = w[i] - lo - 0.7 * bp; bp += f * hi;
      out[i] = (s * 3 + bp * 0.05) * shape;
    }
    return out;
  }

  /** Bell: partials (1, 2, 3.01, 4.2) with gains (1, .4, .2, .08), decay dur/(1.5 m), plus chorus twin. */
  function bell(freq, dur = 1.6) {
    const n = Math.floor(SR * dur);
    const out = new Float32Array(n);
    const P = [[1, 1], [2, 0.4], [3.01, 0.2], [4.2, 0.08]];
    for (const [m, g] of P) {
      partial(out, freq * m, g, 0.002, dur / (1.5 * m));
      partial(out, freq * m * 1.0018, g * 0.35, 0.004, dur / (1.3 * m));
    }
    for (let i = 0; i < n; i++) out[i] *= 1 / 1.35;
    return out;
  }

  /** Soft kick: sine with the pitch sweep 55*(1+2e^{-40t}) Hz, env(2 ms, 80 ms), plus a tiny beater tick. */
  function kick() {
    const n = Math.floor(SR * 0.25);
    const out = new Float32Array(n);
    const k = Math.exp(-1 / (SR * 0.08)), aInc = 1 / (0.002 * SR);
    let e = 1;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const ph = TAU * 55 * (t + (2 * (1 - Math.exp(-40 * t))) / 40); // analytic integral of the sweep
      out[i] = Math.sin(ph) * e * Math.min(1, i * aInc);
      e *= k;
    }
    partial(out, 1900, 0.05, 0.0002, 0.0015);
    return out;
  }

  /** Mix a and b*gb (a may be shorter/longer) into a new buffer. */
  function mix(a, b, gb = 1) {
    const out = new Float32Array(Math.max(a.length, b.length));
    out.set(a);
    for (let i = 0; i < b.length; i++) out[i] += b[i] * gb;
    return out;
  }

  return { SR, N, dryL, dryR, sendL, sendR, at, add, gauss, pop, click, clink, whoosh, bell, kick, mix };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pad: soft detuned polyBLEP saws through a one-pole lowpass (a = 0.035), 4 chords over the film, plus a sub sine.
// ---------------------------------------------------------------------------------------------------------------------
function renderPad(S) {
  const { SR, N } = S;
  const chords = [[53, 60, 64, 67, 72], [57, 60, 64, 67, 71], [50, 57, 60, 64, 69], [55, 59, 62, 64, 69]];
  const seg = DUR / 4;
  const pad = new Float32Array(N);
  for (let ci = 0; ci < 4; ci++) {
    const ch = chords[ci];
    const i0 = Math.floor(ci * seg * SR);
    const i1 = Math.min(Math.floor((ci + 1) * seg * SR) + Math.floor(0.4 * SR), N);
    const n = i1 - i0;
    const seg1 = new Float64Array(n);
    for (const m of ch) {
      for (const det of [-0.08, 0.08]) {
        const dt = (note(m) * Math.pow(2, det / 12)) / SR;
        let p = 0;
        for (let i = 0; i < n; i++) {
          // band-limited saw: naive 2p-1 minus polyBLEP residual at the wrap
          let v = 2 * p - 1;
          if (p < dt) { const t = p / dt; v -= t + t - t * t - 1; }
          else if (p > 1 - dt) { const t = (p - 1) / dt; v -= t * t + t + t + 1; }
          seg1[i] += v * 0.08;
          p += dt; if (p >= 1) p -= 1;
        }
      }
    }
    // warm sub: root an octave down, very quiet
    const ws = (TAU * note(ch[0] - 12)) / SR;
    for (let i = 0; i < n; i++) seg1[i] += 0.06 * Math.sin(ws * i);
    // envelope: 0.6 s attack, 0.5 s release at the segment end
    for (let i = 0; i < n; i++) {
      const e = Math.min(i / SR / 0.6, 1) * Math.min((n - i) / SR / 0.5, 1);
      pad[i0 + i] += seg1[i] * e;
    }
  }
  // one-pole lowpass, same coefficient as the original
  let s = 0;
  for (let i = 0; i < N; i++) { s += 0.035 * (pad[i] - s); pad[i] = s; }
  // 0.3 Hz LFO; right channel uses the time-reversed LFO (as in the original) for slow stereo motion
  const g = 0.55, w = (TAU * 0.3) / SR;
  for (let i = 0; i < N; i++) {
    const v = pad[i] * g;
    const l = v * (1 + 0.15 * Math.sin(w * i));
    const r = v * (1 + 0.15 * Math.sin(w * (N - 1 - i)));
    S.dryL[i] += l; S.dryR[i] += r;
    S.sendL[i] += l * 0.45; S.sendR[i] += r * 0.45;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Events: identical frames, gains and pans to audio.py (sends and pan glides are the polish layer).
// ---------------------------------------------------------------------------------------------------------------------
function renderEvents(S) {
  const { add, pop, click, clink, whoosh, bell, kick, mix } = S;

  // soft kick pulse on beats from 2.0 s (96 bpm)
  const beat = 60 / 96, kk = kick();
  for (let k = 0; k < Math.floor(DUR / beat); k++) {
    const tt = k * beat;
    if (tt < 2.0) continue;
    add(kk, tt * FPS, 0.35);
  }

  // blob inflate
  add(whoosh(0.9, true), 0, 0.5, [-0.25, 0.25], 0.12); add(pop(180, 0.35), 3, 0.8, 0, 0.08);
  for (let i = 0; i < 10; i++) add(pop(300 + 15 * i, 0.1), 38 + (i % 5) + i * 0.2, 0.25, ((i % 3) - 1) * 0.4, 0.1);
  add(whoosh(0.4), 44, 0.4, [0.3, -0.3], 0.12); add(pop(140, 0.3), 44, 0.6);
  // left stick
  add(whoosh(0.35), 61, 0.35, [0.2, -0.4], 0.12); add(pop(420), 67, 0.9, -0.3, 0.1);
  // dpad
  add(whoosh(0.35), 91, 0.35, [0.2, -0.3], 0.12); add(pop(470), 97, 0.9, -0.2, 0.1);
  // gems
  for (const [f0, fr] of [[124, 660], [131, 590], [138, 740], [145, 520]]) {
    add(pop(fr, 0.14), f0 + 3, 0.8, 0.3, 0.1); add(click(3200), f0 + 4, 0.25, 0.3);
  }
  // guide
  add(pop(380, 0.2), 169, 0.6, 0, 0.1); add(whoosh(0.3), 172, 0.3, [-0.2, 0.2], 0.12); add(pop(560), 178, 0.9, 0, 0.12);
  // ring of light boot
  [76, 79, 83, 88, 91, 95, 88].forEach((m, i) => add(bell(note(m), 1.2), 186 + i * 2.3, 0.18, (i % 2) * 0.4 - 0.2, 0.5));
  add(mix(bell(note(84), 2.4), bell(note(88), 2.4), 0.6), 204, 0.3, 0, 0.5);
  // bumpers / triggers / small buttons
  for (const [f0, fr, pn] of [[214, 820, -0.3], [217, 860, 0.3], [224, 430, 0.3], [228, 300, -0.5], [231, 310, 0.5]]) {
    add(pop(fr, 0.12), f0 + 2, 0.7, pn, 0.1); add(click(2600), f0 + 2, 0.3, pn);
  }
  // battery
  add(whoosh(0.5), 243, 0.35, [-0.3, 0.3], 0.12); add(pop(240, 0.25), 250, 0.8); add(click(1800, 0.08), 251, 0.6);
  add(pop(330), 255, 0.5, -0.4, 0.1); add(pop(340), 257, 0.5, 0.4, 0.1);
  add(pop(700, 0.1), 273, 0.5, 0, 0.1);
  // chain clinks
  for (let i = 0; i < 8; i++) add(clink(1500 + 230 * (i % 4)), 279 + i * 2, 0.22, (i % 2) * 0.6 - 0.3, 0.3);
  add(mix(clink(1180), clink(1630), 0.5), 296, 0.35, 0, 0.3);
  // hero turns
  for (const f0 of [318, 336, 352, 366]) {
    add(whoosh(0.6), f0 - 8, 0.4, [-0.35, 0.35], 0.15); add(bell(note(96), 0.8), f0, 0.08, 0, 0.6);
  }
  // final chord
  add(mix(mix(bell(note(72), 3.0), bell(note(79), 3.0), 0.7), bell(note(84), 3.0), 0.5), 382, 0.18, 0, 0.6);
}

// ---------------------------------------------------------------------------------------------------------------------
// Freeverb-style stereo reverb. Returns wet L/R of length N + tail.
// ---------------------------------------------------------------------------------------------------------------------
function reverb(inL, inR, SR, tailSec = 2.5) {
  const N = inL.length, T = Math.floor(SR * tailSec), M = N + T;
  const outL = new Float32Array(M), outR = new Float32Array(M);
  const scale = SR / 44100;
  const COMB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const AP = [556, 441, 341, 225];
  const SPREAD = 23;
  const feedback = 0.84, damp = 0.25, apFb = 0.5, inGain = 0.015;
  const preDelay = Math.floor(0.018 * SR);

  // input: mostly own side + some cross-feed, pre-delayed, highpassed (~180 Hz) so the room stays clear of mud
  const xL = new Float32Array(M), xR = new Float32Array(M);
  const hpA = Math.exp((-TAU * 180) / SR);
  let hl = 0, hr = 0, pl = 0, pr = 0;
  for (let i = 0; i < N; i++) {
    const l = inL[i] * 0.75 + inR[i] * 0.25, r = inR[i] * 0.75 + inL[i] * 0.25;
    hl = hpA * (hl + l - pl); pl = l;
    hr = hpA * (hr + r - pr); pr = r;
    const j = i + preDelay;
    if (j < M) { xL[j] = hl * inGain; xR[j] = hr * inGain; }
  }

  const side = (x, out, offset) => {
    // parallel damped combs
    for (let c = 0; c < COMB.length; c++) {
      const len = Math.max(1, Math.round((COMB[c] + offset) * scale));
      const buf = new Float32Array(len);
      let idx = 0, store = 0;
      for (let i = 0; i < M; i++) {
        const y = buf[idx];
        store = y * (1 - damp) + store * damp;
        buf[idx] = x[i] + store * feedback;
        out[i] += y;
        if (++idx === len) idx = 0;
      }
    }
    // series allpasses
    for (let a = 0; a < AP.length; a++) {
      const len = Math.max(1, Math.round((AP[a] + offset) * scale));
      const buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < M; i++) {
        const b = buf[idx], v = out[i];
        buf[idx] = v + b * apFb;
        out[i] = b - v;
        if (++idx === len) idx = 0;
      }
    }
  };
  side(xL, outL, 0);
  side(xR, outR, SPREAD);
  return { outL, outR, T };
}

// ---------------------------------------------------------------------------------------------------------------------
// Public: synthesize the full soundtrack.
// ---------------------------------------------------------------------------------------------------------------------
/**
 * Render the 13 s stereo soundtrack.
 * @param {number} [sr=48000] sample rate
 * @returns {{left: Float32Array, right: Float32Array, sr: number, duration: number}}
 */
export function synthSoundtrack(sr = 48000) {
  const S = makeSynth(sr);
  const { N, dryL, dryR } = S;

  renderPad(S);
  renderEvents(S);

  // reverb; fold the tail past the end back onto the start so the loop point is seamless
  const wet = reverb(S.sendL, S.sendR, sr);
  const WET = 1.0;
  for (let i = 0; i < wet.T; i++) {
    wet.outL[i % N] += wet.outL[N + i];
    wet.outR[i % N] += wet.outR[N + i];
  }

  // end fade (0.4 s) on the dry path only; the wet path is continuous across the wrap
  const L = new Float32Array(N), R = new Float32Array(N);
  const fadeN = sr * 0.4;
  for (let i = 0; i < N; i++) {
    const f = Math.min(1, (N - i) / fadeN);
    L[i] = dryL[i] * f + wet.outL[i] * WET;
    R[i] = dryR[i] * f + wet.outR[i] * WET;
  }

  // tape stage + master. Stateful filters are pre-warmed over the last 0.5 s so the loop point stays continuous.
  const tapeLp = 1 - Math.exp((-TAU * 15000) / sr);  // gentle HF rolloff
  const dcA = Math.exp((-TAU * 12) / sr);            // DC blocker ~12 Hz
  const drive = 1.35, tapeMix = 0.35, mDrive = 1.2, mNorm = 1 / Math.tanh(mDrive);
  const master = (x, st) => {
    st.lp += tapeLp * (x - st.lp);                                   // tape HF softening
    const sat = softTanh(st.lp * drive) / drive;                      // tape saturation (symmetric -> no DC)
    let y = st.lp + tapeMix * (sat - st.lp);
    y = softTanh(y * 0.9 * mDrive) * mNorm;                           // master soft clip (original: tanh(1.2x))
    st.dc = dcA * (st.dc + y - st.px); st.px = y;                     // DC blocker
    return st.dc;
  };
  const stL = { lp: 0, dc: 0, px: 0 }, stR = { lp: 0, dc: 0, px: 0 };
  const warm = Math.min(N, Math.floor(sr * 0.5));
  for (let i = N - warm; i < N; i++) { master(L[i], stL); master(R[i], stR); }
  let pk = 0;
  for (let i = 0; i < N; i++) {
    const l = master(L[i], stL), r = master(R[i], stR);
    L[i] = l; R[i] = r;
    const a = Math.abs(l), b = Math.abs(r);
    if (a > pk) pk = a; if (b > pk) pk = b;
  }
  const g = pk > 0 ? 0.89 / pk : 1;
  for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }

  return { left: L, right: R, sr, duration: N / sr };
}

// ---------------------------------------------------------------------------------------------------------------------
// WAV encoding
// ---------------------------------------------------------------------------------------------------------------------
/** Encode as a 16-bit PCM stereo WAV file. @returns {Uint8Array} */
export function encodeWav(snd) {
  const n = snd.left.length, dataBytes = n * 4;
  const buf = new ArrayBuffer(44 + dataBytes), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, snd.sr, true); v.setUint32(28, snd.sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  const pcm = new Int16Array(buf, 44, n * 2); // little-endian hosts (all browsers / node targets in practice)
  const L = snd.left, R = snd.right;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i]));
    pcm[2 * i] = Math.round(l * 32767); pcm[2 * i + 1] = Math.round(r * 32767);
  }
  return new Uint8Array(buf);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of a Uint8Array without btoa/Buffer (works in browsers, workers and node). */
function toBase64(bytes) {
  const parts = [];
  const CH = 3 * 16384; // encode in chunks to keep strings/array sizes bounded
  for (let s = 0; s < bytes.length; s += CH) {
    const e = Math.min(bytes.length, s + CH);
    const codes = new Array(Math.ceil((e - s) / 3) * 4);
    let o = 0, i = s;
    for (; i + 2 < e; i += 3) {
      const t = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      codes[o++] = B64[t >> 18]; codes[o++] = B64[(t >> 12) & 63]; codes[o++] = B64[(t >> 6) & 63]; codes[o++] = B64[t & 63];
    }
    if (i < e) {
      const t = (bytes[i] << 16) | ((i + 1 < e ? bytes[i + 1] : 0) << 8);
      codes[o++] = B64[t >> 18]; codes[o++] = B64[(t >> 12) & 63];
      codes[o++] = i + 1 < e ? B64[(t >> 6) & 63] : '=';
      codes[o++] = '=';
    }
    parts.push(codes.join(''));
  }
  return parts.join('');
}

/** Encode as a base64 16-bit stereo WAV string. */
export function encodeWavBase64(snd) {
  return toBase64(encodeWav(snd));
}

// ---------------------------------------------------------------------------------------------------------------------
// Player: WebAudio looping playback; its `time` is the film's master clock.
// ---------------------------------------------------------------------------------------------------------------------
export class Player {
  /** @param {{left: Float32Array, right: Float32Array, sr: number, duration: number}} snd */
  constructor(snd) {
    this.snd = snd;
    this.duration = snd.duration;
    this.ctx = null;
    this.buffer = null;
    this.gain = null;
    this.source = null;
    this._muted = false;
    this._offset = 0;      // playhead (s) at ctx time _t0
    this._t0 = 0;
    this._playing = false;
  }

  /** Create the AudioContext / buffer lazily (must happen inside a user gesture for autoplay policies). */
  _ensure() {
    if (this.ctx) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw new Error('Web Audio API not available');
    this.ctx = new AC({ sampleRate: this.snd.sr, latencyHint: 'playback' });
    const n = this.snd.left.length;
    this.buffer = this.ctx.createBuffer(2, n, this.snd.sr);
    this.buffer.copyToChannel(this.snd.left, 0);
    this.buffer.copyToChannel(this.snd.right, 1);
    this.duration = n / this.snd.sr;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._muted ? 0 : 1;
    this.gain.connect(this.ctx.destination);
  }

  /** Output latency compensation so picture lines up with what is heard. */
  _latency() {
    const c = this.ctx;
    const l = (c.outputLatency || 0) || (c.baseLatency || 0);
    return Number.isFinite(l) && l > 0 && l < 0.5 ? l : 0;
  }

  /** Start (or restart / seek) playback from `fromSec` (wrapped into [0, duration)). */
  async start(fromSec = 0) {
    this._ensure();
    const d = this.duration;
    const from = ((fromSec % d) + d) % d;
    if (this.source) { try { this.source.stop(); } catch (_) { /* already stopped */ } this.source.disconnect(); }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true; src.loopStart = 0; src.loopEnd = d;
    src.connect(this.gain);
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const when = this.ctx.currentTime + 0.01;
    src.start(when, from);
    this.source = src;
    this._t0 = when + this._latency();
    this._offset = from;
    this._playing = true;
  }

  /** Pause: suspends the context, which freezes currentTime and therefore the film clock. */
  pause() {
    if (!this.ctx || !this._playing) return;
    this._offset = this.time; // remember in case the context is lost
    this._playing = false;
    this.ctx.suspend();
  }

  /** Resume after pause(); restarts from the paused playhead if the context cannot resume. */
  async resume() {
    if (!this.ctx) return this.start(this._offset);
    if (this._playing) return;
    if (!this.source) return this.start(this._offset);
    await this.ctx.resume();
    this._playing = true;
  }

  get playing() { return this._playing; }

  /** Playhead in seconds within [0, duration). This is the film's master clock. */
  get time() {
    if (!this.ctx || !this.source) return this._offset;
    const d = this.duration;
    const t = this._offset + (this.ctx.currentTime - this._t0);
    return ((t % d) + d) % d;
  }

  get muted() { return this._muted; }
  /** Mute through the gain node; the source keeps playing so the clock keeps running. */
  set muted(b) {
    this._muted = !!b;
    if (this.gain) this.gain.gain.setTargetAtTime(this._muted ? 0 : 1, this.ctx.currentTime, 0.015);
  }
}
