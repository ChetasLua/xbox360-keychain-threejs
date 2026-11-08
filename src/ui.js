// ui.js — DOM chrome for the film: loader, start card, scrub bar, mute button, keyboard + pointer input.
// No three.js here. main.js owns the clock and the renderer; this module only reports intents through callbacks
// and reflects state passed to update(). MIT License.
//
//   const ui = new UI();
//   ui.setProgress(0.62, 'carving SDFs');           // loader
//   ui.showError('WebGL is not available');          // loader turns into an error message
//   await ui.showStart();                            // resolves on the first Play click / Enter / Space
//   ui.attach({ duration, toggle, seek, nudge, mute, restart });
//   ui.update(timeSec, playing, muted);              // call every animation frame
//   ui.setMarkers([0.08, 0.21, ...]);                // shot boundaries as 0..1 fractions (ticks on the scrub bar)

const IDLE_MS = 2000;
const $ = (sel) => document.querySelector(sel);

function fmt(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

export class UI {
  constructor() {
    this.stage = $('#stage');
    this.frame = $('#frame');
    this.loader = $('#loader');
    this.loaderLabel = $('#loader .label');
    this.loaderFill = $('#loader .fill');
    this.start = $('#start');
    this.scrub = $('#scrub');
    this.prog = $('#scrub .prog');
    this.knob = $('#scrub .knob');
    this.rail = $('#scrub .rail');
    this.timeEl = $('#time');
    this.muteBtn = $('#mute');
    this.flashEl = $('#flash');
    this.h = null;              // handlers, set by attach()
    this.duration = 1;
    this.dragging = false;
    this.idleTimer = 0;
    this._last = { t: -1, playing: null, muted: null };
  }

  // ---------------------------------------------------------------- loader
  setProgress(frac, label = '') {
    const p = Math.max(0, Math.min(1, frac || 0));
    this.loaderFill.style.transform = `scaleX(${p})`;
    this.loaderLabel.textContent = label ? `${label} · ${Math.round(p * 100)}%` : `${Math.round(p * 100)}%`;
  }

  showError(msg) {
    this.loader.classList.remove('gone');
    this.loader.classList.add('error');
    this.loaderLabel.textContent = msg;
  }

  hideLoader() { this.loader.classList.add('gone'); }

  // ---------------------------------------------------------------- start card
  /** Shows the start card; resolves once the viewer asks to play (a user gesture, so audio can start). */
  showStart() {
    this.hideLoader();
    this.start.classList.remove('gone');
    const btn = this.start.querySelector('.play');
    btn.focus({ preventScroll: true });
    return new Promise((resolve) => {
      const go = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        this.start.removeEventListener('click', go);
        window.removeEventListener('keydown', onKey, true);
        this.start.classList.add('gone');
        resolve();
      };
      const onKey = (e) => { if (e.code === 'Space' || e.code === 'Enter') go(e); };
      this.start.addEventListener('click', go);          // the whole card is a target, not only the button
      window.addEventListener('keydown', onKey, true);
    });
  }

  // ---------------------------------------------------------------- player controls
  attach(handlers) {
    this.h = handlers;
    this.duration = handlers.duration || 1;
    this.scrub.setAttribute('aria-valuemax', this.duration.toFixed(1));
    this.stage.classList.add('ready');

    // Keyboard.
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.code) {
        case 'Space': case 'KeyK': e.preventDefault(); this._toggle(); break;
        case 'ArrowLeft': e.preventDefault(); this.h.nudge(-1); break;
        case 'ArrowRight': e.preventDefault(); this.h.nudge(1); break;
        case 'KeyM': this.h.mute(); break;
        case 'KeyR': this.h.restart(); break;
        case 'KeyF': this.toggleFullscreen(); break;
        default: return;
      }
      this.wake();
    });

    // Click on the picture toggles play (controls stop propagation).
    this.frame.addEventListener('click', (e) => {
      if (e.target.closest('#scrub, #mute, #start')) return;
      this._toggle();
      this.wake();
    });
    this.frame.addEventListener('dblclick', (e) => {
      if (e.target.closest('#scrub, #mute, #start')) return;
      this.toggleFullscreen();
    });
    this.muteBtn.addEventListener('click', (e) => { e.stopPropagation(); this.h.mute(); this.wake(); });

    // Scrub: pointer capture, seek continuously while dragging.
    const seekAt = (e) => {
      const r = this.rail.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      this.h.seek(x * this.duration * 0.99999);
    };
    this.scrub.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.dragging = true;
      this.scrub.classList.add('drag');
      this.scrub.setPointerCapture(e.pointerId);
      seekAt(e);
    });
    this.scrub.addEventListener('pointermove', (e) => { if (this.dragging) seekAt(e); });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.scrub.classList.remove('drag');
      try { this.scrub.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      this.wake();
    };
    this.scrub.addEventListener('pointerup', end);
    this.scrub.addEventListener('pointercancel', end);
    this.scrub.addEventListener('click', (e) => e.stopPropagation());

    // Auto-hide controls + cursor after IDLE_MS without input.
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'touchstart']) {
      this.stage.addEventListener(ev, () => this.wake(), { passive: true });
    }
    this.wake();
  }

  wake() {
    this.stage.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Keep the controls up while paused or dragging: the viewer is probably looking at them.
      if (this.dragging || this._last.playing === false) { this.wake(); return; }
      this.stage.classList.add('idle');
    }, IDLE_MS);
  }

  _toggle() {
    const wasPlaying = this._last.playing;
    this.h.toggle();
    this.flash(!wasPlaying);
  }

  /** Brief centred play/pause glyph, like a video player. */
  flash(playing) {
    const svg = this.flashEl.querySelector('svg');
    svg.innerHTML = playing ? '<path d="M7 4.5v15l12.5-7.5z"/>' : '<path d="M6.5 5h3.8v14H6.5zM13.7 5h3.8v14h-3.8z"/>';
    this.flashEl.classList.remove('on');
    void this.flashEl.offsetWidth; // restart the animation
    this.flashEl.classList.add('on');
  }

  setMarkers(fracs) {
    this.rail.querySelectorAll('.mark').forEach((m) => m.remove());
    for (const f of fracs) {
      if (f <= 0.001 || f >= 0.999) continue;
      const m = document.createElement('div');
      m.className = 'mark';
      m.style.left = `${(f * 100).toFixed(3)}%`;
      this.rail.appendChild(m);
    }
  }

  /** Reflect clock state. Only touches the DOM when something visibly changed. */
  update(t, playing, muted) {
    const L = this._last;
    const frac = Math.max(0, Math.min(1, t / this.duration));
    if (Math.abs(t - L.t) > 1e-3) {
      this.prog.style.transform = `scaleX(${frac})`;
      this.knob.style.left = `${frac * 100}%`;
      const label = `${fmt(t)} / ${fmt(this.duration)}`;
      if (this.timeEl.textContent !== label) this.timeEl.textContent = label;
      this.scrub.setAttribute('aria-valuenow', t.toFixed(1));
      L.t = t;
    }
    if (playing !== L.playing) { L.playing = playing; if (!playing) this.wake(); }
    if (muted !== L.muted) {
      L.muted = muted;
      this.muteBtn.classList.toggle('muted', muted);
      const lbl = muted ? 'Unmute (M)' : 'Mute (M)';
      this.muteBtn.setAttribute('aria-label', lbl);
      this.muteBtn.title = lbl;
    }
  }

  toggleFullscreen() {
    const d = document;
    const el = this.stage;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen)?.call(d);
    } else {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      req?.call(el)?.catch?.(() => { /* denied: ignore */ });
    }
  }
}
