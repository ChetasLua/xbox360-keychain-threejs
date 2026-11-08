// Shared layout constants. All model/animation coordinates are "model space" (cm):
//   X right, Z up, the controller's front face looks toward -Y.
// The three.js scene puts everything under a root group rotated -90deg about X, so model (x, y, z) -> three (x, z, -y).
export const FPS = 30;
export const NF = 390;              // 13.0 s
export const WIDTH = 1440, HEIGHT = 1080; // 4:3 film aspect

export const POS = {
  lstick: [-4.45, 1.25], abxy: [4.45, 1.25], dpad: [-2.25, -1.55], rstick: [2.25, -1.55],
  guide: [0.0, 1.95], back: [-1.72, 1.05], start: [1.72, 1.05],
};
export const ABXY_OFF = { Y: [0, 0.98], A: [0, -0.98], X: [-0.98, 0], B: [0.98, 0] };

// Right half of the front-view outline, clockwise from top centre; mirrored for the left half.
export const RIGHT_OUTLINE = [[0, 3.30], [1.4, 3.32], [2.6, 3.42], [4.0, 3.62], [5.3, 3.55], [6.35, 3.05], [7.15, 2.2], [7.62, 1.05],
  [7.78, -0.35], [7.62, -2.05], [7.2, -3.85], [6.55, -5.55], [5.7, -6.7], [4.7, -7.12], [3.75, -6.82],
  [3.1, -5.9], [2.55, -4.65], [1.9, -3.55], [1.0, -3.12]];

export function outlineControlPoints() {
  const left = RIGHT_OUTLINE.slice(1).reverse().map(([x, z]) => [-x, z]);
  return [...RIGHT_OUTLINE, [0, -3.02], ...left];
}

export function sstep(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }

// front surface y of the shell at (x, z) (toward camera is negative)
export function faceY(x, z) {
  return -1.45 + 0.30 * (x / 7.5) ** 2 + 0.38 * sstep(-1.5, -6.5, z) + 0.10 * sstep(2.2, 3.6, z);
}

// model -> three.js world (when root is identity-placed and rotated -90deg about X)
export function m2t(x, y, z) { return [x, z, -y]; }
