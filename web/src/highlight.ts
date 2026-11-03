import { isPhone } from "./camera";
import { FilesetResolver, InteractiveSegmenterLegacy } from "@mediapipe/tasks-vision";

// Finds the object under a point and draws it highlighted. Uses MediaPipe's "magic touch"
// interactive segmenter, which runs in the browser (no server needed).

type Box = { x: number; y: number; w: number; h: number };

// Measurements used to tell objects from background, logged so the limits can be tuned.
// edges: how many sides of the frame it touches. ragged: 1 = smooth round outline, higher = more jagged.
// contrast: color difference between the object and the area right around it (0..255).
// color: the object's average color [r, g, b], used to check a re-found outline is the same object.
// solid: how much of its bounding box it fills (a desk-shaped region full of gaps fills little).
// edge: share of its outline with a clear color step right across it (0..1).
type Shape = { coverage: number; edges: number; ragged: number; contrast: number; color: number[]; solid: number; edge: number };

export type HighlightResult =
  | ({ ok: true; ms: number; box: Box } & Shape)
  // no-object: nothing found. background: looks like a surface (desk, wall), not an object.
  // hand: the "object" contains your own finger. different: rejected by the caller's `accept` check.
  | ({ ok: false; reason: "no-object" | "background" | "hand" | "different"; ms: number } & Shape);

// Desk/wall patches are big, run off the edge of the frame, and have jagged outlines.
// Real objects are compact with smooth outlines. Anything past these limits counts as background.
// 12%: desk objects at webcam distance are under 5%; a real lock once grabbed egg + desk at ~20%.
const MAX_COVERAGE = 0.12;
const MAX_COVERAGE_AT_EDGE = 0.08; // touching one side of the frame is fine only for smaller things
const MAX_RAGGED = 4.5;
// On a plain surface the model returns a neat little blob that looks just like its surroundings.
// A real object looks different from what's right around it.
const MIN_CONTRAST = 20;
// Real objects fill most of their bounding box (an egg ~80%, a phone ~90%, a bottle ~70%).
const MIN_SOLID = 0.45;
const CUTOUT_MIN_SOLID = 0.3; // a thing Meta drew can be spindly: a watch on its chain

// Low contrast is forgiven only for something big, solid and smooth with a clear color step along this
// much of its outline: an average can't see a grey bag between a dark bed and a brown floor. On real
// frames, smaller or less solid things passing that test were patches of desk and floor.
const MIN_EDGE = 0.6;
const EDGE_MIN_COVERAGE = 0.05;
const EDGE_MIN_SOLID = 0.65;
const EDGE_MAX_RAGGED = 2.5;
// A big object: allowed up to this much of the view only if it's compact, smooth and clearly outlined,
// which the floor and desk patches this limit exists for are not.
const MAX_COVERAGE_BIG = 0.3;
const BIG_MIN_SOLID = 0.6;
const BIG_MAX_RAGGED = 3;
const BIG_MIN_EDGE = 0.7;

export type HighlightColor = "blue" | "green";
const BORDERS: Record<HighlightColor, number[]> = {
  blue: [8, 102, 255, 255], // choosing
  green: [48, 209, 88, 255], // locked
};

let segmenter: InteractiveSegmenterLegacy | null = null;

// The current highlight: a painted canvas for drawing, plus which pixels are the object.
let maskCanvas: HTMLCanvasElement | null = null;
let objectPixels: Uint8Array | null = null;
let maskW = 0;
let maskH = 0;
let currentBox: Box | null = null;
let currentColor: HighlightColor = "blue";
let currentMean: number[] | null = null; // the object's average color
// A point that's on the object (near its middle), used to re-find its outline after it moves.
let seed: { x: number; y: number } | null = null;
// How far the object has moved since its outline was found (0..1 of frame). Drawing, the box,
// and isOnHighlight all shift by this, so the highlight follows the object when the camera moves.
let offset = { x: 0, y: 0 };
// Total distance the object has moved across frames (0..1 of frame), added up step by step while
// following. Unlike `offset`, re-finding the outline doesn't reset or jump it, so edits pinned to
// the scene (an erase patch, a moved object) use this.
let motion = { x: 0, y: 0 };

export async function initHighlighter(): Promise<"GPU" | "CPU"> {
  const vision = await FilesetResolver.forVisionTasks("/mediapipe");
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/models/magic_touch.tflite", delegate },
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });

  let delegate: "GPU" | "CPU" = "GPU";
  try {
    segmenter = await InteractiveSegmenterLegacy.createFromOptions(vision, options("GPU"));
  } catch {
    segmenter = await InteractiveSegmenterLegacy.createFromOptions(vision, options("CPU"));
    delegate = "CPU";
  }

  // The first run is slow (~2 s) while the GPU warms up. Do it now on a blank image,
  // so the first real highlight doesn't freeze the video. Use the same size we segment at:
  // warming up on a tiny image changed later GPU results in testing (tools/replay).
  const blank = document.createElement("canvas");
  blank.width = WORK_WIDTH;
  blank.height = Math.round((WORK_WIDTH * 9) / 16);
  blank.getContext("2d")!.fillRect(0, 0, blank.width, blank.height);
  segmenter.segment(blank, { keypoint: { x: 0.5, y: 0.5 } }).close();

  return delegate;
}

// Segments the object at `point` (0..1 in the raw, unmirrored frame). `avoid` = points that must
// not be part of the object, e.g. the fingertip, so we never highlight the user's own hand.
// `accept` can veto a found object (e.g. when re-finding a moved object, it must be similar).
// On success this becomes the current highlight; on failure the current one is left alone.
export function highlightAt(
  source: TexImageSource,
  point: { x: number; y: number },
  avoid: { x: number; y: number }[] = [],
  accept?: (found: { box: Box } & Shape) => boolean,
): HighlightResult {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const empty = { coverage: 0, edges: 0, ragged: 0, contrast: 0, color: [0, 0, 0], solid: 0, edge: 0 };
  if (!segmenter) return { ok: false, reason: "no-object", ms: 0, ...empty };

  // Work on a smaller copy: the full 1280x720 frame took 110-130 ms per look on a phone,
  // mostly in our own per-pixel loops, and the outline doesn't need that much detail.
  const small = shrink(source);
  const result = segmenter.segment(small, { keypoint: point });
  const mask = result.categoryMask;
  if (!mask) {
    result.close();
    return { ok: false, reason: "no-object", ms: elapsed(), ...empty };
  }

  const w = mask.width;
  const h = mask.height;
  const data = mask.getAsUint8Array();
  const indexOf = (p: { x: number; y: number }) =>
    Math.min(h - 1, Math.max(0, Math.floor(p.y * h))) * w + Math.min(w - 1, Math.max(0, Math.floor(p.x * w)));
  // Whatever value the mask has under the point is "the object", whichever number the model uses.
  const target = data[indexOf(point)];

  // Keep only the connected piece under the point: the model sometimes adds separate bits
  // (patches of floor, other objects) that aren't part of what you pointed at.
  const inside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let count = 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  const seedIndex = indexOf(point);
  inside[seedIndex] = 1;
  queue[count++] = seedIndex;
  for (let head = 0; head < count; head++) {
    const i = queue[head];
    const x = i % w;
    const y = (i - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const n of next) {
      if (n >= 0 && !inside[n] && data[n] === target) {
        inside[n] = 1;
        queue[count++] = n;
      }
    }
  }
  result.close();

  if (count === 0) return { ok: false, reason: "no-object", ms: elapsed(), ...empty };

  // Outline length vs area. A circle scores 1, a bottle about 2, a jagged desk patch much more.
  let outline = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * w + x;
      if (inside[i] && isOutline(inside, i, x, y, w, h)) outline++;
    }
  }
  const shape: Shape = {
    coverage: count / (w * h),
    edges: Number(minX === 0) + Number(minY === 0) + Number(maxX === w - 1) + Number(maxY === h - 1),
    ragged: (outline * outline) / (4 * Math.PI * count),
    solid: count / ((maxX - minX + 1) * (maxY - minY + 1)),
    ...colorContrast(small, inside, w, h, { minX, minY, maxX, maxY }),
  };
  const clearlyBig =
    shape.edges === 0 && shape.coverage <= MAX_COVERAGE_BIG && shape.solid >= BIG_MIN_SOLID && shape.ragged <= BIG_MAX_RAGGED && shape.edge >= BIG_MIN_EDGE;
  const clearlyOutlined =
    shape.edge >= MIN_EDGE && shape.coverage >= EDGE_MIN_COVERAGE && shape.solid >= EDGE_MIN_SOLID && shape.ragged <= EDGE_MAX_RAGGED;
  const looksLikeBackground =
    (shape.coverage > MAX_COVERAGE && !clearlyBig) ||
    shape.edges >= 2 ||
    (shape.edges === 1 && shape.coverage > MAX_COVERAGE_AT_EDGE) ||
    shape.ragged > MAX_RAGGED ||
    (shape.contrast < MIN_CONTRAST && !clearlyOutlined) ||
    shape.solid < MIN_SOLID;
  if (looksLikeBackground) return { ok: false, reason: "background", ms: elapsed(), ...shape };
  if (avoid.some((p) => inside[indexOf(p)])) return { ok: false, reason: "hand", ms: elapsed(), ...shape };
  const box = { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h };
  if (accept && !accept({ box, ...shape })) return { ok: false, reason: "different", ms: elapsed(), ...shape };

  objectPixels = inside;
  maskW = w;
  maskH = h;
  currentBox = box;
  currentMean = shape.color;
  offset = { x: 0, y: 0 };
  seed = pointNearMiddle(inside, w, h, box);
  paint();
  captureTemplate(small, box, avoid);
  return { ok: true, ms: elapsed(), box, ...shape };
}

// The object under `point` in any picture, leaving the current highlight alone. null if it looks like
// background.
export function cutoutMask(source: TexImageSource, point: { x: number; y: number }): { pixels: Uint8Array; w: number; h: number } | null {
  if (!segmenter) return null;
  const result = segmenter.segment(shrink(source), { keypoint: point });
  const mask = result.categoryMask;
  if (!mask) {
    result.close();
    return null;
  }
  const w = mask.width;
  const h = mask.height;
  const data = mask.getAsUint8Array();
  const start = Math.min(h - 1, Math.max(0, Math.floor(point.y * h))) * w + Math.min(w - 1, Math.max(0, Math.floor(point.x * w)));
  const target = data[start];
  const pixels = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let count = 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  pixels[start] = 1;
  queue[count++] = start;
  for (let head = 0; head < count; head++) {
    const i = queue[head];
    const x = i % w;
    const y = (i - x) / w;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (n >= 0 && !pixels[n] && data[n] === target) {
        pixels[n] = 1;
        queue[count++] = n;
      }
    }
  }
  result.close();
  const edges = Number(minX === 0) + Number(minY === 0) + Number(maxX === w - 1) + Number(maxY === h - 1);
  const solid = count / ((maxX - minX + 1) * (maxY - minY + 1));
  return count / (w * h) > MAX_COVERAGE || edges > 0 || solid < CUTOUT_MIN_SOLID ? null : { pixels, w, h };
}

// Makes a border someone drew the current highlight, for things too big for highlightAt to accept.
// `points`: the closed outline, 0..1 of the frame. Returns its box, null if there's nothing inside.
export function highlightFromBorder(source: TexImageSource, points: { x: number; y: number }[]): Box | null {
  const small = shrink(source);
  const w = small.width;
  const h = small.height;
  const shape = document.createElement("canvas");
  shape.width = w;
  shape.height = h;
  const sctx = shape.getContext("2d", { willReadFrequently: true })!;
  sctx.beginPath();
  points.forEach((p, i) => (i ? sctx.lineTo(p.x * w, p.y * h) : sctx.moveTo(p.x * w, p.y * h)));
  sctx.closePath();
  sctx.fill();
  const alpha = sctx.getImageData(0, 0, w, h).data;
  const inside = new Uint8Array(w * h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[(y * w + x) * 4 + 3] < 128) continue;
      inside[y * w + x] = 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;
  const box = { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h };
  objectPixels = inside;
  maskW = w;
  maskH = h;
  currentBox = box;
  currentMean = colorContrast(small, inside, w, h, { minX, minY, maxX, maxY }).color;
  offset = { x: 0, y: 0 };
  seed = pointNearMiddle(inside, w, h, box);
  template = null;
  paint();
  return box;
}

// The object pixel closest to the middle of its box (the exact middle may be off the object,
// e.g. for an L-shaped thing).
function pointNearMiddle(inside: Uint8Array, w: number, h: number, box: Box) {
  const cx = Math.floor((box.x + box.w / 2) * w);
  const cy = Math.floor((box.y + box.h / 2) * h);
  if (inside[cy * w + cx]) return { x: (cx + 0.5) / w, y: (cy + 0.5) / h };
  let best = { x: cx, y: cy, d: Infinity };
  for (let y = Math.floor(box.y * h); y < Math.ceil((box.y + box.h) * h); y++) {
    for (let x = Math.floor(box.x * w); x < Math.ceil((box.x + box.w) * w); x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (inside[y * w + x] && d < best.d) best = { x, y, d };
    }
  }
  return { x: (best.x + 0.5) / w, y: (best.y + 0.5) / h };
}

// ---------- Following the object when the camera moves ----------
// When an outline is found we keep a small grayscale picture of the object (the "template").
// Each frame we look around its last position for the spot that looks most like it.

const TRACK_WIDTH = 240; // track on a frame this wide: enough detail, still fast on a phone
const SEARCH = 36; // how far to look each frame, in track pixels (15% of the frame each way)
// Average brightness difference (0..255) above which the best spot doesn't count as a match.
const MAX_MATCH_DIFF = 40;
// The template compares the object plus a ring this many track pixels wide around it: the
// object's outline against the background is what makes it findable.
const RING = 2;
// Ignore everything this close (0..1 of frame) to the pointing finger when the template is taken:
// the finger is right next to the object while locking, then moves away.
const HAND_RADIUS = 0.05;

let trackCanvas: HTMLCanvasElement | null = null;
let template: {
  // Only the pixels worth comparing, as offsets inside the template box plus their brightness.
  px: Int16Array;
  py: Int16Array;
  value: Uint8Array;
  w: number;
  h: number;
  x: number; // current top-left, in track pixels
  y: number;
  x0: number; // top-left when the outline was found
  y0: number;
  frameW: number;
  frameH: number;
  frameMean: number; // average brightness of the whole frame when the template was taken
} | null = null;

function grayFrame(source: TexImageSource) {
  const { w, h } = sizeOf(source);
  const tw = TRACK_WIDTH;
  const th = Math.max(1, Math.round((tw * (h || 1)) / (w || 1)));
  trackCanvas ??= document.createElement("canvas");
  trackCanvas.width = tw;
  trackCanvas.height = th;
  const tctx = trackCanvas.getContext("2d", { willReadFrequently: !isPhone })!;
  tctx.drawImage(source as CanvasImageSource, 0, 0, tw, th);
  const rgba = tctx.getImageData(0, 0, tw, th).data;
  const gray = new Uint8Array(tw * th);
  let total = 0;
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (rgba[i * 4] + 2 * rgba[i * 4 + 1] + rgba[i * 4 + 2]) >> 2;
    total += gray[i];
  }
  return { gray, w: tw, h: th, mean: total / gray.length };
}

// Takes the template from the current object outline (objectPixels). `avoid` = points near the
// pointing finger, which are left out.
function captureTemplate(source: TexImageSource, box: Box, avoid: { x: number; y: number }[]) {
  if (!objectPixels) return;
  const f = grayFrame(source);
  const ringX = RING / f.w;
  const ringY = RING / f.h;
  const x0 = Math.max(0, Math.floor((box.x - ringX) * f.w));
  const y0 = Math.max(0, Math.floor((box.y - ringY) * f.h));
  const x1 = Math.min(f.w, Math.ceil((box.x + box.w + ringX) * f.w));
  const y1 = Math.min(f.h, Math.ceil((box.y + box.h + ringY) * f.h));

  // Is the object at this point (0..1 of frame), or within RING track pixels of it?
  const objectAt = (nx: number, ny: number) => {
    const mx = Math.floor(nx * maskW);
    const my = Math.floor(ny * maskH);
    return mx >= 0 && my >= 0 && mx < maskW && my < maskH && objectPixels![my * maskW + mx] === 1;
  };
  const nearObject = (nx: number, ny: number) => {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      if (objectAt(nx + dx * ringX, ny + dy * ringY)) return true;
    }
    return false;
  };
  const nearFinger = (nx: number, ny: number) => avoid.some((p) => Math.hypot(p.x - nx, p.y - ny) < HAND_RADIUS);

  const px: number[] = [];
  const py: number[] = [];
  const value: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const nx = (x + 0.5) / f.w;
      const ny = (y + 0.5) / f.h;
      if (!nearObject(nx, ny) || nearFinger(nx, ny)) continue;
      px.push(x - x0);
      py.push(y - y0);
      value.push(f.gray[y * f.w + x]);
    }
  }
  // A tiny object (or one mostly hidden by the finger) gives too few pixels to match reliably.
  if (px.length < 20) {
    template = null;
    return;
  }
  template = {
    px: Int16Array.from(px),
    py: Int16Array.from(py),
    value: Uint8Array.from(value),
    w: x1 - x0,
    h: y1 - y0,
    x: x0,
    y: y0,
    x0,
    y0,
    frameW: f.w,
    frameH: f.h,
    frameMean: f.mean,
  };
}

// Finds where the highlighted object is now and moves the highlight there. Call once per new
// camera frame. `matched` is false when nothing nearby looks like it (object gone or camera moved
// too fast); the highlight then stays where it was.
export function followHighlight(source: TexImageSource): { matched: boolean; diff: number } | null {
  if (!template) return null;
  const t = template;
  const f = grayFrame(source);
  if (f.w !== t.frameW || f.h !== t.frameH) return null; // camera changed size
  // The camera re-adjusts exposure as it moves, making everything brighter or darker.
  // Cancel that out so it doesn't look like the object changed.
  const brightness = Math.round(f.mean - t.frameMean);
  const n = t.value.length;

  // Average difference between the template and the frame at top-left (ox, oy). Stops early once
  // it's already worse than `limit`, which skips most of the work for bad spots.
  const diffAt = (ox: number, oy: number, limit: number) => {
    if (ox < 0 || oy < 0 || ox + t.w > f.w || oy + t.h > f.h) return Infinity;
    const stop = limit * n;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += Math.abs(f.gray[(oy + t.py[k]) * f.w + ox + t.px[k]] - brightness - t.value[k]);
      if ((k & 63) === 63 && sum > stop) return Infinity;
    }
    return sum / n;
  };

  // Coarse search every 2 pixels, then fine-tune around the best spot.
  let best = { x: t.x, y: t.y, d: diffAt(t.x, t.y, Infinity) };
  for (let dy = -SEARCH; dy <= SEARCH; dy += 2) {
    for (let dx = -SEARCH; dx <= SEARCH; dx += 2) {
      const d = diffAt(t.x + dx, t.y + dy, best.d);
      if (d < best.d) best = { x: t.x + dx, y: t.y + dy, d };
    }
  }
  const coarse = best;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const d = diffAt(coarse.x + dx, coarse.y + dy, best.d);
      if (d < best.d) best = { x: coarse.x + dx, y: coarse.y + dy, d };
    }
  }

  if (best.d > MAX_MATCH_DIFF) return { matched: false, diff: best.d };
  motion = { x: motion.x + (best.x - t.x) / t.frameW, y: motion.y + (best.y - t.y) / t.frameH };
  t.x = best.x;
  t.y = best.y;
  offset = { x: (t.x - t.x0) / t.frameW, y: (t.y - t.y0) / t.frameH };
  return { matched: true, diff: best.d };
}

// How far the followed object has moved in total (0..1 of frame). See `motion`.
export function sceneMotion(): { x: number; y: number } {
  return { ...motion };
}

// A point on the object where it is now (for re-finding its outline after it moved).
// The highlighted object's average color [r, g, b].
export function highlightMeanColor(): number[] | null {
  return currentMean;
}

export function highlightSeed(): { x: number; y: number } | null {
  return seed && { x: seed.x + offset.x, y: seed.y + offset.y };
}

let smallCanvas: HTMLCanvasElement | null = null;
const WORK_WIDTH = 640;

function sizeOf(source: TexImageSource) {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
  if (source instanceof HTMLImageElement) return { w: source.naturalWidth, h: source.naturalHeight };
  if ("displayWidth" in source) return { w: source.displayWidth, h: source.displayHeight }; // VideoFrame
  return { w: source.width, h: source.height };
}

// Copies the frame into a canvas WORK_WIDTH pixels wide (same shape).
function shrink(source: TexImageSource): HTMLCanvasElement {
  const { w, h } = sizeOf(source);
  smallCanvas ??= document.createElement("canvas");
  smallCanvas.width = Math.min(WORK_WIDTH, w || WORK_WIDTH);
  smallCanvas.height = Math.max(1, Math.round((smallCanvas.width * (h || 1)) / (w || 1)));
  smallCanvas.getContext("2d", { willReadFrequently: true })!.drawImage(source as CanvasImageSource, 0, 0, smallCanvas.width, smallCanvas.height);
  return smallCanvas;
}

let sampleCanvas: HTMLCanvasElement | null = null;
const SAMPLE_WIDTH = 256;

// Average color of the object vs. a band just around it, compared on a small copy of the frame.
function colorContrast(
  source: TexImageSource,
  inside: Uint8Array,
  w: number,
  h: number,
  b: { minX: number; minY: number; maxX: number; maxY: number },
): { contrast: number; color: number[]; edge: number } {
  const sw = SAMPLE_WIDTH;
  const sh = Math.max(1, Math.round((SAMPLE_WIDTH * h) / w));
  sampleCanvas ??= document.createElement("canvas");
  sampleCanvas.width = sw;
  sampleCanvas.height = sh;
  const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(source as CanvasImageSource, 0, 0, sw, sh);
  const pixels = sctx.getImageData(0, 0, sw, sh).data;

  // The band: the object's box grown by a quarter of its size (at least 3 sample pixels).
  const toS = (v: number, size: number, ssize: number) => Math.floor((v / size) * ssize);
  const padX = Math.max(3, Math.round((toS(b.maxX - b.minX, w, sw) + 1) / 4));
  const padY = Math.max(3, Math.round((toS(b.maxY - b.minY, h, sh) + 1) / 4));
  const x0 = Math.max(0, toS(b.minX, w, sw) - padX);
  const x1 = Math.min(sw - 1, toS(b.maxX, w, sw) + padX);
  const y0 = Math.max(0, toS(b.minY, h, sh) - padY);
  const y1 = Math.min(sh - 1, toS(b.maxY, h, sh) + padY);

  const sumIn = [0, 0, 0];
  const sumOut = [0, 0, 0];
  let nIn = 0;
  let nOut = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const isIn = inside[Math.floor((y / sh) * h) * w + Math.floor((x / sw) * w)];
      const sum = isIn ? sumIn : sumOut;
      const p = (y * sw + x) * 4;
      sum[0] += pixels[p];
      sum[1] += pixels[p + 1];
      sum[2] += pixels[p + 2];
      if (isIn) nIn++;
      else nOut++;
    }
  }
  const color = nIn ? sumIn.map((v) => v / nIn) : [0, 0, 0];
  const edge = edgeShare(pixels, sw, sh, inside, w, h);
  if (!nIn || !nOut) return { contrast: 255, color, edge }; // nothing to compare against, don't reject on this
  return { contrast: Math.hypot(color[0] - sumOut[0] / nOut, color[1] - sumOut[1] / nOut, color[2] - sumOut[2] / nOut), color, edge };
}

// How much of the outline has a clear color step across it, a little way in against a little way out.
// Averages can't see a grey bag between a dark bed and a brown floor; this can. A patch of plain desk
// has no step anywhere.
const EDGE_REACH = 2; // sample pixels each side of the outline
const EDGE_STEP = 40; // color distance (0..441) that counts as a clear step
function edgeShare(pixels: Uint8ClampedArray, sw: number, sh: number, inside: Uint8Array, w: number, h: number) {
  const isIn = (x: number, y: number) => x >= 0 && y >= 0 && x < sw && y < sh && !!inside[Math.floor((y / sh) * h) * w + Math.floor((x / sw) * w)];
  let outline = 0;
  let steps = 0;
  for (let y = EDGE_REACH; y < sh - EDGE_REACH; y++) {
    for (let x = EDGE_REACH; x < sw - EDGE_REACH; x++) {
      if (!isIn(x, y)) continue;
      let top = -1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (isIn(x + dx, y + dy)) continue;
        const a = ((y - dy * (EDGE_REACH - 1)) * sw + x - dx * (EDGE_REACH - 1)) * 4;
        const b = ((y + dy * EDGE_REACH) * sw + x + dx * EDGE_REACH) * 4;
        top = Math.max(top, Math.hypot(pixels[a] - pixels[b], pixels[a + 1] - pixels[b + 1], pixels[a + 2] - pixels[b + 2]));
      }
      if (top < 0) continue;
      outline++;
      if (top > EDGE_STEP) steps++;
    }
  }
  return outline ? steps / outline : 0;
}

function isOutline(inside: Uint8Array, i: number, x: number, y: number, w: number, h: number) {
  return x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inside[i - 1] || !inside[i + 1] || !inside[i - w] || !inside[i + w];
}

// Paints only the current object's border, in the current color, into a canvas the size of the mask.
function paint() {
  if (!objectPixels || !currentBox) return;
  const w = maskW;
  const h = maskH;
  maskCanvas ??= document.createElement("canvas");
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext("2d")!;
  const image = mctx.createImageData(w, h);
  const border = BORDERS[currentColor];
  const x0 = Math.floor(currentBox.x * w);
  const y0 = Math.floor(currentBox.y * h);
  const x1 = Math.min(w - 1, Math.ceil((currentBox.x + currentBox.w) * w));
  const y1 = Math.min(h - 1, Math.ceil((currentBox.y + currentBox.h) * h));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (!objectPixels[i] || !isOutline(objectPixels, i, x, y, w, h)) continue;
      // 3 mask pixels thick, so it still shows when the mask is scaled to the screen.
      for (let py = Math.max(0, y - 1); py <= Math.min(h - 1, y + 1); py++) {
        for (let px = Math.max(0, x - 1); px <= Math.min(w - 1, x + 1); px++) {
          image.data.set(border, (py * w + px) * 4);
        }
      }
    }
  }
  mctx.putImageData(image, 0, 0);
}

// Blue while choosing, green once locked.
export function setHighlightColor(color: HighlightColor) {
  if (color === currentColor) return;
  currentColor = color;
  paint();
}

// Is this point on the currently highlighted object? `margin` (0..1 of frame) also accepts
// points just outside its edge, so small hand wobbles don't count as leaving it.
export function isOnHighlight(at: { x: number; y: number }, margin = 0.03): boolean {
  if (!objectPixels || !currentBox) return false;
  // The stored outline is where the object was when found; undo how far it has moved since.
  const point = { x: at.x - offset.x, y: at.y - offset.y };
  const b = currentBox;
  if (point.x < b.x - margin || point.x > b.x + b.w + margin || point.y < b.y - margin || point.y > b.y + b.h + margin) {
    return false;
  }
  // Check the point and a small ring around it against the object's pixels.
  const r = Math.ceil(margin * maskW);
  const cx = Math.floor(point.x * maskW);
  const cy = Math.floor(point.y * maskH);
  for (let dy = -r; dy <= r; dy += Math.max(1, Math.floor(r / 3))) {
    for (let dx = -r; dx <= r; dx += Math.max(1, Math.floor(r / 3))) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && y >= 0 && x < maskW && y < maskH && objectPixels[y * maskW + x]) return true;
    }
  }
  return false;
}

// Puts the object's outline where something else says it is now (keeping its size), instead of
// following it: for a locked object whose place is known from the room around it.
export function moveHighlightTo(center: { x: number; y: number }) {
  if (!currentBox) return;
  offset = { x: center.x - currentBox.x - currentBox.w / 2, y: center.y - currentBox.y - currentBox.h / 2 };
}

// The object's box where it is now.
export function highlightBox(): Box | null {
  return currentBox && { ...currentBox, x: currentBox.x + offset.x, y: currentBox.y + offset.y };
}

// The object's exact shape where it is now: a canvas (white = object, transparent elsewhere) the
// size of the mask, plus how far to shift it (0..1 of frame). Used to erase it in the virtual view.
export function objectShape(): { canvas: HTMLCanvasElement; offset: { x: number; y: number } } | null {
  if (!objectPixels) return null;
  return { canvas: maskToCanvas(objectPixels, maskW, maskH), offset: { ...offset } };
}

// A copy of the object's outline (1 = object) and how far it's shifted (0..1 of frame), so it can
// be remembered after the highlight moves on to another object.
export function objectMask(): { pixels: Uint8Array; w: number; h: number; offset: { x: number; y: number } } | null {
  if (!objectPixels) return null;
  return { pixels: objectPixels.slice(), w: maskW, h: maskH, offset: { ...offset } };
}

// Paints a mask (1 = object) into a canvas: `outline` = only its edge, otherwise filled.
export function maskToCanvas(pixels: Uint8Array, w: number, h: number, color = [255, 255, 255, 255], outline = false) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const sctx = canvas.getContext("2d")!;
  const image = sctx.createImageData(w, h);
  for (let i = 0; i < pixels.length; i++) {
    if (!pixels[i]) continue;
    if (outline && !isOutline(pixels, i, i % w, Math.floor(i / w), w, h)) continue;
    image.data.set(color, i * 4);
  }
  sctx.putImageData(image, 0, 0);
  return canvas;
}

export function clearHighlight() {
  maskCanvas = null;
  objectPixels = null;
  currentBox = null;
  currentColor = "blue";
  seed = null;
  template = null;
  offset = { x: 0, y: 0 };
}

// Draws the current highlight over the video. `mirrored` flips it to match a mirrored video.
export function drawHighlight(ctx: CanvasRenderingContext2D, mirrored: boolean) {
  if (!maskCanvas) return;
  const { width, height } = ctx.canvas;
  ctx.save();
  if (mirrored) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(maskCanvas, offset.x * width, offset.y * height, width, height);
  ctx.restore();
}
