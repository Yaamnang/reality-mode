// The "virtual" side of the split view: the live camera with an object erased or moved.
//
// Erasing happens in two steps:
//   1. Instantly: the gap is filled by blending in the colors around it (looks fine on a plain desk).
//   2. A few seconds later: Meta's Muse Image result (server /api/remove) replaces that patch.
// Moving = erasing the object's spot, plus a cut-out of the object drawn wherever it's dragged. A
// transmuted object's cut-out comes from Meta's picture (cutLook, setSpriteLook), so moving and
// transmuting work in either order.
// Any number of objects can be edited; each edit stays until everything is reset.
// Everything is pinned to the scene: each edit shifts by how far the camera has moved since it was
// made (scene motion, measured by highlight.ts following the object being worked on).
// While Meta works, water-like ripples pulse out from the spot; the AI fill then fades in.
// An edit can have a pin instead (pinTracker.ts): they stretch with the room as the camera moves.

import { pinMatrix, pinPoint, type Pin } from "./pinTracker";
import { warpLayers } from "./warp";
import { cutoutMask, maskToCanvas } from "./highlight";

export type FillStatus = "filling" | "ai" | "failed";

export interface Erase {
  kind: "erase" | "transmute";
  patch: HTMLCanvasElement; // frame-sized; transparent except over the erased object
  quick: HTMLCanvasElement; // the instant fill, kept to fade from when the AI fill arrives
  alpha: HTMLCanvasElement; // frame-sized; white over the erased object (grown a little, soft edge)
  center: { x: number; y: number }; // object center when erased (0..1 of frame)
  size: { w: number; h: number }; // object size (0..1 of frame), for the ripple size
  status: FillStatus;
  label: string;
  aiAt: number; // when the AI fill arrived (performance.now), for the fade-in
  sprite: Sprite | null; // the object itself, when it's being moved rather than erased
  motionAt: { x: number; y: number }; // scene motion when the edit was made
  frame: HTMLCanvasElement; // the camera frame when it was made, to check the AI really removed it
  pin?: Pin; // if set, this places the edit rather than motionAt
}

interface Sprite {
  image: HTMLCanvasElement; // what's drawn: the object cut out, cropped to its box
  real: HTMLCanvasElement; // the real object cut out of the frame
  busy: boolean; // Meta is drawing a new look for it: ripples
  x: number; // top-left where it was, in frame pixels
  y: number;
  dx: number; // how far it's been dragged, in frame pixels
  dy: number;
  lifted: boolean; // being dragged right now (drawn a little bigger, with a further shadow)
  stored: boolean; // in the inventory: not in the room at all until it's taken out
}

// Grow the erased area by this many pixels (of a 1280-wide frame), so the object's edge and
// shadow are covered too, then soften the border so the patch blends in.
const GROW = 16;
const FEATHER = 4;
// Ripples: a new ring starts every RIPPLE_MS and spreads out over RIPPLE_LIFE_MS.
const RIPPLE_MS = 450;
const RIPPLE_LIFE_MS = 1350;
// The AI fill fades in over this long, with one last ripple.
const FADE_MS = 700;

// All edits, oldest first. Each belongs to one object in the tray (realityShift.ts).
let edits: Erase[] = [];

export function hasErase() {
  return edits.length > 0;
}

export function editCount() {
  return edits.length;
}

export function anyFillFailed() {
  return edits.some((e) => e.status === "failed");
}

// Removes every edit: all objects are back where they were.
export function clearErase() {
  edits = [];
}

// Undoes one edit: that object is back where it was.
export function removeEdit(edit: Erase) {
  edits = edits.filter((e) => e !== edit);
}

// Turns a move into an erase: the moved object disappears, its old spot stays filled.
export function removeSprite(edit: Erase) {
  edit.sprite = null;
}

// Starts erasing. `shape` is the object's mask (white on transparent, any size, covering the whole
// frame) and `offset` how far it's shifted (0..1 of frame). With `cutOut`, the object is also kept
// as a sprite that can be dragged. `motionAt` = scene motion now. Returns the new edit and the
// frame as a JPEG for the server.
export function startErase(
  video: HTMLVideoElement,
  shape: { canvas: HTMLCanvasElement; offset: { x: number; y: number } },
  box: { x: number; y: number; w: number; h: number },
  cutOut: boolean,
  motionAt: { x: number; y: number },
): { edit: Erase; frame: Promise<Blob> } {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const frame = canvasOf(w, h);
  frame.getContext("2d")!.drawImage(video, 0, 0, w, h);

  const alpha = canvasOf(w, h);
  const actx = alpha.getContext("2d")!;
  const grow = Math.max(2, Math.round((GROW * w) / 1280));
  // Growing = drawing the mask shifted in every direction.
  const grown = canvasOf(w, h);
  const gctx = grown.getContext("2d")!;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    gctx.drawImage(shape.canvas, shape.offset.x * w + Math.cos(a) * grow, shape.offset.y * h + Math.sin(a) * grow, w, h);
  }
  gctx.drawImage(shape.canvas, shape.offset.x * w, shape.offset.y * h, w, h);
  actx.filter = `blur(${FEATHER}px)`;
  actx.drawImage(grown, 0, 0);

  const quick = quickFill(frame, grown, alpha);
  const edit: Erase = {
    kind: "erase",
    patch: quick,
    quick,
    alpha,
    center: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    size: { w: box.w, h: box.h },
    status: "filling",
    label: "",
    aiAt: 0,
    sprite: cutOut ? cutSprite(frame, shape, box) : null,
    motionAt,
    frame,
  };
  edits.push(edit);
  const blob = new Promise<Blob>((resolve, reject) =>
    frame.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode frame"))), "image/jpeg", 0.9),
  );
  return { edit, frame: blob };
}

// Transmute: the object is changed in place ("make it gold"). Until Meta's version arrives the
// real object stays visible under the ripples. The pasted area is the object's box grown a bit
// (with a soft edge), not its exact outline, so a changed shape isn't clipped.
const TRANSMUTE_GROW = 0.15; // of the box size, per side
const TRANSMUTE_FEATHER = 10; // px of a 1280-wide frame
// Replacing it with something else (the reality dial): the new thing may be a different shape,
// so paste a wider area, with extra room above (a cactus is taller than an AirPods case).
const REPLACE_GROW = 0.35;
const REPLACE_GROW_UP = 0.8;

export function startTransmute(
  video: HTMLVideoElement,
  box: { x: number; y: number; w: number; h: number },
  motionAt: { x: number; y: number },
  replace = false,
): { edit: Erase; frame: Promise<Blob> } {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const frame = canvasOf(w, h);
  frame.getContext("2d")!.drawImage(video, 0, 0, w, h);

  const alpha = canvasOf(w, h);
  const actx = alpha.getContext("2d")!;
  const feather = Math.max(2, Math.round((TRANSMUTE_FEATHER * w) / 1280));
  const grow = replace ? REPLACE_GROW : TRANSMUTE_GROW;
  const gx = box.w * w * grow + feather;
  const gy = box.h * h * grow + feather;
  const up = replace ? box.h * h * REPLACE_GROW_UP : 0;
  actx.filter = `blur(${feather}px)`;
  actx.fillStyle = "#ffffff";
  actx.beginPath();
  actx.roundRect(box.x * w - gx, box.y * h - gy - up, box.w * w + gx * 2, box.h * h + gy * 2 + up, Math.min(gx, gy) * 2);
  actx.fill();

  const empty = canvasOf(w, h);
  const edit: Erase = {
    kind: "transmute",
    patch: empty,
    quick: empty,
    alpha,
    center: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    size: { w: box.w, h: box.h },
    status: "filling",
    label: "",
    aiAt: 0,
    sprite: null,
    motionAt,
    frame,
  };
  edits.push(edit);
  const blob = new Promise<Blob>((resolve, reject) =>
    frame.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode frame"))), "image/jpeg", 0.9),
  );
  return { edit, frame: blob };
}

// An edit whose picture is made elsewhere. Ripples at `center` until fillEdit.
export function addEdit(
  frame: HTMLCanvasElement,
  center: { x: number; y: number },
  size: { w: number; h: number },
  motionAt: { x: number; y: number },
  pin: Pin,
): Erase {
  const empty = canvasOf(frame.width, frame.height);
  const edit: Erase = {
    kind: "transmute",
    patch: empty,
    quick: empty,
    alpha: empty,
    center,
    size,
    status: "filling",
    label: "",
    aiAt: 0,
    sprite: null,
    motionAt,
    frame,
    pin,
  };
  edits.push(edit);
  return edit;
}

// Fades in a frame-sized picture, transparent except where it changes the room.
export function fillEdit(edit: Erase, patch: HTMLCanvasElement) {
  edit.quick = edit.patch;
  edit.patch = patch;
  edit.status = "ai";
  edit.aiAt = performance.now();
}

// Cuts the object out of the frame (exact outline, slightly softened edge), cropped to its box.
function cutSprite(
  frame: HTMLCanvasElement,
  shape: { canvas: HTMLCanvasElement; offset: { x: number; y: number } },
  box: { x: number; y: number; w: number; h: number },
): Sprite {
  const { width: w, height: h } = frame;
  const pad = 4;
  const x = Math.max(0, Math.floor(box.x * w) - pad);
  const y = Math.max(0, Math.floor(box.y * h) - pad);
  const sw = Math.min(w - x, Math.ceil(box.w * w) + pad * 2);
  const sh = Math.min(h - y, Math.ceil(box.h * h) + pad * 2);
  const image = canvasOf(sw, sh);
  const ictx = image.getContext("2d")!;
  ictx.filter = "blur(1px)";
  ictx.drawImage(shape.canvas, shape.offset.x * w - x, shape.offset.y * h - y, w, h);
  ictx.filter = "none";
  ictx.globalCompositeOperation = "source-in";
  ictx.drawImage(frame, -x, -y);
  return { image, real: image, busy: false, x, y, dx: 0, dy: 0, lifted: true, stored: false };
}

// Cuts the new object out of Meta's full-frame picture: its outline if the segmenter finds one on what
// Meta changed, or else the pixels Meta changed. `frame` = what to compare with, `box` = where the object was.
// null if Meta drew next to nothing: there's no object to show.
export async function cutLook(imageUrl: string, frame: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }): Promise<HTMLCanvasElement | null> {
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  const { width: w, height: h } = frame;
  const full = canvasOf(w, h);
  full.getContext("2d")!.drawImage(image, 0, 0, w, h);
  const changed = changedPixels(frame, full, box);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // The new thing needn't be in the middle of the old one's box: it may be off to a side, or taller.
  const seeds = [
    [cx, cy],
    [cx, box.y + box.h * 0.1],
    [box.x + box.w * 0.25, cy],
    [box.x + box.w * 0.75, cy],
    [cx, box.y + box.h * 0.8],
  ];
  let found: { pixels: Uint8Array; w: number; h: number } | null = null;
  for (const [x, y] of seeds) {
    const mask = cutoutMask(full, { x, y });
    if (mask && mostlyChanged(mask, changed)) {
      found = mask;
      break;
    }
  }
  const area = canvasOf(w, h);
  const actx = area.getContext("2d")!;
  if (found) {
    actx.filter = "blur(1px)";
    actx.drawImage(maskToCanvas(found.pixels, found.w, found.h), 0, 0, w, h);
    actx.filter = "none";
  } else {
    const blob = biggestBlob(changed);
    if (blob.count < box.w * box.h * changed.w * changed.h * LOOK_MIN_BLOB) return null;
    actx.filter = "blur(2px)";
    actx.drawImage(blob.canvas, 0, 0, w, h);
    actx.filter = "none";
  }
  // Cropped to where the area is.
  const sw = 160;
  const sh = Math.max(1, Math.round((sw * h) / w));
  const small = canvasOf(sw, sh);
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(area, 0, 0, sw, sh);
  const px = sctx.getImageData(0, 0, sw, sh).data;
  let x0 = sw, y0 = sh, x1 = 0, y1 = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (px[(y * sw + x) * 4 + 3] < 40) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const cropX = Math.max(0, Math.floor(((x0 - 1) * w) / sw));
  const cropY = Math.max(0, Math.floor(((y0 - 1) * h) / sh));
  const out = canvasOf(Math.max(1, Math.min(w, Math.ceil(((x1 + 2) * w) / sw)) - cropX), Math.max(1, Math.min(h, Math.ceil(((y1 + 2) * h) / sh)) - cropY));
  const octx = out.getContext("2d")!;
  octx.drawImage(area, -cropX, -cropY);
  octx.globalCompositeOperation = "source-in";
  octx.drawImage(full, -cropX, -cropY);
  return out;
}

// Which pixels Meta clearly changed around `box`, on a small copy: lone ones and thin lines left out.
const LOOK_W = 320;
const LOOK_REACH = { side: 1, up: 2, down: 0.5 };
function changedPixels(frame: HTMLCanvasElement, full: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }) {
  const w = LOOK_W;
  const h = Math.max(1, Math.round((w * frame.height) / frame.width));
  const read = (source: CanvasImageSource) => {
    const c = canvasOf(w, h);
    const cctx = c.getContext("2d", { willReadFrequently: true })!;
    cctx.drawImage(source, 0, 0, w, h);
    return cctx.getImageData(0, 0, w, h).data;
  };
  const before = read(frame);
  const after = read(full);
  const x0 = Math.max(1, Math.floor((box.x - box.w * LOOK_REACH.side) * w));
  const x1 = Math.min(w - 2, Math.ceil((box.x + box.w * (1 + LOOK_REACH.side)) * w));
  const y0 = Math.max(1, Math.floor((box.y - box.h * LOOK_REACH.up) * h));
  const y1 = Math.min(h - 2, Math.ceil((box.y + box.h * (1 + LOOK_REACH.down)) * h));
  const raw = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      if (Math.max(Math.abs(before[i] - after[i]), Math.abs(before[i + 1] - after[i + 1]), Math.abs(before[i + 2] - after[i + 2])) > AREA_CHANGED) raw[y * w + x] = 1;
    }
  }
  const pixels = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let near = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near += raw[(y + dy) * w + x + dx];
      if (near >= 6) pixels[y * w + x] = 1;
    }
  }
  return { pixels, w, h };
}

// An outline counts if at least this much of it is something Meta drew, not the desk or a nearby object.
const LOOK_MIN_CHANGED = 0.35;
const LOOK_MIN_BLOB = 0.1; // what changed must be at least this much of the old object's box
function mostlyChanged(mask: { pixels: Uint8Array; w: number; h: number }, changed: { pixels: Uint8Array; w: number; h: number }) {
  let inside = 0;
  let hit = 0;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (!mask.pixels[y * mask.w + x]) continue;
      inside++;
      if (changed.pixels[Math.floor((y * changed.h) / mask.h) * changed.w + Math.floor((x * changed.w) / mask.w)]) hit++;
    }
  }
  return inside > 0 && hit / inside >= LOOK_MIN_CHANGED;
}

// The largest connected piece of what changed, grown a little, as a white-on-clear small canvas.
function biggestBlob(changed: { pixels: Uint8Array; w: number; h: number }) {
  const { pixels, w, h } = changed;
  const seen = new Uint8Array(w * h);
  let best: number[] = [];
  for (let start = 0; start < pixels.length; start++) {
    if (!pixels[start] || seen[start]) continue;
    const piece = [start];
    seen[start] = 1;
    for (let head = 0; head < piece.length; head++) {
      const p = piece[head];
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < pixels.length && pixels[q] && !seen[q]) {
          seen[q] = 1;
          piece.push(q);
        }
      }
    }
    if (piece.length > best.length) best = piece;
  }
  const small = canvasOf(w, h);
  const sctx = small.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  for (const p of best) img.data[p * 4 + 3] = 255;
  sctx.putImageData(img, 0, 0);
  const grown = canvasOf(w, h);
  const gctx = grown.getContext("2d")!;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) gctx.drawImage(small, Math.cos(a), Math.sin(a));
  gctx.drawImage(small, 0, 0);
  return { canvas: grown, count: best.length };
}

// What a moved object looks like: a cut-out from cutLook, or null for its real self. It stands on the
// same spot, so a taller thing grows upward.
export function setSpriteLook(edit: Erase, look: HTMLCanvasElement | null) {
  const s = edit.sprite;
  if (!s) return;
  const image = look ?? s.real;
  s.x += (s.image.width - image.width) / 2;
  s.y += s.image.height - image.height;
  s.image = image;
}

export function setSpriteBusy(edit: Erase, busy: boolean) {
  if (edit.sprite) edit.sprite.busy = busy;
}

// Has a moved object got a look of its own?
export function spriteHasLook(edit: Erase) {
  return !!edit.sprite && edit.sprite.image !== edit.sprite.real;
}

// Where a moved object is on screen now (0..1 of frame). `motion` = scene motion now.
export function spriteBox(edit: Erase, motion: { x: number; y: number }): { x: number; y: number; w: number; h: number } | null {
  const s = edit.sprite;
  if (!s) return null;
  const { width: w, height: h } = edit.alpha;
  return {
    x: (s.x + s.dx) / w + motion.x - edit.motionAt.x,
    y: (s.y + s.dy) / h + motion.y - edit.motionAt.y,
    w: s.image.width / w,
    h: s.image.height / h,
  };
}

// The virtual view as a plain picture, with no hands and no mirroring: what Meta edits a moved object in.
// `without`: leaves that object out, to compare with what Meta draws: then only the new thing has changed.
export function composeVirtual(video: HTMLVideoElement, motion: { x: number; y: number }, without: Erase | null = null): HTMLCanvasElement {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const out = canvasOf(w, h);
  const ctx = out.getContext("2d")!;
  ctx.drawImage(video, 0, 0, w, h);
  const shiftOf = (e: Erase) => ({ x: (motion.x - e.motionAt.x) * w, y: (motion.y - e.motionAt.y) * h });
  for (const e of edits) {
    const s = shiftOf(e);
    ctx.drawImage(e.patch, s.x, s.y);
  }
  for (const e of edits) {
    const s = shiftOf(e);
    if (e.sprite && !e.sprite.stored && e !== without) drawSprite(ctx, e.sprite, s.x, s.y, false);
  }
  return out;
}

export function canvasJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode frame"))), "image/jpeg", 0.9));
}

// Drags a moved object: `dx`, `dy` = how far from where it was (0..1 of frame).
export function dragSprite(edit: Erase, dx: number, dy: number, lifted: boolean) {
  const s = edit.sprite;
  if (!s) return;
  s.dx = dx * edit.alpha.width;
  s.dy = dy * edit.alpha.height;
  s.lifted = lifted;
}

// Puts a moved object in the inventory (not in the room) or takes it out.
export function storeSprite(edit: Erase, stored: boolean) {
  if (edit.sprite) edit.sprite.stored = stored;
}

// Where a moved object's center was when it was cut out (0..1 of frame).
export function spriteHome(edit: Erase): { x: number; y: number } | null {
  const s = edit.sprite;
  return s && { x: (s.x + s.image.width / 2) / edit.alpha.width, y: (s.y + s.image.height / 2) / edit.alpha.height };
}

// How far a moved object has been dragged so far (0..1 of frame), to continue a new drag from there.
export function spriteOffset(edit: Erase): { x: number; y: number } | null {
  const s = edit.sprite;
  return s ? { x: s.dx / edit.alpha.width, y: s.dy / edit.alpha.height } : null;
}

// The AI must change the object's area at least this much (average difference, 0..255) to count
// as having removed it. Muse Image once returned the phone still in place when it only knew it
// as "object".
const MIN_AI_CHANGE = 15;
// A transmute must clearly change at least this share of its area: pixels where some color
// channel moved more than CHANGED_PIXEL. Averages don't work there: silver -> gold raises red and
// lowers blue, and the unchanged desk around it is in the area too. Tested: gold 21%, untouched 0%.
const MIN_TRANSMUTED_SHARE = 0.05;
const CHANGED_PIXEL = 30;

// Swaps in the AI result for `target` (a full frame, same size, with the object removed or changed).
// Returns false (and keeps the quick fill) if the AI left the object as it was.
export async function applyAiFill(target: Erase, imageUrl: string, label: string): Promise<boolean> {
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  if (!edits.includes(target)) return true; // reset while we were waiting
  const change = changeInside(target, image);
  if (target.kind === "erase" ? change.mean < MIN_AI_CHANGE : change.share < MIN_TRANSMUTED_SHARE) {
    target.status = "failed";
    return false;
  }

  const patch = canvasOf(target.alpha.width, target.alpha.height);
  const pctx = patch.getContext("2d")!;
  pctx.drawImage(image, 0, 0, patch.width, patch.height);
  // A transmute has no quick fill: fade from whatever version was showing before.
  if (target.kind === "transmute") target.quick = target.patch;
  pctx.globalCompositeOperation = "destination-in";
  // Pastes what Meta actually changed: a taller or wider new thing is kept whole, and an erase takes
  // the object's clip and shadow too (the outline left them behind). An erase looks less far.
  pctx.drawImage(changedArea(target.frame, target.center, target.size, image, target.kind === "erase" ? ERASE_REACH : undefined), 0, 0);
  target.patch = patch;
  target.status = "ai";
  target.label = label;
  target.aiAt = performance.now();
  return true;
}

// How much the AI result differs from the original frame inside the edited area only: the average
// difference, and the share of pixels that clearly changed (compared on small copies, it's quick).
function changeInside(e: Erase, ai: HTMLImageElement): { mean: number; share: number } {
  const w = 160;
  const h = Math.max(1, Math.round((w * e.frame.height) / e.frame.width));
  const read = (source: CanvasImageSource) => {
    const c = canvasOf(w, h);
    const cctx = c.getContext("2d", { willReadFrequently: true })!;
    cctx.drawImage(source, 0, 0, w, h);
    return cctx.getImageData(0, 0, w, h).data;
  };
  const before = read(e.frame);
  const after = read(ai);
  const area = read(e.alpha);
  let sum = 0;
  let changed = 0;
  let n = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (area[i + 3] < 128) continue;
    const dr = Math.abs(before[i] - after[i]);
    const dg = Math.abs(before[i + 1] - after[i + 1]);
    const db = Math.abs(before[i + 2] - after[i + 2]);
    sum += (dr + dg + db) / 3;
    if (Math.max(dr, dg, db) > CHANGED_PIXEL) changed++;
    n++;
  }
  return n ? { mean: sum / n, share: changed / n } : { mean: 255, share: 1 };
}

// The area to paste for a transmute: every pixel Meta's result clearly changed that connects to
// the object (the new thing, its shadow, where the old object was), plus the object's own box,
// within a generous area around it. A fixed rectangle cut the top off a teddy bear that replaced
// an egg, leaving a dark smudge. Worked out on a small copy, then grown and softened.
const AREA_WIDTH = 320; // px, the small copy
const AREA_THIN = 2; // `solid`: changed lines thinner than twice this (small px) don't count
const AREA_SIDE = 1.0; // the search area: the box grown this much (of its size) left and right,
const AREA_UP = 2.0; // this much above (new things are often taller),
const AREA_DOWN = 0.5; // and this much below
const ERASE_REACH = { side: 0.6, up: 0.4, down: 0.6 }; // an erase only removes things near the object
const AREA_CHANGED = 28; // a pixel counts as changed when some color channel moved more than this
export function changedArea(
  frame: HTMLCanvasElement,
  center: { x: number; y: number },
  size: { w: number; h: number },
  ai: HTMLImageElement,
  reach = { side: AREA_SIDE, up: AREA_UP, down: AREA_DOWN },
  solid = false, // leave out thin lines of change, keep no holes: it must hold up when the camera moves
): HTMLCanvasElement {
  const w = AREA_WIDTH;
  const h = Math.max(1, Math.round((w * frame.height) / frame.width));
  const read = (source: CanvasImageSource) => {
    const c = canvasOf(w, h);
    const cctx = c.getContext("2d", { willReadFrequently: true })!;
    cctx.drawImage(source, 0, 0, w, h);
    return cctx.getImageData(0, 0, w, h).data;
  };
  const before = read(frame);
  const after = read(ai);
  const bx0 = (center.x - size.w / 2) * w;
  const by0 = (center.y - size.h / 2) * h;
  const bw = size.w * w;
  const bh = size.h * h;
  const x0 = Math.max(0, Math.floor(bx0 - bw * reach.side));
  const x1 = Math.min(w - 1, Math.ceil(bx0 + bw * (1 + reach.side)));
  const y0 = Math.max(0, Math.floor(by0 - bh * reach.up));
  const y1 = Math.min(h - 1, Math.ceil(by0 + bh * (1 + reach.down)));
  const inBox = (x: number, y: number) =>
    x >= bx0 - bw * 0.15 && x <= bx0 + bw * 1.15 && y >= by0 - bh * 0.15 && y <= by0 + bh * 1.15;

  // Changed (or part of the object's box) pixels, then the connected piece that holds the box.
  const changed = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(before[i] - after[i]), Math.abs(before[i + 1] - after[i + 1]), Math.abs(before[i + 2] - after[i + 2]));
      if (d > AREA_CHANGED || inBox(x, y)) changed[y * w + x] = 1;
    }
  }
  if (solid) {
    // Meta's picture sits a few pixels off, so the room's edges all count as changed, joined up in a
    // net. Only pixels with changed ones all around them can carry the flood below.
    const raw = changed.slice();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (inBox(x, y)) continue;
        let all = true;
        for (let dy = -AREA_THIN; dy <= AREA_THIN && all; dy++) {
          for (let dx = -AREA_THIN; dx <= AREA_THIN && all; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && !raw[ny * w + nx]) all = false;
          }
        }
        if (!all) changed[y * w + x] = 0;
      }
    }
  }
  const keep = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inBox(x, y) && changed[y * w + x]) stack.push(y * w + x);
  while (stack.length) {
    const p = stack.pop()!;
    if (keep[p]) continue;
    keep[p] = 1;
    const x = p % w;
    const y = (p - x) / w;
    // 8 neighbours, so thin gaps (a bear's ear against the desk) don't split it.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const q = ny * w + nx;
        if (changed[q] && !keep[q]) stack.push(q);
      }
    }
  }

  if (solid) {
    // Whatever the outside can't reach is a hole in the picture: fill it.
    const outside = new Uint8Array(w * h);
    const open: number[] = [];
    const visit = (x: number, y: number) => {
      const p = y * w + x;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && !keep[p] && !outside[p]) {
        outside[p] = 1;
        open.push(p);
      }
    };
    for (let x = x0; x <= x1; x++) {
      visit(x, y0);
      visit(x, y1);
    }
    for (let y = y0; y <= y1; y++) {
      visit(x0, y);
      visit(x1, y);
    }
    while (open.length) {
      const p = open.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!outside[y * w + x]) keep[y * w + x] = 1;
  }

  // To a canvas, grown by 2 small pixels (fills pinholes, covers soft edges), then full size, softened.
  const small = canvasOf(w, h);
  const sctx = small.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  for (let p = 0; p < keep.length; p++) if (keep[p]) img.data[p * 4 + 3] = 255;
  sctx.putImageData(img, 0, 0);
  const grown = canvasOf(w, h);
  const gctx = grown.getContext("2d")!;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) gctx.drawImage(small, Math.cos(a) * 2, Math.sin(a) * 2);
  gctx.drawImage(small, 0, 0);
  const area = canvasOf(frame.width, frame.height);
  const actx = area.getContext("2d")!;
  actx.filter = `blur(${Math.max(2, Math.round((TRANSMUTE_FEATHER * area.width) / 1280))}px)`;
  actx.drawImage(grown, 0, 0, area.width, area.height);
  return area;
}

// Reality dial: show the real object (no change) in this edit's place, with one ripple.
export function showOriginal(target: Erase) {
  target.quick = target.patch;
  target.patch = canvasOf(target.alpha.width, target.alpha.height);
  target.status = "ai";
  target.aiAt = performance.now();
}

// Reality dial: this version isn't ready yet; show the real object with ripples meanwhile.
export function showPending(target: Erase) {
  target.patch = canvasOf(target.alpha.width, target.alpha.height);
  target.status = "filling";
}

export function markAiFailed(target: Erase) {
  target.status = "failed";
}

// Draws the virtual view: the camera frame with every edit on top, each shifted by how far the
// camera has moved since it was made (`motion` = scene motion now, 0..1 of frame).
// `mirrored` flips it like the real view.
// `selected`: the edit of the selected object, whose moved object glows blue.
// `front`: hands cut out of this camera frame, kept in front of the edits. An object being dragged
// goes on top of them: it's smaller than the fist holding it and would disappear.
export function drawVirtual(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  mirrored: boolean,
  motion: { x: number; y: number },
  now: number,
  selected: Erase | null,
  front: HTMLCanvasElement | null = null,
) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  if (mirrored) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  // Pinned edits first, all stretched at once.
  const pinned = edits.filter((e) => e.pin && e.status === "ai" && pinMatrix(e.pin));
  if (pinned.length) {
    const stretched = warpLayers(
      w,
      h,
      pinned.map((e) => ({ source: e.patch, matrix: pinMatrix(e.pin!)!, alpha: Math.min((now - e.aiAt) / FADE_MS, 1), gain: e.pin!.gain })),
    );
    if (stretched) ctx.drawImage(stretched, 0, 0, w, h);
  }
  const shiftOf = (e: Erase) => ({ x: (motion.x - e.motionAt.x) * w, y: (motion.y - e.motionAt.y) * h });
  // All the filled holes first, then the moved objects on top: a later hole must never cover an
  // object that was moved there earlier.
  for (const e of edits) {
    if (e.pin) {
      const at = pinPoint(e.pin, e.center.x, e.center.y);
      if (at) drawRipples(ctx, e, at.x * w, at.y * h, w, h, now);
      continue;
    }
    const s = shiftOf(e);
    const fade = e.status === "ai" ? Math.min((now - e.aiAt) / FADE_MS, 1) : 1;
    if (fade < 1) ctx.drawImage(e.quick, s.x, s.y);
    ctx.globalAlpha = fade;
    ctx.drawImage(e.patch, s.x, s.y);
    ctx.globalAlpha = 1;
    drawRipples(ctx, e, e.center.x * w + s.x, e.center.y * h + s.y, w, h, now);
  }
  // The selected object goes last: it must never be hidden behind another one.
  const inOrder = selected ? [...edits.filter((e) => e !== selected), selected] : edits;
  const sprites = (lifted: boolean) => {
    for (const e of inOrder) {
      if (!e.sprite || e.sprite.stored || e.sprite.lifted !== lifted) continue;
      const s = shiftOf(e);
      drawSprite(ctx, e.sprite, s.x, s.y, e === selected);
      if (e.sprite.busy) {
        const reach = Math.max(e.sprite.image.width, e.sprite.image.height) * 0.9 + 30;
        drawRings(ctx, e.sprite.x + e.sprite.dx + s.x + e.sprite.image.width / 2, e.sprite.y + e.sprite.dy + s.y + e.sprite.image.height / 2, reach, fillingRings(now));
      }
    }
  };
  sprites(false);
  if (front) ctx.drawImage(front, 0, 0, w, h);
  sprites(true);
  ctx.restore();
}

// The moved object, with a soft shadow so it sits on the desk. While dragged it's drawn a little
// bigger with the shadow further away, as if lifted.
function drawSprite(ctx: CanvasRenderingContext2D, s: Sprite, sceneX: number, sceneY: number, glow: boolean) {
  const { width: sw, height: sh } = s.image;
  const lift = s.lifted ? 1.06 : 1;
  const cx = s.x + s.dx + sceneX + sw / 2;
  const bottom = s.y + s.dy + sceneY + sh;
  ctx.save();
  ctx.filter = `blur(${s.lifted ? 10 : 6}px)`;
  ctx.fillStyle = `rgba(0, 0, 0, ${s.lifted ? 0.25 : 0.35})`;
  ctx.beginPath();
  ctx.ellipse(cx, bottom - sh * 0.08 + (s.lifted ? sh * 0.12 : 0), sw * 0.45, sh * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (glow) {
    ctx.save();
    ctx.shadowColor = "#0866ff";
    ctx.shadowBlur = 24;
  }
  ctx.drawImage(s.image, cx - (sw * lift) / 2, bottom - sh * lift - (s.lifted ? sh * 0.06 : 0), sw * lift, sh * lift);
  if (glow) ctx.restore();
}

// Water-like rings spreading from the erased spot while Meta works, and one last ring as the
// AI fill fades in.
function drawRipples(ctx: CanvasRenderingContext2D, e: Erase, cx: number, cy: number, w: number, h: number, now: number) {
  const reach = Math.max(e.size.w * w, e.size.h * h) * 0.9 + 30;
  const rings = e.status === "filling" ? fillingRings(now) : e.status === "ai" && now - e.aiAt < RIPPLE_LIFE_MS ? [(now - e.aiAt) / RIPPLE_LIFE_MS] : [];
  drawRings(ctx, cx, cy, reach, rings);
}

// Each ring's progress, 0..1, while Meta works.
function fillingRings(now: number) {
  const rings: number[] = [];
  for (let start = now - (now % RIPPLE_MS); start > now - RIPPLE_LIFE_MS; start -= RIPPLE_MS) {
    rings.push((now - start) / RIPPLE_LIFE_MS);
  }
  return rings;
}

function drawRings(ctx: CanvasRenderingContext2D, cx: number, cy: number, reach: number, rings: number[]) {
  for (const t of rings) {
    const eased = 1 - (1 - t) ** 2; // fast at first, slowing down, like a ripple on water
    ctx.globalAlpha = (1 - t) * 0.7;
    ctx.lineWidth = 2 + 4 * (1 - t);
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    // Slightly flattened, as the desk is seen at an angle.
    ctx.ellipse(cx, cy, reach * eased, reach * eased * 0.7, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Fills the hole by spreading the surrounding colors into it. Blurring a picture with a transparent
// hole fills the hole with an average of the nearby colors; drawing it several times makes it solid.
function quickFill(frame: HTMLCanvasElement, hole: HTMLCanvasElement, alpha: HTMLCanvasElement) {
  const { width: w, height: h } = frame;
  const withHole = canvasOf(w, h);
  const hctx = withHole.getContext("2d")!;
  hctx.drawImage(frame, 0, 0);
  hctx.globalCompositeOperation = "destination-out";
  hctx.drawImage(hole, 0, 0);

  const fill = canvasOf(w, h);
  const fctx = fill.getContext("2d")!;
  // Wide blur first (reaches the middle of bigger holes), then a tighter one for detail near the edge.
  for (const radius of [Math.round(w / 20), Math.round(w / 50)]) {
    fctx.filter = `blur(${radius}px)`;
    for (let i = 0; i < 4; i++) fctx.drawImage(withHole, 0, 0);
  }

  const patch = canvasOf(w, h);
  const pctx = patch.getContext("2d")!;
  pctx.drawImage(fill, 0, 0);
  pctx.globalCompositeOperation = "destination-in";
  pctx.drawImage(alpha, 0, 0);
  return patch;
}

function canvasOf(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
