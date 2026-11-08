// SPDX-License-Identifier: MIT
// post.js — the post stack: render → GTAO contact shadows → physical-ish bokeh DOF → bloom (ring of light) → AgX output → lens finish. (MSAA x4 on the HDR target handles edges.)
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Lens finish: very subtle chromatic aberration toward the edges, vignette and animated film grain.
const LensShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.028 }, uVig: { value: 0.22 }, uCA: { value: 0.0012 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uGrain, uVig, uCA; uniform vec2 uRes; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5; float r2 = dot(d, d);
      vec3 c = vec3(texture2D(tDiffuse, vUv - d * uCA * r2 * 4.0).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + d * uCA * r2 * 4.0).b);
      c *= 1.0 - uVig * smoothstep(0.08, 0.55, r2);
      float n = h(floor(vUv * uRes) + fract(uTime * 0.6180339) * 97.0) - 0.5;
      c += n * uGrain * (0.35 + 0.65 * (1.0 - dot(c, vec3(0.333))));
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export function createPost(renderer, scene, camera, w, h, opts = {}) {
  const o = { gtao: true, dof: true, bloom: true, ...opts };
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  let gtao = null, bokeh = null, bloom = null;
  if (o.gtao) {
    gtao = new GTAOPass(scene, camera, w, h);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 1.0;
    gtao.updateGtaoMaterial({ radius: 0.8, distanceExponent: 1.2, thickness: 0.8, scale: 1.0, samples: 16 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    composer.addPass(gtao);
  }
  if (o.dof) {
    bokeh = new BokehPass(scene, camera, { focus: 20, aperture: 0.0, maxblur: 0.012 });
    composer.addPass(bokeh);
  }
  if (o.bloom) {
    bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.32, 0.28, 3.2);
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());
  const lens = new ShaderPass(LensShader); lens.uniforms.uRes.value.set(w, h);
  if (o.lens !== false) composer.addPass(lens);

  return {
    composer,
    /** @param {{focus:number, fstop:number, lens:number}} cam  scene units are cm */
    render(cam, frame = 0) {
      lens.uniforms.uTime.value = frame;
      if (bokeh && cam) {
        // macro shots pull focus ~3 mm forward onto the button tops (the timeline aims at the face plane)
        const fcm = cam.lens / 10, s = Math.max(cam.focus - (cam.lens >= 90 ? 0.55 : 0), 1);
        // circle of confusion per cm of depth offset, as a fraction of the 36 mm sensor width
        const ap = (fcm * fcm) / (cam.fstop * s * s) / 3.6 * 0.22;
        bokeh.uniforms.focus.value = s;
        bokeh.uniforms.aperture.value = ap;
        bokeh.enabled = ap > 0.0015;
      }
      composer.render();
    },
    setSize(W, H) { composer.setSize(W, H); lens.uniforms.uRes.value.set(W, H); },
  };
}
