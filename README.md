# Xbox 360 · Keychain Build — a pure three.js film

A 13-second film of an Xbox 360 controller keychain being built piece by piece:
the shell inflates, cutters carve the wells, the sticks, d-pad and ABXY gems drop in,
the Ring of Light boots, the battery pack slides into the back, and a chain grows into a keyring.
It ends on a turntable with colour swaps.

**Everything is generated in the browser.** There are no models, textures, fonts or audio files.

- **Geometry:** every part is a signed distance function (`src/geometry/sdf.js`). At load time, a pool of Web Workers meshes each one with Surface Nets, using SDF-gradient normals (`mesh.js`, `build.js`). That is about 4.7 M triangles in about 1–2 s, because only voxels near the surface are evaluated.
- **Look:** MeshPhysicalMaterial plastics with an object-space micro-grain bump, and transmissive gems with coloured attenuation. Lighting is a studio softbox environment, and the post chain is GTAO, depth of field, bloom and AgX tone mapping.
- **Animation:** `src/timeline.js` is a frame-exact port of the original shot list: springs, drops, a carve, a ring-of-light boot, a copper→steel chain and a turntable.
- **Sound:** synthesised with WebAudio at load (`src/audio.js`): pad, pops, clicks, chain clinks and chimes. The film runs on the audio clock.

## Run

No build step. Serve the folder over http, because ES modules and workers need it:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 and press **Play**.

| Key | Action |
| --- | --- |
| Space | play / pause |
| ← → | scrub ±1 s |
| M | mute |
| R | restart |
| F | fullscreen |

## Render the film to MP4

`tools/capture.mjs` drives headless Chrome on your GPU. In capture mode each frame is accumulated from 8 jittered sub-frames over a 0.5-frame shutter, which gives anti-aliasing and motion blur.

```bash
node tools/capture.mjs --frames 0:390:1 --out out/frames --query spp=8 --wav out/sound.wav
```

```bash
ffmpeg -framerate 30 -i out/frames/f_%03d.png -i out/sound.wav -c:v libx264 -crf 15 -pix_fmt yuv420p -c:a aac -shortest film.mp4
```

The page also exposes `?capture=1&w=1440&h=1080&spp=8`, plus `window.__renderFrame(n)` and `window.__exportWav()`.
Debug flags: `gtao=0`, `dof=0`, `bloom=0`, `shadows=0`.

## Layout

```
index.html            page, styles, import map (three.js r186 vendored in vendor/three, MIT)
src/layout.js         shared constants: button positions, outline, face surface
src/geometry/         sdf.js (all parts) · mesh.js (Surface Nets) · worker.js · build.js (worker pool)
src/scene.js          placement, materials, studio environment, lights, palettes
src/timeline.js       the shot list and every animation curve
src/post.js           GTAO → bokeh DOF → bloom → AgX output → SMAA
src/gizmo.js          the Womp-style transform-box overlay
src/audio.js          procedural soundtrack + WebAudio player
src/ui.js, main.js    loader, start card, scrub bar, keyboard, capture hooks
tools/                capture.mjs (headless GPU capture), test-geometry.mjs (mesh every part in node)
```

## Pure code, checked

- The repo contains only text: HTML, JavaScript and Markdown. There are no images, meshes, fonts, audio or base64 blobs, and nothing is fetched at runtime.
- Vendored three.js is trimmed to the modules actually imported. SMAA was dropped because it ships its lookup tables as embedded PNGs; MSAA on the HDR target handles edges instead.
- The battery-pack sticker is drawn on a 2D canvas at load. Its text uses the system UI font.

**History.** The shot list, part shapes and sound design were first prototyped as an offline Blender/Python render. This repo is the standalone real-time version: every frame is produced live by the code here, and no rendered output from that prototype is used.

## Credits

The build-it-on-camera format was inspired by womp3D's Game Boy keychain clip.
This is an unofficial fan project, not affiliated with or endorsed by Microsoft.
Xbox and Xbox 360 are trademarks of Microsoft Corporation.

Code: MIT. three.js: MIT (see `vendor/three/LICENSE`).
