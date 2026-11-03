import { isPhone } from "./camera";
// Keeps a saved view lined up with the live camera, however the camera moves.
//
// sceneTracker only understands the picture sliding. That's a good first guess, but turning,
// tilting, rolling or stepping closer also stretches the picture. So each pin (one per saved view):
//   - remembers small textured spots of the saved view, chosen around what it's pinning;
//   - every camera frame, predicts where they are now, reshapes each spot the way the camera has
//     moved, and looks for it in the live picture;
//   - works out the stretch (a homography: how a flat surface looks from a new position) that best
//     explains where the spots turned up, ignoring those that disagree (a hand, a person, a nearby
//     object at another distance).
// Spots are always compared with the saved view, never with the last frame, so errors can't build
// up. Going out of view and coming back lands in the same place.

import { islandOf, onIslandsJoined } from "./sceneTracker";

const WORK_W = 320; // width of the gray copies, px
const MAX_POINTS = 60;
const TEMPLATE = 4; // a spot is this many px each way from its center
const NEAR = 4; // how far around the prediction a spot is looked for, px
const WIDE = 12; // the same, when the pin has lost its place
const WIDE_STEP = 2;
const MIN_MATCH = 0.7; // correlation (-1..1) a spot needs to count as found
const MIN_CORNER = 300; // corner strength below this is too plain to find again
// Spots as close as possible to what's being pinned (fractions of the frame's width): further away
// may be another surface, which moves differently as you walk.
const FOCUS_REACHES = [0.08, 0.16, 0.32];
const MIN_FOCUS_POINTS = 24; // fewer than this: look further out
const TRIES = 40; // guesses when sorting good spots from bad
// When another pin gave the prediction and this share of the spots are where it said, it's right and
// the others are on something moving, even if they could agree among themselves (someone walking past).
const TRUST_SHARE = 0.3;
const TRUST_MIN = 10;
const GUESS_TOLERANCE = 2.2; // px
const FIT_TOLERANCE = 1.4; // px
const MIN_SPOTS = 4; // fewer agreeing spots than this: trust the prediction this frame
const MIN_SPOTS_WIDE = 10; // finding the place again takes more
const FULL_FIT_SPOTS = 8; // fewer than this: only slide, don't stretch
// How strongly one frame's stretch is held back. Few or bunched-up spots can't say much about the
// stretch, so they barely change it; plenty of spread-out spots override this easily.
const SHAPE_HOLD = 0.2;
const PERSPECTIVE_HOLD = 0.05;
const MIN_SCALE = 0.35; // how much bigger or smaller than the saved view makes sense
const MAX_SCALE = 3.5;
const AWAY_FRAMES = 15; // lost this long: stop showing it, a fix in the wrong place looks worse than none
const MIN_IN_VIEW = 10; // this many of its spots in view, and none of them found: it's lost
const RETRY_EVERY = 3; // a lost pin looks around the last place every this many frames
const SEARCH_EVERY = 12; // and searches the whole picture every this many
const COARSE = 4; // that search works on a copy this many times smaller: smoother, so it can't step over the place
const SEARCH_SPOTS = 30;
// Share of the spots in view that must agree. A fit that a few spots agree on by chance fails this.
const MIN_SHARE_WIDE = 0.3; // finding the place again
const MIN_SHARE = 0.15; // keeping it: someone may be standing in front of most of them
// The camera may have stepped closer or back while it was lost, and a hand never brings it back at the
// same angle (at 8 degrees off, the search never found its place again).
const SEARCH_POSES = [
  { size: 1, angle: 0 },
  { size: 1, angle: 8 },
  { size: 1, angle: -8 },
  { size: 0.85, angle: 0 },
  { size: 1.18, angle: 0 },
  { size: 1, angle: 16 },
  { size: 1, angle: -16 },
];
const MIN_LEAD_SPOTS = 12; // a pin needs this many to tell the others how the camera moved
const MAX_CHANGED = 0.6; // nearly everything around a pin differs: its place is wrong, or the light changed
const MIN_GAIN = 0.65; // how much brighter or darker than the saved view we'll follow
const MAX_GAIN = 1.5;
// A change smaller than this (px, at the pin's corners) is mostly measurement noise: only part of it
// is taken, so a still camera gives a still picture. Bigger changes are taken whole, with no lag.
const STEADY_PX = 2;
// Something has come in front of a saved view's spot when the live picture differs from it by this
// much (brightness, 0..255) at every nearby position, so a slightly wrong edge doesn't count.
const CHANGED = 30;
const CHANGE_MARGIN = 30; // px around what's pinned where it matters

type Matrix = number[]; // 9 numbers, row by row

export interface Pin {
  gray: Float32Array; // the saved view, small
  coarse?: Float32Array; // smaller still, for the whole-picture search
  points: { x: number; y: number }[]; // spots in it, around what's pinned
  allPoints: { x: number; y: number }[]; // spots from the whole view
  region: { x: number; y: number }[]; // the corners of what's being pinned
  focused: boolean; // we know what's being pinned
  matrix: Matrix; // saved view -> live, in small pixels
  motionAt: { x: number; y: number }; // scene motion the matrix belongs to
  spots: number; // how many spots agreed in the last frame
  missed: number; // frames in a row with no fit
  blind: number; // frames in a row with its spots in view but not found
  velocity: Matrix | null; // how its matrix changed last frame, while it was tracking
  searches: number; // whole-picture searches so far, to take turns with sizes
  away: boolean; // lost: don't show it
  gain: number; // live brightness / saved brightness around it
}

interface Spot {
  qx: number; // predicted
  qy: number;
  fx: number; // found
  fy: number;
  brightness: number; // live average / saved average
}

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: !isPhone })!;
let W = WORK_W;
let H = 180;
let pins: Pin[] = [];
let lastMs = 0;
let lastLive: Float32Array | null = null;

onIslandsJoined((from, shift) => {
  for (const pin of pins) {
    if (islandOf(pin.motionAt) !== from) continue;
    pin.motionAt = { x: pin.motionAt.x - shift.x, y: pin.motionAt.y - shift.y };
  }
});

export function clearPins() {
  pins = [];
}

export function removePin(pin: Pin) {
  pins = pins.filter((p) => p !== pin);
}

// Starts a pin on a saved view. `motionAt` = scene motion when that frame was taken. `avoid(x, y)`
// (0..1 of frame) says what can't be used, such as a person, who won't stay put.
export function createPin(frame: HTMLCanvasElement, motionAt: { x: number; y: number }, avoid: ((x: number, y: number) => boolean) | null): Pin {
  const height = Math.round((WORK_W * frame.height) / frame.width);
  if (height !== H) {
    H = height;
    pins = [];
  }
  const gray = grayOf(frame);
  const allPoints = pickPoints(gray, avoid, null, 0);
  const pin: Pin = {
    gray,
    points: allPoints,
    allPoints,
    region: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }],
    focused: false,
    matrix: IDENTITY.slice(),
    motionAt: { ...motionAt },
    spots: 0,
    missed: 0,
    blind: 0,
    velocity: null,
    searches: 0,
    away: false,
    gain: 1,
  };
  pins.push(pin);
  return pin;
}

// Now we know what's being pinned (`mask`: frame-sized, solid where it is): use spots around it, so
// the stretch fits that surface rather than something further back.
export function focusPin(pin: Pin, mask: HTMLCanvasElement, avoid: ((x: number, y: number) => boolean) | null) {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(mask, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  // A running total over the picture: "is there any mask within this square" in four lookups.
  const sums = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const on = data[(y * W + x) * 4 + 3] > 128 ? 1 : 0;
      sums[(y + 1) * (W + 1) + x + 1] = on + sums[y * (W + 1) + x + 1] + sums[(y + 1) * (W + 1) + x] - sums[y * (W + 1) + x];
    }
  }
  let x0 = W;
  let y0 = H;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] <= 128) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  pin.focused = true;
  if (x1 > x0 && y1 > y0) pin.region = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const nearMask = (x: number, y: number, reach: number) => {
    const x0 = Math.max(0, x - reach);
    const y0 = Math.max(0, y - reach);
    const x1 = Math.min(W, x + reach + 1);
    const y1 = Math.min(H, y + reach + 1);
    return sums[y1 * (W + 1) + x1] - sums[y0 * (W + 1) + x1] - sums[y1 * (W + 1) + x0] + sums[y0 * (W + 1) + x0] > 0;
  };
  for (const reach of FOCUS_REACHES) {
    const points = pickPoints(pin.gray, avoid, nearMask, Math.round(reach * W));
    if (points.length >= MIN_FOCUS_POINTS) {
      pin.points = points;
      return;
    }
  }
  // Too plain around it: keep the spots from the whole view.
}

// Call once per new camera frame, after trackScene, with its sceneMotion().
export function trackPins(frame: HTMLCanvasElement, motion: { x: number; y: number }) {
  if (!pins.length) return;
  const started = performance.now();
  const live = grayOf(frame);
  lastLive = live;
  // The surest pin goes first and tells the others how the camera moved this frame, including the
  // turning and zooming scene motion can't see. Turning stretches the whole picture the same way,
  // so a pin that's out of view keeps up too.
  let lead: Matrix | null = null;
  for (const pin of [...pins].sort((a, b) => b.spots - a.spots)) {
    const before = pin.matrix;
    const wasSteady = pin.missed === 0 && pin.spots >= MIN_LEAD_SPOTS;
    trackOne(pin, live, motion, lead);
    if (!lead && wasSteady && pin.missed === 0 && pin.spots >= MIN_LEAD_SPOTS) {
      const back = invert(before);
      if (back) lead = multiply(pin.matrix, back);
    }
  }
  lastMs = performance.now() - started;
}

// Marks the pixels of the last frame that differ from what the pins' saved views say should be
// there, around what's pinned: something has come in front. Returns the small copy's size too.
export function findChanges(): { changed: Uint8Array; w: number; h: number } | null {
  if (!lastLive) return null;
  const live = lastLive;
  const changed = new Uint8Array(W * H);
  for (const pin of pins) {
    if (pin.away || !pin.focused) continue;
    const back = invert(pin.matrix);
    if (!back) continue;
    const x0 = pin.region[0].x - CHANGE_MARGIN;
    const y0 = pin.region[0].y - CHANGE_MARGIN;
    const x1 = pin.region[2].x + CHANGE_MARGIN;
    const y1 = pin.region[2].y + CHANGE_MARGIN;
    const mine: number[] = [];
    let checked = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const z = back[6] * x + back[7] * y + back[8];
        if (z < 1e-6) continue;
        const sx = Math.round((back[0] * x + back[1] * y + back[2]) / z);
        const sy = Math.round((back[3] * x + back[4] * y + back[5]) / z);
        if (sx < x0 || sy < y0 || sx > x1 || sy > y1 || sx < 1 || sy < 1 || sx >= W - 1 || sy >= H - 1) continue;
        checked++;
        const v = live[y * W + x] / pin.gain;
        const i = sy * W + sx;
        const g = pin.gray;
        if (
          Math.abs(v - g[i]) > CHANGED && Math.abs(v - g[i - 1]) > CHANGED && Math.abs(v - g[i + 1]) > CHANGED &&
          Math.abs(v - g[i - W]) > CHANGED && Math.abs(v - g[i + W]) > CHANGED
        ) mine.push(y * W + x);
      }
    }
    if (mine.length > checked * MAX_CHANGED) continue;
    for (const p of mine) changed[p] = 1;
  }
  return { changed, w: W, h: H };
}

// For the stats line.
export function pinStats() {
  return { ms: lastMs, spots: pins.map((p) => (p.away ? "away" : String(p.spots))).join(" ") };
}

// Saved view -> live picture, both 0..1 of the frame. null while it's lost.
export function pinMatrix(pin: Pin): Matrix | null {
  if (pin.away) return null;
  const m = pin.matrix;
  // The same matrix, measured in fractions of the frame instead of small pixels.
  return [m[0], (m[1] * H) / W, m[2] / W, (m[3] * W) / H, m[4], m[5] / H, m[6] * W, m[7] * H, m[8]];
}

// Where a spot of the saved view (0..1 of frame) is now. null while the pin is lost.
export function pinPoint(pin: Pin, x: number, y: number): { x: number; y: number } | null {
  if (pin.away) return null;
  const p = apply(pin.matrix, x * W, y * H);
  return p && { x: p.x / W, y: p.y / H };
}

function trackOne(pin: Pin, live: Float32Array, motion: { x: number; y: number }, lead: Matrix | null) {
  const sameIsland = islandOf(pin.motionAt) === islandOf(motion);
  const slid = sameIsland
    ? multiply([1, 0, (motion.x - pin.motionAt.x) * W, 0, 1, (motion.y - pin.motionAt.y) * H, 0, 0, 1], pin.matrix)
    : pin.matrix;
  const led = lead && multiply(lead, pin.matrix);
  // A pin that's tracking trusts its own movement: scene motion can be fooled by someone walking past,
  // which would throw every pin off at once. It's the fallback, and for pins out of view.
  const own = pin.missed === 0 && pin.velocity ? multiply(pin.velocity, pin.matrix) : null;
  // Another pin's movement comes first if there is one: it was measured on this very frame.
  const guesses = [led, own, slid, pin.missed > 0 ? pin.matrix : null].filter((m): m is Matrix => !!m && sensible(m));
  const best = guesses[0] ?? slid;
  const wide = pin.missed > 0 || pin.away;

  let next: Matrix | null = null;
  let fit: ReturnType<typeof fitChange> = null;
  let inView = 0;
  const attempt = (from: Matrix) => {
    // The spots around what's pinned first. If they can't settle it (out of view, too plain), the rest
    // of the room can.
    for (const points of pin.points === pin.allPoints ? [pin.points] : [pin.points, pin.allPoints]) {
      const found = lookForSpots(pin, points, live, from, wide);
      inView = Math.max(inView, spotsInView);
      const f = found.length >= MIN_SPOTS ? fitChange(found, from === led) : null;
      if (!f || f.spots < (wide || points !== pin.points ? MIN_SPOTS_WIDE : MIN_SPOTS)) continue;
      if (f.spots < spotsInView * (wide ? MIN_SHARE_WIDE : MIN_SHARE)) continue;
      const m = multiply(f.change, from);
      if (!sensible(m)) continue;
      next = m;
      fit = f;
      return true;
    }
    return false;
  };
  if (!wide || pin.missed % RETRY_EVERY === 0) guesses.some(attempt);
  if (!next && wide && pin.missed % SEARCH_EVERY === SEARCH_EVERY - 1) {
    const place = searchEverywhere(pin, live, best);
    if (place) attempt(place);
  }

  if (next && fit) {
    const before = pin.matrix;
    const done: { spots: number; gain: number } = fit;
    pin.matrix = wide ? normalize(next) : steadied(pin, normalize(next));
    const back = invert(before);
    pin.velocity = !wide && back ? normalize(multiply(pin.matrix, back)) : null;
    pin.motionAt = { ...motion };
    pin.spots = done.spots;
    pin.missed = 0;
    pin.blind = 0;
    pin.away = false;
    // Webcams change their exposure as they move: the patch should follow.
    pin.gain += (Math.max(MIN_GAIN, Math.min(MAX_GAIN, done.gain)) - pin.gain) * 0.1;
    return;
  }
  pin.spots = 0;
  pin.missed++;
  pin.velocity = null;
  if (!wide || pin.missed % RETRY_EVERY === 1) pin.blind = inView >= MIN_IN_VIEW ? pin.blind + (wide ? RETRY_EVERY : 1) : 0;
  if (sameIsland || led) {
    // Out of view, or a blurred frame: the prediction is the best we've got.
    pin.matrix = normalize(led && sensible(led) ? led : slid);
    pin.motionAt = { ...motion };
    if (pin.blind === 0) pin.away = false;
  }
  // It comes back when it's found again.
  if (pin.blind >= AWAY_FRAMES || (!sameIsland && !led && pin.missed >= AWAY_FRAMES)) pin.away = true;
}

// A lost pin looks for itself all over the live picture, on smaller, smoother copies: where do its
// spots fit best, if the view has only slid? Returns that place, to be checked properly. Tries one
// size per search.
function searchEverywhere(pin: Pin, live: Float32Array, from: Matrix): Matrix | null {
  const { size, angle } = SEARCH_POSES[pin.searches++ % SEARCH_POSES.length];
  const a = (size * Math.cos((angle * Math.PI) / 180));
  const b = (size * Math.sin((angle * Math.PI) / 180));
  // Around the middle of the picture.
  const base = multiply([a, -b, W / 2 - a * (W / 2) + b * (H / 2), b, a, H / 2 - b * (W / 2) - a * (H / 2), 0, 0, 1], from);
  const cw = Math.floor(W / COARSE);
  const ch = Math.floor(H / COARSE);
  const saved = (pin.coarse ??= shrink(pin.gray));
  const now = shrink(live);
  // A few spots spread out, each with the 3 x 3 small pixels around it, without their brightness.
  const spots: { x: number; y: number; values: number[] }[] = [];
  const stride = Math.max(1, Math.floor(pin.allPoints.length / SEARCH_SPOTS));
  for (let n = 0; n < pin.allPoints.length; n += stride) {
    const p = pin.allPoints[n];
    const q = apply(base, p.x, p.y);
    if (!q) continue;
    const sx = Math.round(p.x / COARSE);
    const sy = Math.round(p.y / COARSE);
    if (sx < 1 || sy < 1 || sx >= cw - 1 || sy >= ch - 1) continue;
    const values: number[] = [];
    let mean = 0;
    for (let v = -1; v <= 1; v++) {
      for (let u = -1; u <= 1; u++) {
        values.push(saved[(sy + v) * cw + sx + u]);
        mean += saved[(sy + v) * cw + sx + u];
      }
    }
    spots.push({ x: Math.round(q.x / COARSE), y: Math.round(q.y / COARSE), values: values.map((value) => value - mean / 9) });
  }
  if (spots.length < MIN_IN_VIEW) return null;
  let top = { x: 0, y: 0, score: Infinity };
  for (let dy = -Math.floor(ch * 0.6); dy <= ch * 0.6; dy++) {
    for (let dx = -Math.floor(cw * 0.6); dx <= cw * 0.6; dx++) {
      let sum = 0;
      let n = 0;
      for (const spot of spots) {
        const x = spot.x + dx;
        const y = spot.y + dy;
        if (x < 1 || y < 1 || x >= cw - 1 || y >= ch - 1) continue;
        let mean = 0;
        for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) mean += now[(y + v) * cw + x + u];
        mean /= 9;
        let k = 0;
        for (let v = -1; v <= 1; v++) {
          for (let u = -1; u <= 1; u++) sum += Math.min(Math.abs(now[(y + v) * cw + x + u] - mean - spot.values[k++]), 40);
        }
        n++;
      }
      if (n < spots.length * 0.4 || n < MIN_IN_VIEW) continue;
      const score = sum / n;
      if (score < top.score) top = { x: dx * COARSE, y: dy * COARSE, score };
    }
  }
  if (top.score === Infinity) return null;
  const place = multiply([1, 0, top.x, 0, 1, top.y, 0, 0, 1], base);
  return sensible(place) ? place : null;
}

function shrink(gray: Float32Array): Float32Array {
  const cw = Math.floor(W / COARSE);
  const ch = Math.floor(H / COARSE);
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch * COARSE; y++) {
    for (let x = 0; x < cw * COARSE; x++) out[Math.floor(y / COARSE) * cw + Math.floor(x / COARSE)] += gray[y * W + x] / (COARSE * COARSE);
  }
  return out;
}

// The new matrix, or part of the way there if it has hardly changed (see STEADY_PX).
function steadied(pin: Pin, next: Matrix): Matrix {
  const last = normalize(pin.matrix);
  let change = 0;
  for (const c of pin.region) {
    const a = apply(last, c.x, c.y);
    const b = apply(next, c.x, c.y);
    if (!a || !b) return next;
    change = Math.max(change, Math.hypot(a.x - b.x, a.y - b.y));
  }
  const share = Math.min(1, change / STEADY_PX);
  return last.map((v, i) => v + (next[i] - v) * share);
}

// How many of the last pin's spots were in view, found or not.
let spotsInView = 0;

function lookForSpots(pin: Pin, points: { x: number; y: number }[], live: Float32Array, predicted: Matrix, wide: boolean): Spot[] {
  const found: Spot[] = [];
  spotsInView = 0;
  const size = (TEMPLATE * 2 + 1) ** 2;
  const template = new Float32Array(size);
  const reach = wide ? WIDE : NEAR;
  const margin = TEMPLATE + reach + 1;
  for (const p of points) {
    const q = apply(predicted, p.x, p.y);
    if (!q || q.x < margin || q.y < margin || q.x >= W - margin - 1 || q.y >= H - margin - 1) continue;
    // How the spot looks from here: one live pixel to the right is this far in the saved view.
    const qx = apply(predicted, p.x + 1, p.y);
    const qy = apply(predicted, p.x, p.y + 1);
    if (!qx || !qy) continue;
    spotsInView++;
    const a = qx.x - q.x;
    const b = qy.x - q.x;
    const c = qx.y - q.y;
    const d = qy.y - q.y;
    const det = a * d - b * c;
    if (det < 0.05) continue;
    const ix = Math.round(q.x);
    const iy = Math.round(q.y);
    const fx = q.x - ix;
    const fy = q.y - iy;
    let sum = 0;
    let n = 0;
    let ok = true;
    for (let v = -TEMPLATE; v <= TEMPLATE && ok; v++) {
      for (let u = -TEMPLATE; u <= TEMPLATE; u++) {
        const du = u - fx;
        const dv = v - fy;
        const sx = p.x + (d * du - b * dv) / det;
        const sy = p.y + (-c * du + a * dv) / det;
        if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) {
          ok = false;
          break;
        }
        const x0 = sx | 0;
        const y0 = sy | 0;
        const tx = sx - x0;
        const ty = sy - y0;
        const i = y0 * W + x0;
        const value = (pin.gray[i] * (1 - tx) + pin.gray[i + 1] * tx) * (1 - ty) + (pin.gray[i + W] * (1 - tx) + pin.gray[i + W + 1] * tx) * ty;
        template[n++] = value;
        sum += value;
      }
    }
    if (!ok) continue;
    const savedMean = sum / size;
    let energy = 0;
    for (let i = 0; i < size; i++) {
      template[i] -= savedMean;
      energy += template[i] * template[i];
    }
    if (energy < size * 4) continue; // reshaped, it's too plain to tell where it is

    const score = (dx: number, dy: number) => correlate(live, template, energy, ix + dx, iy + dy);
    let best = { x: 0, y: 0, s: -2 };
    const step = wide ? WIDE_STEP : 1;
    for (let dy = -reach; dy <= reach; dy += step) {
      for (let dx = -reach; dx <= reach; dx += step) {
        const s = score(dx, dy);
        if (s > best.s) best = { x: dx, y: dy, s };
      }
    }
    if (wide) {
      const at = best;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const s = score(at.x + dx, at.y + dy);
          if (s > best.s) best = { x: at.x + dx, y: at.y + dy, s };
        }
      }
    }
    if (best.s < MIN_MATCH) continue;
    // A parabola through the neighbours gives the position between pixels.
    const between = (l: number, m: number, r: number) => {
      const bottom = 2 * m - l - r;
      return bottom > 1e-6 ? Math.max(-0.5, Math.min(0.5, (r - l) / (2 * bottom))) : 0;
    };
    const ox = between(score(best.x - 1, best.y), best.s, score(best.x + 1, best.y));
    const oy = between(score(best.x, best.y - 1), best.s, score(best.x, best.y + 1));
    const brightness = windowMean(live, ix + best.x, iy + best.y) / Math.max(savedMean, 1);
    found.push({ qx: q.x, qy: q.y, fx: ix + best.x + ox, fy: iy + best.y + oy, brightness });
  }
  return found;
}

// Normalized correlation, so overall brightness and contrast don't matter. -2 outside the picture.
function correlate(live: Float32Array, template: Float32Array, energy: number, cx: number, cy: number): number {
  if (cx < TEMPLATE || cy < TEMPLATE || cx >= W - TEMPLATE || cy >= H - TEMPLATE) return -2;
  const side = TEMPLATE * 2 + 1;
  let cross = 0;
  let sum = 0;
  let squares = 0;
  let t = 0;
  for (let y = cy - TEMPLATE; y <= cy + TEMPLATE; y++) {
    const row = y * W + cx - TEMPLATE;
    for (let x = 0; x < side; x++) {
      const v = live[row + x];
      cross += v * template[t++];
      sum += v;
      squares += v * v;
    }
  }
  const spread = squares - (sum * sum) / (side * side);
  return spread > 1e-3 ? cross / Math.sqrt(spread * energy) : -2;
}

function windowMean(live: Float32Array, cx: number, cy: number): number {
  let sum = 0;
  for (let y = cy - TEMPLATE; y <= cy + TEMPLATE; y++) {
    for (let x = cx - TEMPLATE; x <= cx + TEMPLATE; x++) sum += live[y * W + x];
  }
  return sum / (TEMPLATE * 2 + 1) ** 2;
}

// Finds the stretch from predicted to found spots that most of them agree on.
function fitChange(spots: Spot[], trusted: boolean): { change: Matrix; spots: number; gain: number } | null {
  // Guesses: "nothing changed", and a slide + turn + zoom through two random spots.
  let guess = { a: 1, b: 0, tx: 0, ty: 0 };
  const agrees = (g: typeof guess, s: Spot) =>
    Math.hypot(g.a * s.qx - g.b * s.qy + g.tx - s.fx, g.b * s.qx + g.a * s.qy + g.ty - s.fy) < GUESS_TOLERANCE;
  const count = (g: typeof guess) => spots.reduce((n, s) => (agrees(g, s) ? n + 1 : n), 0);
  let bestCount = count(guess);
  const enough = trusted ? Math.max(TRUST_MIN, spots.length * TRUST_SHARE) : Infinity;
  for (let i = 0; bestCount < enough && i < TRIES; i++) {
    const p = spots[Math.floor(Math.random() * spots.length)];
    const q = spots[Math.floor(Math.random() * spots.length)];
    const dx = q.qx - p.qx;
    const dy = q.qy - p.qy;
    const length = dx * dx + dy * dy;
    let g = { a: 1, b: 0, tx: p.fx - p.qx, ty: p.fy - p.qy };
    if (length >= 100) {
      const fx = q.fx - p.fx;
      const fy = q.fy - p.fy;
      const a = (dx * fx + dy * fy) / length;
      const b = (dx * fy - dy * fx) / length;
      g = { a, b, tx: p.fx - a * p.qx + b * p.qy, ty: p.fy - b * p.qx - a * p.qy };
    }
    const n = count(g);
    if (n > bestCount) {
      bestCount = n;
      guess = g;
    }
  }
  if (bestCount < 2) return null;

  // Then the full fit, a few times, keeping only the spots that agree with it.
  let good = spots.filter((s) => agrees(guess, s));
  let change = solve(good);
  if (!change) return null;
  for (let round = 0; round < 2; round++) {
    const current: Matrix = change;
    const kept = spots.filter((s) => {
      const p = apply(current, s.qx, s.qy);
      return !!p && Math.hypot(p.x - s.fx, p.y - s.fy) < FIT_TOLERANCE;
    });
    if (kept.length < 2) return null;
    good = kept;
    change = solve(good);
    if (!change) return null;
  }
  const brightness = good.map((s) => s.brightness).sort((a, b) => a - b);
  return { change, spots: good.length, gain: brightness[brightness.length >> 1] };
}

// Least squares for the stretch, with the shape held back (see SHAPE_HOLD). Sliding isn't held back.
function solve(spots: Spot[]): Matrix | null {
  const n = spots.length;
  let cx = 0;
  let cy = 0;
  for (const s of spots) {
    cx += s.qx;
    cy += s.qy;
  }
  cx /= n;
  cy /= n;
  const unit = W / 2;
  const onlySlide = n < FULL_FIT_SPOTS;
  const ata = new Float64Array(64);
  const atb = new Float64Array(8);
  const row = new Float64Array(8);
  const add = (r: number) => {
    for (let i = 0; i < 8; i++) {
      atb[i] += row[i] * r;
      for (let j = 0; j < 8; j++) ata[i * 8 + j] += row[i] * row[j];
    }
  };
  for (const s of spots) {
    const x = (s.qx - cx) / unit;
    const y = (s.qy - cy) / unit;
    const fx = (s.fx - cx) / unit;
    const fy = (s.fy - cy) / unit;
    row.set([x, y, 1, 0, 0, 0, -fx * x, -fx * y]);
    add(fx - x);
    row.set([0, 0, 0, x, y, 1, -fy * x, -fy * y]);
    add(fy - y);
  }
  const shape = onlySlide ? 1e6 : SHAPE_HOLD;
  const perspective = onlySlide ? 1e6 : PERSPECTIVE_HOLD;
  for (const i of [0, 1, 3, 4]) ata[i * 8 + i] += shape;
  for (const i of [6, 7]) ata[i * 8 + i] += perspective;
  const d = gauss(ata, atb);
  if (!d) return null;
  const local = [1 + d[0], d[1], d[2], d[3], 1 + d[4], d[5], d[6], d[7], 1];
  // Back from centered, unit-sized coordinates to small pixels.
  const down = [1 / unit, 0, -cx / unit, 0, 1 / unit, -cy / unit, 0, 0, 1];
  const up = [unit, 0, cx, 0, unit, cy, 0, 0, 1];
  return multiply(up, multiply(local, down));
}

function gauss(a: Float64Array, b: Float64Array): Float64Array | null {
  const n = 8;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r * n + i]) > Math.abs(a[pivot * n + i])) pivot = r;
    if (Math.abs(a[pivot * n + i]) < 1e-12) return null;
    if (pivot !== i) {
      for (let c = 0; c < n; c++) {
        const t = a[i * n + c];
        a[i * n + c] = a[pivot * n + c];
        a[pivot * n + c] = t;
      }
      const t = b[i];
      b[i] = b[pivot];
      b[pivot] = t;
    }
    for (let r = i + 1; r < n; r++) {
      const f = a[r * n + i] / a[i * n + i];
      if (f === 0) continue;
      for (let c = i; c < n; c++) a[r * n + c] -= f * a[i * n + c];
      b[r] -= f * b[i];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let v = b[i];
    for (let c = i + 1; c < n; c++) v -= a[i * n + c] * b[c];
    b[i] = v / a[i * n + i];
  }
  return b;
}

// A real view of a surface: same way up (not flipped), a size that could happen, not bent wildly.
function sensible(m: Matrix): boolean {
  const c: { x: number; y: number }[] = [];
  for (const [x, y] of [[0, 0], [W, 0], [W, H], [0, H]]) {
    const p = apply(m, x, y);
    if (!p) return false;
    c.push(p);
  }
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    const d = c[(i + 2) % 4];
    if ((b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x) <= 0) return false;
    area += a.x * b.y - b.x * a.y;
  }
  const scale = Math.sqrt(Math.abs(area / 2) / (W * H));
  return scale > MIN_SCALE && scale < MAX_SCALE;
}

// The best-textured spots (corners, not edges), spread out evenly and away from what we must avoid.
function pickPoints(
  gray: Float32Array,
  avoid: ((x: number, y: number) => boolean) | null,
  near: ((x: number, y: number, reach: number) => boolean) | null,
  reach: number,
): { x: number; y: number }[] {
  const edge = TEMPLATE + 2;
  const cell = 16;
  const columns = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const best: ({ x: number; y: number; s: number } | null)[] = new Array(columns * rows).fill(null);
  for (let y = edge; y < H - edge; y += 2) {
    for (let x = edge; x < W - edge; x += 2) {
      if (near && !near(x, y, reach)) continue;
      // Corner strength: the smaller of the two main directions of change around this spot.
      let xx = 0;
      let yy = 0;
      let xy = 0;
      for (let v = -2; v <= 2; v++) {
        for (let u = -2; u <= 2; u++) {
          const i = (y + v) * W + x + u;
          const gx = gray[i + 1] - gray[i - 1];
          const gy = gray[i + W] - gray[i - W];
          xx += gx * gx;
          yy += gy * gy;
          xy += gx * gy;
        }
      }
      const s = (xx + yy - Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) / 2;
      if (s < MIN_CORNER) continue;
      const c = Math.floor(y / cell) * columns + Math.floor(x / cell);
      if (best[c] && best[c]!.s >= s) continue;
      if (avoid && avoid(x / W, y / H)) continue;
      best[c] = { x, y, s };
    }
  }
  return best
    .filter((p): p is { x: number; y: number; s: number } => !!p)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_POINTS)
    .map(({ x, y }) => ({ x, y }));
}

// A small gray copy, softened a little so being a fraction of a pixel off doesn't matter.
function grayOf(source: CanvasImageSource): Float32Array {
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(source, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const raw = new Float32Array(W * H);
  for (let i = 0; i < raw.length; i++) raw[i] = rgba[i * 4] * 0.3 + rgba[i * 4 + 1] * 0.59 + rgba[i * 4 + 2] * 0.11;
  const across = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      across[i] = (raw[i - (x > 0 ? 1 : 0)] + raw[i] * 2 + raw[i + (x < W - 1 ? 1 : 0)]) / 4;
    }
  }
  const soft = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const up = y > 0 ? W : 0;
    const down = y < H - 1 ? W : 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      soft[i] = (across[i - up] + across[i] * 2 + across[i + down]) / 4;
    }
  }
  return soft;
}

function apply(m: Matrix, x: number, y: number): { x: number; y: number } | null {
  const z = m[6] * x + m[7] * y + m[8];
  if (z < 1e-6) return null;
  return { x: (m[0] * x + m[1] * y + m[2]) / z, y: (m[3] * x + m[4] * y + m[5]) / z };
}

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return out;
}

function invert(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A, B, C, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d].map((v) => v / det);
}

function normalize(m: Matrix): Matrix {
  return m.map((v) => v / m[8]);
}

