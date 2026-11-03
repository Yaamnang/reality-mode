import type { Landmark } from "@mediapipe/tasks-vision";
import type { Hand } from "./gestures";

// The reality dial: twist an open hand like turning a big knob (palm down or facing the camera)
// to step through versions of the selected object.
// The twist is measured in 3D (MediaPipe's world landmarks) as the knuckle line (index knuckle to
// pinky knuckle) turning around the palm's own axis, so it works from any camera angle. It's
// compared with where the hand started, not added up frame by frame, so jitter can't build up.

// Twist this far from the starting angle = one step.
const STEP_DEG = 40;
// The palm center moving this far (0..1 of frame) means the hand is moving, not twisting (a wave):
// start over from the new position.
const MAX_SHIFT = 0.1;
// Smoothing of the knuckle line (world landmarks aren't smoothed by gestures.ts).
const SMOOTH = 0.4;
// After a step, wait this long before the next one.
const STEP_GAP_MS = 300;

const WRIST = 0;
const INDEX_KNUCKLE = 5;
const MIDDLE_KNUCKLE = 9;
const PINKY_KNUCKLE = 17;

type Vec = [number, number, number];

let start: { line: Vec; palm: { x: number; y: number } } | null = null;
let line: Vec | null = null;
let normal: Vec | null = null;
let lastStep = 0;
let angle = 0; // current twist from the start, degrees (signed), for drawing
let screen = 1; // -1 when the view is mirrored: turns are reported as seen on screen

// Call every frame. Returns +1 when the hand twisted a step clockwise as seen on screen, -1
// counterclockwise, otherwise 0.
export function dialTurn(hands: Hand[], mirrored: boolean, now: number): -1 | 0 | 1 {
  const palms = hands.filter((h) => h.gesture === "Open_Palm" && h.world && h.world.length === 21);
  // Two open hands = the reset gesture, not a twist.
  const hand = palms.length === 1 ? palms[0] : null;
  if (!hand) {
    resetDial();
    return 0;
  }
  const w = hand.world!;
  screen = mirrored ? -1 : 1;
  const palm = hand.landmarks[MIDDLE_KNUCKLE];

  let n = cross(sub(w[INDEX_KNUCKLE], w[WRIST]), sub(w[PINKY_KNUCKLE], w[WRIST]));
  n = norm(n);
  if (!normal) {
    // First frame: point the axis toward the camera (z smaller = closer) or, for a flat palm-down
    // hand seen from the side, upward (y smaller = up), so "right" means the same every time.
    const toCamera = -n[2];
    const up = -n[1];
    if ((Math.abs(toCamera) > Math.abs(up) ? toCamera : up) < 0) n = scale(n, -1);
  } else if (dot(n, normal) < 0) {
    n = scale(n, -1); // keep it pointing the same way as last frame
  }
  normal = n;

  const raw = norm(flatten(sub(w[PINKY_KNUCKLE], w[INDEX_KNUCKLE]), n));
  line = line ? norm(add(scale(line, 1 - SMOOTH), scale(flatten(raw, n), SMOOTH))) : raw;

  if (!start || Math.hypot(palm.x - start.palm.x, palm.y - start.palm.y) > MAX_SHIFT) {
    start = { line, palm: { x: palm.x, y: palm.y } };
    angle = 0;
    return 0;
  }

  const from = norm(flatten(start.line, n));
  angle = (Math.atan2(dot(n, cross(from, line)), dot(from, line)) * 180) / Math.PI;
  if (Math.abs(angle) < STEP_DEG || now - lastStep < STEP_GAP_MS) return 0;

  // A positive angle is counterclockwise in the raw camera frame (tested with simulated hands).
  const dir = -Math.sign(angle) * screen;
  lastStep = now;
  start = { line, palm: { x: palm.x, y: palm.y } };
  angle = 0;
  return dir > 0 ? 1 : -1;
}

// How far the current twist is towards a step, -1..1, positive = clockwise on screen (for drawing).
export function dialProgress(): number {
  return start ? Math.max(-1, Math.min(1, (-angle * screen) / STEP_DEG)) : 0;
}

export function resetDial() {
  start = null;
  line = null;
  normal = null;
  angle = 0;
}

function sub(a: Landmark, b: Landmark): Vec {
  return [a.x - b.x, a.y - b.y, a.z - b.z];
}
function add(a: Vec, b: Vec): Vec {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec, k: number): Vec {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function dot(a: Vec, b: Vec) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec): Vec {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
// `a` with its part along `n` removed (lies flat in the palm's plane).
function flatten(a: Vec, n: Vec): Vec {
  return sub3(a, scale(n, dot(a, n)));
}
function sub3(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
