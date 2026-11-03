import { isPhone } from "./camera";
// Follows the camera as it turns, by remembering what each part of the room looks like.
//
// Every edit in the virtual view is pinned to the scene by "scene motion": how far the picture's
// content has moved since the edit was made (0..1 of the frame). Following one object can't give
// that once the object leaves the view, so this measures the whole picture instead:
//   - Keyframes: small gray pictures of the room, each with its scene motion when it was taken.
//     A new one is added whenever the camera has turned far enough from the last.
//   - Each new frame is matched against the current keyframe (hands left out), which gives the
//     scene motion now. Going back to an old keyframe gives its exact old numbers, so errors don't
//     build up: turn away and back, and everything lands where it was.
//   - Lost (a fast swing, something blocking the view): the view starts a new "island", far away in
//     scene-motion numbers, so nothing placed elsewhere shows up in the wrong spot. Keyframes of
//     the other islands are tried in the background; a good match joins the two islands into one,
//     and whatever was placed on either stays in the right spot (see onIslandsJoined).
// It understands sideways and up/down turns. Leaning in, tilting the camera sideways or walking to
// a new spot changes the picture in ways a shift can't describe, and isn't handled.

const W = 160;
const H = 90;
// How far content can move between two frames (small pixels); fast turns are helped by the prediction.
const REACH_X = 18;
const REACH_Y = 12;
const COARSE_STEP = 2;
// Differences are capped at this, so a passing hand or a changed spot can't dominate a match.
const CLIP = 40;
// Every copy of the picture is scaled to this contrast (standard deviation of brightness).
const CONTRAST = 32;
// Average difference (0..CLIP) of a match we trust, and of one that means we've lost the view.
const GOOD_SCORE = 14;
const LOST_SCORE = 18;
const LOST_FRAMES = 10;
// A match to another island's keyframe must be this good, twice in a row.
const JUMP_SCORE = 9;
const JUMP_HITS = 2;
// At least this share of a keyframe's points must be in view for a match to count.
const MIN_OVERLAP = 0.3;
// Turned this far (of the frame) from the current keyframe: switch to a nearby one, or add one.
const NEW_KEY_AT = 0.12;
// The match getting worse without turning (leaning in, rolling the camera): add a keyframe before
// it's lost, at most this often (frames).
const REFRESH_FRAMES = 5;
const MAX_KEYS = 80;
const MAX_POINTS = 700;
const MIN_POINTS = 60; // fewer textured points than this (a blank wall): not a useful keyframe
const ISLAND_GAP = 100; // scene-motion distance between islands (frames); nothing crosses it

interface Point {
  x: number;
  y: number;
  g: number; // brightness with the frame's average taken out
}

interface Keyframe {
  points: Point[];
  motion: { x: number; y: number }; // scene motion when it was taken
  island: number;
}

type HandBox = { x0: number; y0: number; x1: number; y1: number };

const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
// On a phone a CPU canvas pulls the whole camera picture out of the GPU; a GPU canvas shrinks it there first.
const ctx = canvas.getContext("2d", { willReadFrequently: !isPhone })!;

let keys: Keyframe[] = [];
let current: Keyframe | null = null;
let offset = { x: 0, y: 0 }; // content shift from the current keyframe, small pixels
let velocity = { x: 0, y: 0 };
let motion = { x: 0, y: 0 };
let badFrames = 0;
let island = 0;
let lastIsland = 0;
let lost = false;
let jumpIndex = 0;
let jumpCandidate: { key: Keyframe; hits: number } | null = null;
let matchedAt = 0;
let lastScore = 0;
let keyAge = 0;
const joinListeners: ((from: number, shift: { x: number; y: number }) => void)[] = [];

// How far the picture's content has moved in total (0..1 of frame), through every turn.
export function sceneMotion(): { x: number; y: number } {
  return { ...motion };
}

// Which island a scene-motion value belongs to.
export function islandOf(m: { x: number }): number {
  return Math.round(m.x / ISLAND_GAP);
}

// Two islands became one: every remembered scene motion on island `from` must have `shift` taken
// away to stay right.
export function onIslandsJoined(fn: (from: number, shift: { x: number; y: number }) => void) {
  joinListeners.push(fn);
}

// True while the camera's view can't be placed (right after a fast swing).
export function sceneLost(): boolean {
  return lost;
}

export function resetSceneTracker() {
  keys = [];
  current = null;
  offset = { x: 0, y: 0 };
  velocity = { x: 0, y: 0 };
  motion = { x: 0, y: 0 };
  badFrames = 0;
  island = 0;
  lastIsland = 0;
  lost = false;
  jumpCandidate = null;
}

// Call once per new camera frame. `hands`: landmarks (0..1 of frame) of hands in view, left out of
// the matching.
export function trackScene(source: CanvasImageSource, hands: { x: number; y: number }[][]) {
  const started = performance.now();
  ctx.drawImage(source, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const gray = normalized(rgba);
  const boxes = handBoxes(hands);

  if (!current) {
    addKey(gray, boxes);
    return;
  }

  const found = match(gray, current, offset.x + velocity.x, offset.y + velocity.y, REACH_X, REACH_Y, boxes);
  lastScore = found?.score ?? Infinity;
  if (found && found.score < LOST_SCORE) {
    badFrames = 0;
    lost = false;
    velocity = { x: found.x - offset.x, y: found.y - offset.y };
    offset = { x: found.x, y: found.y };
    motion = { x: current.motion.x + offset.x / W, y: current.motion.y + offset.y / H };
    keyAge++;
    if (found.score > GOOD_SCORE && keyAge >= REFRESH_FRAMES) addKey(gray, boxes);
    else maybeChangeKey(gray, boxes);
  } else if (++badFrames >= LOST_FRAMES && !lost) {
    // Lost: this view starts its own island, away from everything placed so far.
    lost = true;
    island = ++lastIsland;
    motion = { x: island * ISLAND_GAP, y: 0 };
    current = null;
    offset = { x: 0, y: 0 };
    velocity = { x: 0, y: 0 };
    addKey(gray, boxes);
    if (current) lost = false;
  }
  tryOtherIslands(gray, boxes);
  matchedAt = performance.now() - started;
}

// For the stats line: how long the last frame took (ms), its match score, keyframes, island.
export function trackerStats() {
  return { ms: matchedAt, score: lastScore, keys: keys.length, island };
}

// A gray copy, softened a little (so being a fraction of a pixel off doesn't matter), with its
// average and contrast evened out (so the webcam's auto-exposure doesn't either).
function normalized(rgba: Uint8ClampedArray): Int16Array {
  const raw = new Float32Array(W * H);
  for (let i = 0; i < raw.length; i++) raw[i] = rgba[i * 4] * 0.3 + rgba[i * 4 + 1] * 0.59 + rgba[i * 4 + 2] * 0.11;
  const soft = new Float32Array(W * H);
  let sum = 0;
  let squares = 0;
  for (let y = 0; y < H; y++) {
    const up = y > 0 ? -W : 0;
    const down = y < H - 1 ? W : 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const left = x > 0 ? -1 : 0;
      const right = x < W - 1 ? 1 : 0;
      const v = (raw[i] * 4 + (raw[i + left] + raw[i + right] + raw[i + up] + raw[i + down]) * 2 +
        raw[i + up + left] + raw[i + up + right] + raw[i + down + left] + raw[i + down + right]) / 16;
      soft[i] = v;
      sum += v;
      squares += v * v;
    }
  }
  const mean = sum / soft.length;
  const spread = Math.sqrt(Math.max(squares / soft.length - mean * mean, 1));
  const gray = new Int16Array(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(((soft[i] - mean) * CONTRAST) / spread);
  return gray;
}

// Far enough from the current keyframe: use a nearby old keyframe (exact old numbers, no build-up
// of error), or add a new one.
function maybeChangeKey(gray: Int16Array, boxes: HandBox[]) {
  if (!current) return;
  if (Math.hypot(offset.x / W, offset.y / H) < NEW_KEY_AT) return;
  const near = keys
    .filter((k) => k !== current && k.island === current!.island)
    .map((k) => ({ k, d: Math.hypot(motion.x - k.motion.x, motion.y - k.motion.y) }))
    .filter((c) => c.d < NEW_KEY_AT)
    .sort((a, b) => a.d - b.d);
  for (const { k } of near.slice(0, 3)) {
    const predicted = { x: (motion.x - k.motion.x) * W, y: (motion.y - k.motion.y) * H };
    const found = match(gray, k, predicted.x, predicted.y, 8, 6, boxes);
    if (found && found.score < GOOD_SCORE) {
      current = k;
      velocity = { x: 0, y: 0 };
      offset = { x: found.x, y: found.y };
      motion = { x: k.motion.x + offset.x / W, y: k.motion.y + offset.y / H };
      return;
    }
  }
  addKey(gray, boxes);
}

function addKey(gray: Int16Array, boxes: HandBox[]) {
  const points = pickPoints(gray, boxes);
  if (points.length < MIN_POINTS) return; // a blank view: keep using the last keyframe if there is one
  const key: Keyframe = { points, motion: { ...motion }, island };
  keys.push(key);
  if (keys.length > MAX_KEYS) {
    const drop = keys.findIndex((k) => k !== current);
    keys.splice(drop, 1);
  }
  current = key;
  offset = { x: 0, y: 0 };
  keyAge = 0;
}

// The best-textured points, spread over the picture and away from hands.
function pickPoints(gray: Int16Array, boxes: HandBox[]): Point[] {
  const scored: { x: number; y: number; g: number; edge: number }[] = [];
  for (let y = 2; y < H - 2; y += 2) {
    for (let x = 2; x < W - 2; x += 2) {
      if (inBoxes(x, y, boxes)) continue;
      const i = y * W + x;
      const edge = Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + W] - gray[i - W]);
      if (edge >= 6) scored.push({ x, y, g: gray[i], edge });
    }
  }
  scored.sort((a, b) => b.edge - a.edge);
  return scored.slice(0, MAX_POINTS).map(({ x, y, g }) => ({ x, y, g }));
}

// The shift of `key`'s content that best matches this frame, around (cx, cy), refined to a
// fraction of a small pixel. null if too little of the keyframe is in view.
function match(gray: Int16Array, key: Keyframe, cx: number, cy: number, rx: number, ry: number, boxes: HandBox[]) {
  const coarse = key.points.filter((_, i) => i % 3 === 0);
  let best = { x: Math.round(cx), y: Math.round(cy), score: Infinity };
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let dy = -ry; dy <= ry; dy += COARSE_STEP) {
    for (let dx = -rx; dx <= rx; dx += COARSE_STEP) {
      const s = scoreAt(gray, coarse, x0 + dx, y0 + dy, boxes);
      if (s < best.score) best = { x: x0 + dx, y: y0 + dy, score: s };
    }
  }
  if (best.score === Infinity) return null;
  const at = best;
  best = { ...at, score: Infinity };
  for (let dy = -COARSE_STEP; dy <= COARSE_STEP; dy++) {
    for (let dx = -COARSE_STEP; dx <= COARSE_STEP; dx++) {
      const s = scoreAt(gray, key.points, at.x + dx, at.y + dy, boxes);
      if (s < best.score) best = { x: at.x + dx, y: at.y + dy, score: s };
    }
  }
  if (best.score === Infinity) return null;
  // A parabola through the neighbours gives the position between pixels.
  const fraction = (a: number, b: number, c: number) => {
    const bottom = a - 2 * b + c;
    return Number.isFinite(bottom) && bottom > 1e-6 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * bottom))) : 0;
  };
  const fx = fraction(scoreAt(gray, key.points, best.x - 1, best.y, boxes), best.score, scoreAt(gray, key.points, best.x + 1, best.y, boxes));
  const fy = fraction(scoreAt(gray, key.points, best.x, best.y - 1, boxes), best.score, scoreAt(gray, key.points, best.x, best.y + 1, boxes));
  return { x: best.x + fx, y: best.y + fy, score: best.score };
}

function scoreAt(gray: Int16Array, points: Point[], dx: number, dy: number, boxes: HandBox[]): number {
  let sum = 0;
  let n = 0;
  for (const p of points) {
    const x = p.x + dx;
    const y = p.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H || inBoxes(x, y, boxes)) continue;
    sum += Math.min(Math.abs(gray[y * W + x] - p.g), CLIP);
    n++;
  }
  return n >= points.length * MIN_OVERLAP ? sum / n : Infinity;
}

// Tries a few keyframes from other islands each frame, over a wide area. Needs two good matches in
// a row on the same keyframe, then the view jumps back there.
function tryOtherIslands(gray: Int16Array, boxes: HandBox[]) {
  const others = keys.filter((k) => k.island !== island);
  if (!others.length) return;
  // A keyframe that matched last frame gets the second try; otherwise the next one in turn.
  const key = jumpCandidate && jumpCandidate.key.island !== island ? jumpCandidate.key : others[jumpIndex++ % others.length];
  const sparse = key.points.filter((_, i) => i % 6 === 0);
  let best = { x: 0, y: 0, score: Infinity };
  for (let dy = -Math.round(H * 0.5); dy <= H * 0.5; dy += 4) {
    for (let dx = -Math.round(W * 0.6); dx <= W * 0.6; dx += 4) {
      const s = scoreAt(gray, sparse, dx, dy, boxes);
      if (s < best.score) best = { x: dx, y: dy, score: s };
    }
  }
  const found = best.score > LOST_SCORE ? null : match(gray, key, best.x, best.y, 6, 6, boxes);
  if (!found || found.score > JUMP_SCORE) {
    jumpCandidate = null;
    return;
  }
  jumpCandidate = jumpCandidate?.key === key ? { key, hits: jumpCandidate.hits + 1 } : { key, hits: 1 };
  if (jumpCandidate.hits < JUMP_HITS) return;
  // Join this island into the keyframe's: its numbers shift so the two agree.
  const from = island;
  const there = { x: key.motion.x + found.x / W, y: key.motion.y + found.y / H };
  const shift = { x: motion.x - there.x, y: motion.y - there.y };
  for (const k of keys) {
    if (k.island !== from) continue;
    k.island = key.island;
    k.motion = { x: k.motion.x - shift.x, y: k.motion.y - shift.y };
  }
  current = key;
  island = key.island;
  offset = { x: found.x, y: found.y };
  velocity = { x: 0, y: 0 };
  motion = there;
  joinListeners.forEach((fn) => fn(from, shift));
  jumpCandidate = null;
  badFrames = 0;
  lost = false;
}

function handBoxes(hands: { x: number; y: number }[][]): HandBox[] {
  return hands.map((lm) => {
    const xs = lm.map((p) => p.x * W);
    const ys = lm.map((p) => p.y * H);
    const margin = 6;
    return { x0: Math.min(...xs) - margin, y0: Math.min(...ys) - margin, x1: Math.max(...xs) + margin, y1: Math.max(...ys) + margin };
  });
}

function inBoxes(x: number, y: number, boxes: HandBox[]) {
  for (const b of boxes) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return true;
  return false;
}
