import {
  initHighlighter,
  highlightAt,
  isOnHighlight,
  highlightBox,
  drawHighlight,
  clearHighlight,
  setHighlightColor,
  followHighlight,
  highlightSeed,
  type HighlightResult,
  objectShape,
  objectMask,
  maskToCanvas,
  highlightMeanColor,
} from "./highlight";
import { pointerFrom, pointsPast, FINGER_JOINTS, type Hand } from "./gestures";
import {
  startErase,
  startTransmute,
  showOriginal,
  showPending,
  applyAiFill,
  markAiFailed,
  storeSprite,
  spriteHome,
  clearErase,
  removeEdit,
  removeSprite,
  dragSprite,
  spriteOffset,
  spriteBox,
  spriteHasLook,
  setSpriteLook,
  setSpriteBusy,
  cutLook,
  composeVirtual,
  canvasJpeg,
  type Erase,
} from "./virtualView";
import { removeObject, transmuteObject, describeObject, replacementIdeas, type RemoveResult } from "./api";
import { dialTurn, dialProgress } from "./dial";
import { sceneMotion, trackScene, resetSceneTracker, islandOf, onIslandsJoined } from "./sceneTracker";
import { cameraFrame, isPhone } from "./camera";
import { EXTRA_GESTURES, trayGestures, drawTray } from "./hudTray";

// Reality Shift: a tray of objects you've locked, each of which you can move or erase in the
// virtual view. The RIGHT hand chooses, the LEFT hand changes (user's design); gestures act on
// the SELECTED object. Every gesture works with the back of the hand toward the camera (POV).
// Right hand:
//   Point + hold still -> (the line carries on across the view, like a laser) lock a new real object (it joins the tray and is selected), or select one
//                     that's already in the tray by pointing at it where it is in the VIRTUAL
//                     world: a moved object at its new spot. Its old spot counts as empty.
//   (off, see EXTRA_GESTURES) 3 fingers -> swipe through the tray (a HUD strip of cards at the top of the camera view,
//                     see hudTray.ts); ✌ held = select the card in the middle.
//   Open hand held 3 s -> transmute: the reality dial's next version (the first time, Muse Spark
//                     suggests things that could stand in the object's place and Muse Image makes
//                     all of them at once). Once they exist, twisting the open hand (dial.ts) steps through them.
// Left hand:
//   Fist held 2 s  -> grab the selected object and drag it; open the hand to drop it.
//   (off, see EXTRA_GESTURES) Open hand held 2 s -> remove the selected object: its change is undone and it leaves the tray.
//   Thumbs down held 1 s -> erase the selected object (a moved one too).
// Both hands:
//   Both fists held 2 s -> put the selected object back: its changes are undone, it leaves the tray.
//   (off, see EXTRA_GESTURES) Both open, held 1 s -> take the selected object out of the room into the inventory (its spot
//                     is filled). Select its card and hold a left fist: it appears in the fist, to
//                     be dragged and dropped anywhere, even after the camera has turned to another
//                     part of the room (sceneTracker.ts keeps everything in its place).
//   Command        -> transmute the selected object ("make it gold"): Muse Image changes it in place.
//   Tap            -> tap a real object to lock it (demo backup).
// The highlight follows one real object at a time (the selected one, or the one being chosen);
// that also measures how far the camera moves, which keeps every edit pinned to the scene.

type Phase = "idle" | "choosing" | "grabbing";
export type ItemState = "locked" | "moved" | "erased" | "changed" | "stored";

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

// One version on the reality dial: something that could stand in the object's place.
interface Variant {
  idea: string; // Muse Spark's suggestion, "" until it arrives
  image: string | null; // Muse Image's frame with it (data URL)
  status: "waiting" | "ready" | "failed";
  look?: HTMLCanvasElement; // it cut out of that frame, to be moved around
}

export interface Item {
  id: number;
  label: string; // Muse Spark's name for it, "" until it arrives
  state: ItemState;
  thumb: string; // picture of the object for its tray card (data URL)
  // Its outline when locked (1 = object), with the highlight offset at that time.
  mask: { pixels: Uint8Array; w: number; h: number; offset: Point };
  outline: HTMLCanvasElement; // the outline painted white, to mark it in the real view
  box: Box; // where it was when locked (0..1 of frame)
  seed: Point; // a point on it when locked
  color: number[]; // its average color, to re-find it safely
  motionAt: Point; // scene motion when locked: it moves with the scene from there
  edit: Erase | null; // its change in the virtual view
  command: string; // what it was changed into ("make it gold"), when transmuted
  variants: Variant[]; // the reality dial's versions of it (empty until the dial is first turned)
  variantAt: number; // which one is showing: 0 = the real object, 1.. = variants[i - 1]
  fill: AbortController | null; // its AI fill request, while waiting
  lookFill: AbortController | null; // Meta drawing a new look for it (the dial, or a moved object), while waiting
  source: { frame: HTMLCanvasElement; box: Box } | null; // what its new look is compared with to cut it out, and where
  result: string | null; // what a typed transmute came back with
  look: HTMLCanvasElement | null; // that, cut out
}

// How often to look for a new object while the cursor is off the current one. Each look takes tens of ms.
const SEGMENT_EVERY_MS = 200;
// Cursor must be off the current object this long before we look for a different one.
const SWITCH_MS = 250;
// If looking keeps failing for this long, drop the old highlight.
const DROP_MS = 700;
// Keep pointing at the same object this long to lock (or select) it.
const DWELL_MS = 1200;
// A pointing hand that moves more than this (0..1 of frame) starts its hold over: a hand reaching for
// or touching something isn't choosing it.
const POINT_STILL = 0.06;
// While choosing, the highlight stays this long after pointing drops out (pointing detection
// flickers), so a short dropout doesn't throw away the object or the lock progress.
const HOLD_MS = 1500;
// Where to look along the pointing line, in finger lengths (knuckle to tip) past the fingertip,
// near to far. Close points often catch the finger itself; further ones reach the object.
const REACHES = [0.4, 0.9, 1.5];
// Past those, the line carries on across the whole view, so something out of reach can be pointed at.
const AIM_STEP = 0.03; // of the frame: how closely the line is checked for what's already been found
const FAR_STRIDE = 7; // each look further along tries these points, stepping this many at a time
const FAR_LOOKS = isPhone ? 1 : 2; // looks per try: each takes tens of ms
// Held gestures (user's design): how long to hold each one.
const HOLD_TIMES = {
  transmute: 3000, // right open hand: the dial's next version
  grab: 2000, // left fist: grab the selected object
  remove: 2000, // left open hand: remove the selected object and its change
  store: 1000, // both hands open: take the selected object into the inventory
  erase: 1000, // left thumbs down: erase the selected object
  reset: 2000, // both fists: put the selected object back
};
type HoldAction = keyof typeof HOLD_TIMES;
// A held hand that moves more than this (0..1 of frame) starts its hold over.
const HOLD_STILL = 0.12;
// A held gesture missing for less than this (a flicker, a missed frame) doesn't restart the hold.
const HOLD_GRACE_MS = 300;
// While dragging, no fist for this long = dropped (a single missed frame isn't a drop).
const RELEASE_MS = 250;
// With an object selected, pointing must last this long to start choosing, so a hand opening
// after a drop (which can look like pointing for a moment) doesn't count.
const START_POINT_MS = 300;
// Length of the "pop" when an object locks.
const POP_MS = 450;
// Re-find the followed object's outline at its new position this often.
const REFRESH_MS = 500;
// When the selected object isn't being followed (hand covered it, just selected), try to find it
// again this often.
const REFOLLOW_MS = 400;
// A re-found outline must be about the same color as the object (0..441 RGB distance), so it
// can't slip onto a same-sized patch of desk right next to it.
const MAX_REFRESH_COLOR_CHANGE = 40;
// If the followed object can't be found for this long, stop following it (and look again later).
const LOST_MS = 1500;
// How many versions the reality dial makes (each is one Muse Image call, ~1 cent).
const DIAL_VERSIONS = 4;
// The transmute hold asks Muse Spark for ideas this far in, unseen, so they're ready sooner after
// the 3 s are up. Letting go first cancels it; the paid pictures only start once the hold completes.
const EARLY_IDEAS_MS = 1000;
// Debug summary in the log every this often, while a hand is in view.
const STATS_EVERY_MS = 3000;
// The middle finger's knuckle: the center of the palm, steadier than the fingertips.
const MIDDLE_KNUCKLE = 9;

export type CaptureReason = "not-pointing" | "no-object" | "background" | "hand" | "different" | "ok";
export type CaptureFn = (reason: CaptureReason, hand: Hand, extra: Partial<HighlightResult>) => void;

let ready = false;
let phase: Phase = "idle";
let items: Item[] = [];
let selected: Item | null = null;
let nextId = 1;

// What the highlight is on: a candidate being chosen (blue), or a tray object being followed (green).
let hasHighlight = false;
let hasCandidate = false;
let following: Item | null = null;

let hoverItem: Item | null = null; // tray object the pointer is on while choosing
let cursor: Point | null = null;
// The aiming line, drawn from the fingertip like a laser pointer so you can see where you aim.
let ray: { from: Point; to: Point } | null = null;
let lastSegment = 0;
let lastPointing = 0;
let pointSince: number | null = null;
let offTargetSince: number | null = null;
let dwell = 0; // ms spent pointing at the current object
let pointAnchor: { x: number; y: number } | null = null; // where the pointing hand was when that started
let farLook = 0; // which point far along the pointing line to look at next
let lookedFar = true; // so the first look is near the fingertip
let lockedAt = 0;
// The held gesture in progress, drawn as a filling ring around the selected object. `done` = it
// already acted; change the hand to do it again.
let hold: { what: HoldAction; since: number; seen: number; at: Point; done: boolean } | null = null;
// False right after a drop (the left hand opens to drop), until the left hand stops being open,
// so dropping an object doesn't go on to remove it.
let removeArmed = true;
// Ideas asked for early by a transmute hold that hasn't finished yet.
let earlyIdeas: { item: Item; ideas: Promise<string[]>; request: AbortController } | null = null;
let trackedFrame = -1; // the camera frame sceneTracker last saw
let grip = { x: 0, y: 0 }; // from the object's center to the fist, on screen, while dragging
let noFistSince: number | null = null;
let lastFrame = 0;
let followedFrame = -1;
let lastRefresh = 0;
let lastRefollow = 0;
let lostSince: number | null = null;
let log: (message: string) => void = () => {};
let capture: CaptureFn | null = null;
let onChange: () => void = () => {};

// Counters for the debug summary.
let stats = newStats();
let statsStart = 0;
let lastCapture = 0;
let lastBackgroundLog = 0;

function newStats() {
  return {
    frames: 0,
    handFrames: 0,
    rawPoint: 0,
    stablePoint: 0,
    ok: 0,
    noObject: 0,
    background: 0,
    hand: 0,
    totalMs: 0,
    straight: [0, 0, 0, 0], // summed finger straightness while a hand is in view but not pointing
    notPointing: 0,
    followed: 0, // frames where we tried to follow the highlighted object
    followMatched: 0,
    followDiff: 0, // summed match difference (lower = better match)
  };
}

// The camera tracker joined two parts of the room it had kept apart: everything remembered on the
// joined part shifts with it.
onIslandsJoined((from, shift) => {
  const rebase = (m: Point) => {
    if (islandOf(m) !== from) return;
    m.x -= shift.x;
    m.y -= shift.y;
  };
  for (const item of items) {
    rebase(item.motionAt);
    if (item.edit) rebase(item.edit.motionAt);
  }
});

export async function initRealityShift(logger: (message: string) => void) {
  log = logger;
  const delegate = await initHighlighter();
  ready = true;
  return delegate;
}

// Pass a function to receive frames worth debugging, or null to stop.
export function setCapture(fn: CaptureFn | null) {
  capture = fn;
}

// Called whenever the tray changes (objects added, renamed, changed, selected), to redraw it.
export function onItemsChanged(fn: () => void) {
  onChange = fn;
}

export function trayItems(): readonly Item[] {
  return items;
}

export function selectedItem(): Item | null {
  return selected;
}

export function shiftPhase(): Phase {
  return phase;
}

function nameOf(item: Item) {
  return item.label ? `"${item.label}"` : `object ${item.id}`;
}

// ---------- Where tray objects are now ----------

// How far the scene has moved since `since` (0..1 of frame).
function shiftSince(since: Point): Point {
  const now = sceneMotion();
  return { x: now.x - since.x, y: now.y - since.y };
}

// Is `p` on the item's real object (where it physically is now)?
function onOriginal(item: Item, p: Point): boolean {
  const d = shiftSince(item.motionAt);
  const { pixels, w, h, offset } = item.mask;
  const x = Math.floor((p.x - d.x - offset.x) * w);
  const y = Math.floor((p.y - d.y - offset.y) * h);
  return x >= 0 && y >= 0 && x < w && y < h && pixels[y * w + x] === 1;
}

// Is `p` on the item's moved copy in the virtual view?
function onMoved(item: Item, p: Point): boolean {
  if (item.state === "moved" && item.edit && spriteHasLook(item.edit)) {
    // Transmuted: the old outline says nothing about its shape now.
    const b = spriteBox(item.edit, sceneMotion());
    return !!b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  }
  const drag = item.state === "moved" && item.edit ? spriteOffset(item.edit) : null;
  return drag !== null && onOriginal(item, { x: p.x - drag.x, y: p.y - drag.y });
}

// The item's box where it is now in the VIRTUAL world (moved objects at their new spot).
function virtualBox(item: Item): Box {
  if (item.state === "moved" && item.edit && spriteHasLook(item.edit)) {
    const b = spriteBox(item.edit, sceneMotion());
    if (b) return b;
  }
  const d = shiftSince(item.motionAt);
  const drag = item.state === "moved" && item.edit ? spriteOffset(item.edit) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
  return { ...item.box, x: item.box.x + d.x + drag.x, y: item.box.y + d.y + drag.y };
}

// The item's real object's box where it is now.
function realBox(item: Item): Box {
  const d = shiftSince(item.motionAt);
  return { ...item.box, x: item.box.x + d.x, y: item.box.y + d.y };
}

// What's along the pointing line in the virtual world: a tray object, or the points that are free to
// look for a new real object. A moved object is found at its new spot, and any object at its original
// spot too: that's how you choose it again, and it can't be locked a second time there.
function lookAlong(points: Point[]): { item: Item; at: Point } | { free: Point[] } {
  const free: Point[] = [];
  const newestFirst = [...items].reverse();
  for (const p of points) {
    const item = newestFirst.find((i) => onMoved(i, p)) ?? newestFirst.find((i) => onOriginal(i, p));
    if (item) return { item, at: p };
    free.push(p);
  }
  return { free };
}

// Still where it really is in the virtual world (not moved away or erased).
function inPlace(item: Item) {
  return item.state === "locked" || item.state === "changed";
}

// ---------- Changing the tray ----------

// Locks the highlighted candidate: it becomes a tray object and is selected.
function lockCandidate(video: HTMLVideoElement, how: string, now: number) {
  const mask = objectMask();
  const box = highlightBox();
  const seed = highlightSeed();
  if (!mask || !box || !seed) return;
  const item: Item = {
    id: nextId++,
    label: "",
    state: "locked",
    thumb: thumbnail(video, mask, box),
    mask,
    outline: maskToCanvas(mask.pixels, mask.w, mask.h, [255, 255, 255, 230], true),
    box,
    seed,
    color: highlightMeanColor() ?? [0, 0, 0],
    motionAt: sceneMotion(),
    edit: null,
    command: "",
    variants: [],
    variantAt: 0,
    fill: null,
    lookFill: null,
    source: null,
    result: null,
    look: null,
  };
  items.push(item);
  selected = item;
  following = item;
  hasCandidate = false;
  setHighlightColor("green");
  lockedAt = now;
  phase = "idle";
  dwell = 0;
  hoverItem = null;
  pointSince = null;
  log(`object ${item.id} locked (${how}), size ${Math.round(box.w * 100)}% x ${Math.round(box.h * 100)}% of view`);
  onChange();

  // Muse Spark names it for the tray (and later erases reuse the name).
  frameJpeg(video)
    .then((frame) => describeObject(frame, box))
    .then((label) => {
      // "object" means Muse Spark couldn't name it: leave it unnamed, so erasing asks again
      // (a vague name makes Muse Image leave the object in).
      if (label === "object") {
        log(`couldn't name object ${item.id} yet`);
        return;
      }
      item.label = label;
      log(`object ${item.id} is a ${label}`);
      onChange();
    })
    .catch((err) => log(`naming object ${item.id} failed: ${(err as Error).message}`));
}

function select(item: Item, how: string) {
  if (selected === item) return;
  // The highlight moves to it over the next frames (refollow); until then its outline shows.
  stopFollowing();
  selected = item;
  lastRefollow = 0;
  pointSince = null;
  log(`selected ${nameOf(item)} (${how})`);
  onChange();
}

// Starts a change for the item in the virtual view: erase its spot (quick fill now, Meta's AI fill
// when it arrives), and with `cutOut` also keep a cut-out of it that can be dragged.
function startChange(video: HTMLVideoElement, item: Item, cutOut: boolean) {
  // Its outline and box where it is now: the live highlight if it's being followed, otherwise
  // what was remembered at lock time, moved along with the scene.
  let shape = following === item ? objectShape() : null;
  let box = following === item ? highlightBox() : null;
  if (!shape || !box) {
    const d = shiftSince(item.motionAt);
    shape = {
      canvas: maskToCanvas(item.mask.pixels, item.mask.w, item.mask.h),
      offset: { x: item.mask.offset.x + d.x, y: item.mask.offset.y + d.y },
    };
    box = realBox(item);
  }
  const { edit, frame } = startErase(video, shape, box, cutOut, sceneMotion());
  item.edit = edit;
  item.state = cutOut ? "moved" : "erased";
  const where = box;
  askMeta(item, edit, frame, (f, signal) => removeObject(f, where, signal, item.label || undefined), "erased");
}

// Sends the frame to Meta for the item's edit and swaps in the result when it arrives.
// A reset or undo stops waiting; Meta still finishes a job it already has (and bills it), but its
// result can never land in a later edit.
function askMeta(
  item: Item,
  edit: Erase,
  frame: Promise<Blob>,
  call: (frame: Blob, signal: AbortSignal) => Promise<RemoveResult>,
  done: string,
  onResult?: (image: string) => void,
) {
  const request = new AbortController();
  item.fill = request;
  frame
    .then((f) => call(f, request.signal))
    .then(async (r) => {
      if (request.signal.aborted) return;
      if (!item.label && r.label !== "object") item.label = r.label;
      if (await applyAiFill(edit, r.image, r.label)) {
        log(`AI result ready for ${nameOf(item)} (${done} in ${r.edit_ms} ms)`);
        onResult?.(r.image);
      }
      else log(`Meta's result for ${nameOf(item)} barely changed it, ${done === "erased" ? "keeping the quick fill" : "showing it unchanged"}`);
      onChange();
    })
    .catch((err) => {
      if (request.signal.aborted) return;
      markAiFailed(edit);
      log(`AI edit failed for ${nameOf(item)}: ${(err as Error).message}`);
      onChange();
    })
    .finally(() => {
      if (item.fill === request) item.fill = null;
    });
}

// Transmutes the selected object: Meta's Muse Image changes it in place as `command` says
// ("make it gold"), wherever it is. A changed object can be changed again (from the original), moved,
// erased or undone.
export function transmuteSelected(video: HTMLVideoElement, command: string, how: string): boolean {
  const item = selected;
  command = command.trim();
  if (!item || !command || phase === "grabbing") return false;
  if (item.state === "erased" || item.state === "stored") {
    log(`${nameOf(item)} is ${item.state}: put it back first (Put object back button), then lock it again`);
    return false;
  }
  if (item.state === "moved") return transmuteMoved(video, item, command, how);
  if (item.state === "changed") clearChange(item);
  const box = following === item ? (highlightBox() ?? realBox(item)) : realBox(item);
  const { edit, frame } = startTransmute(video, box, sceneMotion());
  item.edit = edit;
  item.state = "changed";
  item.command = command;
  log(`transmuting ${nameOf(item)}: "${command}" (${how}), asking Meta's Muse Image…`);
  item.source = { frame: edit.frame, box };
  askMeta(item, edit, frame, (f, signal) => transmuteObject(f, box, command, signal, item.label || undefined), "changed", (image) => {
    item.result = image;
    cutLook(image, edit.frame, box).then((look) => {
      if (item.result === image) item.look = look;
    });
  });
  onChange();
  return true;
}

// A moved object, on screen, right now. null if the camera has turned away from it.
function movedBoxInView(edit: Erase): Box | null {
  const b = spriteBox(edit, sceneMotion());
  if (!b) return null;
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  const w = Math.min(1, b.x + b.w) - x;
  const h = Math.min(1, b.y + b.h) - y;
  return w > 0.02 && h > 0.02 ? { x, y, w, h } : null;
}

// Changes a moved object where it is now: Meta edits the virtual view, and the result becomes its cut-out.
function transmuteMoved(video: HTMLVideoElement, item: Item, command: string, how: string): boolean {
  const edit = item.edit;
  const box = edit && movedBoxInView(edit);
  if (!edit || !box) {
    log(`${nameOf(item)} isn't in view: turn the camera back to it first`);
    return false;
  }
  item.lookFill?.abort();
  item.variants = [];
  item.variantAt = 0;
  const frame = composeVirtual(video, sceneMotion());
  const clean = composeVirtual(video, sceneMotion(), edit);
  item.source = { frame: clean, box };
  item.command = command;
  const request = new AbortController();
  item.lookFill = request;
  setSpriteBusy(edit, true);
  log(`transmuting ${nameOf(item)} where it is now: "${command}" (${how}), asking Meta's Muse Image…`);
  canvasJpeg(frame)
    .then((f) => transmuteObject(f, box, command, request.signal, item.label || undefined))
    .then((r) => cutLook(r.image, clean, box))
    .then((look) => {
      if (request.signal.aborted) return;
      if (!look) {
        log(`Meta's result for ${nameOf(item)} barely changed it, keeping it as it was`);
        return;
      }
      item.look = look;
      setSpriteLook(edit, look);
      log(`${nameOf(item)} transmuted where it is now, ${whereIs(edit)}`);
    })
    .catch((err) => {
      if (!request.signal.aborted) log(`transmute failed for ${nameOf(item)}: ${(err as Error).message}`);
    })
    .finally(() => {
      if (item.lookFill !== request) return;
      item.lookFill = null;
      setSpriteBusy(edit, false);
      onChange();
    });
  onChange();
  return true;
}

// Drops the item's virtual change (and stops waiting for Meta): it's back to its real self.
function clearChange(item: Item) {
  item.fill?.abort();
  item.fill = null;
  item.lookFill?.abort();
  item.lookFill = null;
  item.source = null;
  item.result = null;
  item.look = null;
  if (item.edit) removeEdit(item.edit);
  item.edit = null;
  item.command = "";
  item.variants = [];
  item.variantAt = 0;
  item.state = "locked";
}

// ---------- The reality dial ----------

// Steps the item's dial one way. The first turn asks Meta for all the versions at once.
function turnDial(video: HTMLVideoElement, item: Item, dir: 1 | -1) {
  if (item.state === "erased" || item.state === "stored") {
    log(`${nameOf(item)} is ${item.state}: put it back first (Put object back button), then lock it again`);
    return;
  }
  if (item.state === "moved" && !item.variants.length && !(item.edit && movedBoxInView(item.edit))) {
    log(`${nameOf(item)} isn't in view: turn the camera back to it first`);
    return;
  }
  // The first turn, either way, goes to the first version.
  const first = !item.variants.length;
  if (first) startDial(video, item);
  // Skip versions that failed; 0 (the real object) is always there.
  const n = item.variants.length + 1;
  let at = first ? 0 : item.variantAt;
  if (first) dir = 1;
  do at = (at + dir + n) % n;
  while (at !== 0 && item.variants[at - 1].status === "failed");
  item.variantAt = at;
  showVariant(item);
  const v = at ? item.variants[at - 1] : null;
  log(`dial ${at}/${n - 1}: ${v ? v.idea || "waiting for Muse Spark's ideas" : `${nameOf(item)} as it really is`}`);
}

// A transmute hold is under way: ask for the ideas now, nothing shows yet.
function askIdeasEarly(video: HTMLVideoElement, item: Item) {
  const box = (following === item ? highlightBox() : null) ?? realBox(item);
  const request = new AbortController();
  const ideas = frameJpeg(video).then((f) => replacementIdeas(f, box, DIAL_VERSIONS, request.signal, item.label || undefined));
  ideas.catch(() => {}); // a cancel; if the dial starts it handles a failure itself
  earlyIdeas = { item, ideas, request };
}

function cancelEarlyIdeas() {
  earlyIdeas?.request.abort();
  earlyIdeas = null;
}

// Muse Spark suggests what could stand in the object's place, then Muse Image makes every
// version at the same time; each shows up on the dial as it arrives.
function startDial(video: HTMLVideoElement, item: Item) {
  const early = earlyIdeas?.item === item ? earlyIdeas : null;
  earlyIdeas = null;
  // A moved object is changed where it is now; anything else, in its real place.
  const moved = item.state === "moved" && item.edit ? item.edit : null;
  let box: Box;
  let frame: Promise<Blob>;
  if (moved) {
    box = movedBoxInView(moved)!;
    item.lookFill?.abort();
    const picture = composeVirtual(video, sceneMotion());
    item.source = { frame: composeVirtual(video, sceneMotion(), moved), box };
    frame = canvasJpeg(picture);
    setSpriteBusy(moved, true);
  } else {
    if (item.state === "changed") clearChange(item);
    box = (following === item ? highlightBox() : null) ?? realBox(item);
    const made = startTransmute(video, box, sceneMotion(), true);
    item.edit = made.edit;
    item.state = "changed";
    item.source = { frame: made.edit.frame, box };
    frame = made.frame;
  }
  item.variants = Array.from({ length: DIAL_VERSIONS }, (): Variant => ({ idea: "", image: null, status: "waiting" }));
  const variants = item.variants;
  const request = new AbortController();
  item.lookFill = request;
  request.signal.addEventListener("abort", () => early?.request.abort());
  const label = item.label || undefined;
  let settled = 0;
  const done = (v: Variant) => {
    if (request.signal.aborted) return;
    const showing = item.variants[item.variantAt - 1];
    if (showing && showing.status !== "ready" && v.status === "ready") {
      // Nothing to look at yet: jump to whichever version finished first.
      item.variantAt = variants.indexOf(v) + 1;
      log(`dial ${item.variantAt}/${variants.length}: ${v.idea} (first one ready)`);
      showVariant(item);
    } else if (showing === v) showVariant(item);
    if (++settled === variants.length && item.lookFill === request) item.lookFill = null;
    onChange();
  };
  log(`reality dial for ${nameOf(item)}: asking Muse Spark for ideas, then Muse Image for ${DIAL_VERSIONS} versions…`);
  frame
    .then(async (f) => {
      const ideas = await (early?.ideas ?? replacementIdeas(f, box, DIAL_VERSIONS, request.signal, label));
      if (request.signal.aborted) return;
      log(`dial ideas for ${nameOf(item)}: ${ideas.join(", ")}`);
      variants.forEach((v, i) => {
        v.idea = ideas[i] ?? ideas[0];
        transmuteObject(f, box, `replace it with ${v.idea}`, request.signal, label)
          .then((r) => {
            v.image = r.image;
            v.status = "ready";
            done(v);
          })
          .catch((err) => {
            if (request.signal.aborted) return;
            v.status = "failed";
            log(`dial: making "${v.idea}" failed: ${(err as Error).message}`);
            done(v);
          });
      });
      onChange();
    })
    .catch((err) => {
      if (request.signal.aborted) return;
      variants.forEach((v) => (v.status = "failed"));
      log(`reality dial failed for ${nameOf(item)}: ${(err as Error).message}`);
      item.variantAt = 0;
      showVariant(item);
      onChange();
    });
}

// Shows the dial's current version of the item in the virtual view.
function showVariant(item: Item) {
  const edit = item.edit;
  if (!edit) return;
  const v = item.variantAt ? item.variants[item.variantAt - 1] : null;
  item.command = v?.idea ? `replace it with ${v.idea}` : "";
  if (item.state === "moved") {
    setSpriteBusy(edit, v?.status === "waiting");
    if (!v || v.status === "failed") setSpriteLook(edit, null);
    else if (v.image) {
      lookOf(item, v).then((look) => {
        if (item.variants[item.variantAt - 1] !== v) return;
        if (look) {
          setSpriteLook(edit, look);
          log(`showing "${v.idea}", ${whereIs(edit)}`);
          return;
        }
        // Nothing to show: back to the real object, and the dial skips this one from now on.
        item.variantAt = 0;
        item.command = "";
        setSpriteLook(edit, null);
        onChange();
      });
    }
    onChange();
    return;
  }
  if (!v || v.status === "failed") showOriginal(edit);
  else if (v.status === "waiting" || !v.image) showPending(edit);
  else {
    applyAiFill(edit, v.image, v.idea).then((ok) => {
      if (ok) return;
      v.status = "failed";
      log(`dial: Muse Image's "${v.idea}" looked the same as the real object, skipping it`);
      if (item.variants[item.variantAt - 1] === v) showOriginal(edit);
    });
    lookOf(item, v); // ready in case it gets grabbed
  }
  onChange();
}

// For the log: how big a moved object is and where, so "it's gone" can be told from "it's off screen".
function whereIs(edit: Erase) {
  const b = spriteBox(edit, sceneMotion());
  if (!b) return "not in the room";
  const pct = (v: number) => Math.round(v * 100);
  const seen = b.x < 1 && b.x + b.w > 0 && b.y < 1 && b.y + b.h > 0;
  return `${pct(b.w)}% x ${pct(b.h)}% of view at ${pct(b.x + b.w / 2)}%, ${pct(b.y + b.h / 2)}%${seen ? "" : " (out of view)"}`;
}

// A dial version, cut out so it can be moved around.
async function lookOf(item: Item, v: Variant): Promise<HTMLCanvasElement | null> {
  if (v.look) return v.look;
  if (!v.image || !item.source) return null;
  try {
    const look = await cutLook(v.image, item.source.frame, item.source.box);
    if (look) {
      v.look = look;
      return look;
    }
    v.status = "failed";
    log(`dial: Muse Image's "${v.idea}" came back with nothing to cut out, skipping it`);
    return null;
  } catch (err) {
    log(`couldn't cut out "${v.idea}": ${(err as Error).message}`);
    return null;
  }
}

// Erases the selected object (also the "Erase" button). A moved one disappears from its new spot.
export function eraseSelected(video: HTMLVideoElement, how: string): boolean {
  const item = selected;
  if (!item || phase === "grabbing") return false;
  if (item.state === "changed") clearChange(item);
  if (item.state === "locked") {
    startChange(video, item, false);
    log(`erasing ${nameOf(item)} (${how}): quick fill now, asking Meta's Muse Image for a clean fill…`);
  } else if ((item.state === "moved" || item.state === "stored") && item.edit) {
    item.lookFill?.abort();
    item.lookFill = null;
    removeSprite(item.edit);
    item.state = "erased";
    log(`erased ${nameOf(item)} (${how})`);
  } else {
    return false;
  }
  onChange();
  return true;
}

// Grabs the selected object with the fist at `palm`: it starts following the fist.
function grabSelected(video: HTMLVideoElement, palm: Point) {
  const item = selected;
  if (!item) return;
  if (item.state === "erased") {
    log(`${nameOf(item)} is erased: can't move it (use the Put object back button to start over)`);
    return;
  }
  if (item.state === "changed" && item.edit?.status === "filling") {
    log(`${nameOf(item)} is still being drawn: wait for it, then grab it`);
    return;
  }
  if (item.state === "stored" && item.edit) {
    // Out of the inventory: it appears in the fist.
    storeSprite(item.edit, false);
    item.state = "moved";
    grip = { x: 0, y: 0 };
    log(`took ${nameOf(item)} out of the inventory: move your fist to place it, open your hand to drop it`);
  } else {
    if (item.state === "changed") {
      pickUpChanged(video, item);
      log(`grabbed ${nameOf(item)} as it is now: move your fist to drag it, open your hand to drop it`);
    } else if (item.state === "locked") {
      startChange(video, item, true);
      log(`grabbed ${nameOf(item)}: move your fist to drag it, open your hand to drop it`);
    } else {
      log(`picked up ${nameOf(item)} again`);
    }
    const on = item.edit ? spriteOnScreen(item.edit) : null;
    grip = on ? { x: palm.x - on.x, y: palm.y - on.y } : { x: 0, y: 0 };
  }
  phase = "grabbing";
  noFistSince = null;
  onChange();
}

// A transmuted object becomes a moved one: its real spot gets filled like any move, and the cut-out
// wears what Meta drew.
function pickUpChanged(video: HTMLVideoElement, item: Item) {
  const showing = item.variantAt ? item.variants[item.variantAt - 1] : null;
  const image = showing ? showing.image : item.result;
  const look = showing ? showing.look : item.look;
  if (item.edit) removeEdit(item.edit);
  item.edit = null;
  item.state = "locked";
  startChange(video, item, true);
  const edit = item.edit as Erase | null;
  if (!edit) return;
  if (look) setSpriteLook(edit, look);
  else if (image && item.source) cutLook(image, item.source.frame, item.source.box).then((l) => l && setSpriteLook(edit, l));
}

// Where a moved object's center is on screen now (0..1 of frame).
function spriteOnScreen(edit: Erase): Point | null {
  const home = spriteHome(edit);
  const at = spriteOffset(edit);
  if (!home || !at) return null;
  const d = shiftSince(edit.motionAt);
  return { x: home.x + at.x + d.x, y: home.y + at.y + d.y };
}

// Takes the selected object out of the room into the inventory. Its spot is filled like a move.
function storeSelected(video: HTMLVideoElement) {
  const item = selected;
  if (!item) return;
  if (item.state === "erased" || item.state === "changed" || item.state === "stored") {
    log(`${nameOf(item)} is ${item.state}: can't put it in the inventory (use the Put object back button to start over)`);
    return;
  }
  if (item.state === "locked") startChange(video, item, true);
  if (item.edit) storeSprite(item.edit, true);
  item.state = "stored";
  if (following === item) stopFollowing();
  log(`${nameOf(item)} is in the inventory: hold a left fist to take it out and place it anywhere`);
  onChange();
}

// Takes the item out of the tray and shows it as it really is again (its change is undone too).
export function removeItem(item: Item, how: string) {
  const changed = item.state !== "locked" && item.edit;
  clearChange(item);
  if (phase === "grabbing" && selected === item) phase = "idle";
  items = items.filter((i) => i !== item);
  if (selected === item) selected = null;
  if (following === item) stopFollowing();
  log(`removed ${nameOf(item)} from the tray${changed ? ", back to how it really is" : ""} (${how})`);
  onChange();
}

// Clears everything: all objects back, tray empty.
export function resetRealityShift() {
  cancelEarlyIdeas();
  resetSceneTracker();
  trackedFrame = -1;
  const waiting = items.filter((i) => i.fill).length;
  items.forEach((i) => {
    i.fill?.abort();
    i.lookFill?.abort();
  });
  if (waiting) log(`stopped waiting for ${waiting} AI fill(s) (Meta may still finish them, about 1 cent each)`);
  items = [];
  selected = null;
  nextId = 1;
  clearErase();
  stopFollowing();
  phase = "idle";
  hoverItem = null;
  dwell = 0;
  onChange();
}

function stopFollowing() {
  hasHighlight = false;
  hasCandidate = false;
  following = null;
  lostSince = null;
  clearHighlight();
}

// ---------- Every frame ----------

// `mirrored`: the view is shown mirrored (for swiping the tray the way the hand moves on screen).
export function updateRealityShift(video: HTMLVideoElement, hands: Hand[], now: number, mirrored: boolean) {
  if (!ready) return;
  const dt = lastFrame ? Math.min(now - lastFrame, 100) : 0;
  lastFrame = now;

  // The right hand chooses, the left hand changes.
  const right = hands.filter((h) => h.side === "Right");
  const left = hands.filter((h) => h.side === "Left");
  const hand = right[0] ?? hands[0];
  const pointing = right.find((h) => h.gesture === "Point");
  const fist = left.find((h) => h.gesture === "Closed_Fist");
  const thumbDown = left.find((h) => h.gesture === "Thumb_Down");
  // Counted whichever hand is which, and always the same one of them to check it's held still.
  const fists = hands.filter((h) => h.gesture === "Closed_Fist").sort((a, b) => a.landmarks[MIDDLE_KNUCKLE].x - b.landmarks[MIDDLE_KNUCKLE].x);
  collectStats(hands, now);

  // Follow the camera, leaving the hands out.
  if (cameraFrame(video) !== trackedFrame) {
    trackedFrame = cameraFrame(video);
    trackScene(video, hands.map((h) => h.landmarks));
  }
  const palms = hands.filter((h) => h.gesture === "Open_Palm");
  const bothOpen = EXTRA_GESTURES && palms.length >= 2;

  if (hasHighlight && cameraFrame(video) !== followedFrame) {
    followedFrame = cameraFrame(video);
    follow(video, hands, now);
  }

  // The HUD tray: three fingers swipe it, ✌ selects the card in the middle.
  const pick = EXTRA_GESTURES ? trayGestures(right, items, selected ? items.indexOf(selected) : -1, mirrored, now) : null;
  if (pick !== null && items[pick]) select(items[pick], "tray");

  // Twisting the right open hand steps through the versions the hold made. It never starts them: a
  // hand turns by itself as it moves, and starting them costs about 4 cents.
  const turn = dialTurn(bothOpen ? [] : right, mirrored, now);
  if (turn && selected?.variants.length) {
    if (hold?.what === "transmute") hold.done = true; // the twist was the change; don't also step on the hold
    if (phase === "idle") turnDial(video, selected, turn);
  }
  if (!left.some((h) => h.gesture === "Open_Palm")) removeArmed = true;
  // Let go of the transmute hold before it finished (or selected something else): cancel.
  if (earlyIdeas && (hold?.what !== "transmute" || now - hold.seen > HOLD_GRACE_MS || selected !== earlyIdeas.item)) {
    log(`transmute cancelled for ${nameOf(earlyIdeas.item)}`);
    cancelEarlyIdeas();
  }

  if (phase === "grabbing") {
    cursor = null;
    const edit = selected?.edit;
    if (!edit) {
      phase = "idle";
      return;
    }
    if (fist) {
      noFistSince = null;
      // The object stays with the hand on screen, however the camera turns.
      const p = fist.landmarks[MIDDLE_KNUCKLE];
      const home = spriteHome(edit);
      const d = shiftSince(edit.motionAt);
      if (home) dragSprite(edit, p.x - grip.x - home.x - d.x, p.y - grip.y - home.y - d.y, true);
    } else {
      noFistSince ??= now;
      if (now - noFistSince > RELEASE_MS) {
        const at = spriteOffset(edit);
        if (at) dragSprite(edit, at.x, at.y, false);
        phase = "idle";
        removeArmed = false;
        log(`dropped ${nameOf(selected!)} (hold a left fist to pick it up again)`);
        onChange();
      }
    }
    return;
  }

  if (pointing) {
    pointSince ??= now;
    // With an object selected, pointing must last a moment before it counts (see START_POINT_MS).
    if (phase !== "choosing" && (!selected || now - pointSince > START_POINT_MS)) {
      phase = "choosing";
      log(selected ? "choosing another object (point and hold)" : "choosing: point at an object and hold to lock");
    }
    if (phase === "choosing") {
      lastPointing = now;
      cursor = pointing.pointer;
      choose(video, pointing, now, dt);
      return;
    }
  } else {
    pointSince = null;
  }

  cursor = null;
  if (hand && hand.rawGesture !== "Point") maybeCapture("not-pointing", hand, {}, now, 2000);

  // A fist or thumbs down ends choosing right away, so it can act on the selected object.
  if (phase === "choosing" && (now - lastPointing > HOLD_MS || fists.length >= 2 || (selected && (fist || thumbDown)))) {
    endChoosing(now - lastPointing > HOLD_MS ? "not pointing" : "hand gesture");
  }

  if (phase === "idle" && selected) {
    // Held hands: both fists = put it back, left thumbs down = erase, left fist = grab, left open hand =
    // remove, right open hand = transmute.
    const leftPalm = EXTRA_GESTURES && removeArmed ? left.find((h) => h.gesture === "Open_Palm") : undefined;
    const rightPalm = right.find((h) => h.gesture === "Open_Palm");
    if (fists.length >= 2) holdStep(video, "reset", fists[0], now);
    else if (thumbDown) holdStep(video, "erase", thumbDown, now);
    else if (bothOpen) holdStep(video, "store", palms[0], now);
    else if (fist) holdStep(video, "grab", fist, now);
    else if (leftPalm) holdStep(video, "remove", leftPalm, now);
    else if (rightPalm) holdStep(video, "transmute", rightPalm, now);
    else if (hold && now - hold.seen > HOLD_GRACE_MS) hold = null;
  } else {
    hold = null;
  }

  // Keep the selected object followed, so the scene motion keeps being measured.
  if (selected && following !== selected && !hasCandidate && now - lastRefollow > REFOLLOW_MS) {
    lastRefollow = now;
    refollow(video, selected, hands);
  }
}

// One frame of a held gesture: restarts it if it changed or the hand moved, acts once it has been
// held long enough.
function holdStep(video: HTMLVideoElement, what: HoldAction, hand: Hand, now: number) {
  const at = hand.landmarks[MIDDLE_KNUCKLE];
  const moved = hold && what !== "store" && Math.hypot(at.x - hold.at.x, at.y - hold.at.y) > HOLD_STILL;
  if (!hold || hold.what !== what || moved || now - hold.seen > HOLD_GRACE_MS) {
    hold = { what, since: now, seen: now, at: { x: at.x, y: at.y }, done: false };
  }
  hold.seen = now;
  if (what === "transmute" && !hold.done && !earlyIdeas && selected && inPlace(selected) && !selected.variants.length && now - hold.since >= EARLY_IDEAS_MS) {
    askIdeasEarly(video, selected);
  }
  if (hold.done || now - hold.since < HOLD_TIMES[what] || !selected) return;
  hold.done = true;
  if (what === "reset") {
    removeItem(selected, "both fists");
    return;
  }
  if (what === "grab") grabSelected(video, at);
  else if (what === "store") storeSelected(video);
  else if (what === "remove") removeItem(selected, "open left hand");
  else if (what === "erase") eraseSelected(video, "thumbs down");
  else turnDial(video, selected, 1);
}

function endChoosing(why: string) {
  phase = "idle";
  hoverItem = null;
  dwell = 0;
  offTargetSince = null;
  if (hasCandidate) stopFollowing();
  log(`choosing stopped (${why})`);
}

// Points the highlight at a tray object's real object again (after the highlight was used for
// choosing, or lost it). Only accepts something like what was locked, near where it should be.
function refollow(video: HTMLVideoElement, item: Item, hands: Hand[]) {
  const d = shiftSince(item.motionAt);
  const seed = { x: item.seed.x + d.x, y: item.seed.y + d.y };
  if (seed.x < 0 || seed.x > 1 || seed.y < 0 || seed.y > 1) return; // the camera has turned away from it
  const expected = realBox(item);
  const result = highlightAt(video, seed, hands.flatMap(fingerPoints), (found) => similar(found, expected, item.color));
  if (!result.ok) return;
  hasHighlight = true;
  hasCandidate = false;
  following = item;
  lostSince = null;
  setHighlightColor("green");
}

// Is a found outline the same object as `before` (about the same size, place and color)?
function similar(found: { box: Box; color: number[] }, before: Box, color: number[] | null) {
  const sizeRatio = (found.box.w * found.box.h) / Math.max(before.w * before.h, 1e-6);
  const moved = Math.hypot(found.box.x + found.box.w / 2 - (before.x + before.w / 2), found.box.y + found.box.h / 2 - (before.y + before.h / 2));
  const recolored = color ? Math.hypot(...found.color.map((v, i) => v - color[i])) : 0;
  return sizeRatio > 0.5 && sizeRatio < 2 && moved < 0.08 && recolored < MAX_REFRESH_COLOR_CHANGE;
}

// Moves the highlight with its object when the camera moves (this also measures scene motion).
function follow(video: HTMLVideoElement, hands: Hand[], now: number) {
  const result = followHighlight(video);
  if (result) {
    stats.followed++;
    if (result.matched) stats.followMatched++;
    stats.followDiff += Math.min(result.diff, 255);
  }
  const box = highlightBox();
  const offScreen = box !== null && (box.x + box.w < 0 || box.x > 1 || box.y + box.h < 0 || box.y > 1);
  if (result && result.matched && !offScreen) lostSince = null;
  else lostSince ??= now;

  if (lostSince !== null && now - lostSince > LOST_MS) {
    // Usually the hand is covering it (grabbing, waving). Tray objects stay; the selected one is
    // looked for again every REFOLLOW_MS.
    log(hasCandidate ? "lost the highlighted object" : `stopped following ${following ? nameOf(following) : "the object"} (covered or out of view), will look again`);
    stopFollowing();
    return;
  }

  // Every so often re-find the outline where the followed object is now. Only accept something
  // about the same size near the same spot, so it can't jump to a different object.
  // Not while grabbing: the hand is right on top of the object.
  if (following && !hasCandidate && phase !== "grabbing" && lostSince === null && now - lastRefresh > REFRESH_MS) {
    lastRefresh = now;
    const seed = highlightSeed();
    const before = highlightBox();
    if (seed && before) highlightAt(video, seed, hands.flatMap(fingerPoints), (found) => similar(found, before, highlightMeanColor()));
  }
}

// The pointing finger's tip and middle joint: never part of an object.
function fingerPoints(hand: Hand) {
  const joints = FINGER_JOINTS[hand.finger];
  return [hand.landmarks[joints.tip], hand.landmarks[joints.pip]];
}

function choose(video: HTMLVideoElement, hand: Hand, now: number, dt: number) {
  const at = hand.landmarks[MIDDLE_KNUCKLE];
  if (!pointAnchor || Math.hypot(at.x - pointAnchor.x, at.y - pointAnchor.y) > POINT_STILL) {
    pointAnchor = { x: at.x, y: at.y };
    dwell = 0;
  }
  // Points along the pointing line, near to far (finger lengths past the tip).
  const near = REACHES.map((reach) => pointerFrom(hand.landmarks, reach, hand.finger));
  const tip = hand.landmarks[FINGER_JOINTS[hand.finger].tip];
  const far = pointsPast(hand.landmarks, hand.finger, Math.hypot(near[near.length - 1].x - tip.x, near[near.length - 1].y - tip.y) + AIM_STEP, AIM_STEP);
  const along = [...near, ...far];
  ray = { from: tip, to: along[along.length - 1] };

  // A tray object in the way (in the virtual world)? Holding on it selects it. With something new
  // already found, only one right at the fingertip counts: the line carries on past what you're
  // pointing at, and could cross a tray object far behind it.
  const seen = lookAlong(hasCandidate ? near : along);
  if ("item" in seen) {
    if (hasCandidate) stopFollowing();
    cursor = seen.at;
    ray.to = seen.at;
    offTargetSince = null;
    if (seen.item === selected) {
      hoverItem = null;
      dwell = 0;
      return;
    }
    if (hoverItem !== seen.item) {
      hoverItem = seen.item;
      dwell = 0;
    }
    dwell += dt;
    if (dwell >= DWELL_MS) {
      select(seen.item, "held");
      hoverItem = null;
      dwell = 0;
      phase = "idle";
    }
    return;
  }
  if (hoverItem) {
    hoverItem = null;
    dwell = 0;
  }

  // Still on the candidate (anywhere along the line): keep it, and count towards locking it.
  const onObject = hasCandidate ? along.find((p) => isOnHighlight(p)) : undefined;
  if (onObject) {
    cursor = onObject;
    ray.to = onObject;
    offTargetSince = null;
    dwell += dt;
    if (dwell >= DWELL_MS) lockCandidate(video, "held", now);
    return;
  }

  offTargetSince ??= now;
  const offFor = now - offTargetSince;
  if (hasCandidate && offFor < SWITCH_MS) return;
  if (now - lastSegment < SEGMENT_EVERY_MS) return;
  lastSegment = now;

  // Close to the fingertip the model often merges the object with the finger ("hand") or the
  // desk ("background"). Then look further along the pointing line. Never select the finger
  // itself, and never an object that's already in the tray (that would duplicate it).
  const avoid = fingerPoints(hand);
  const notInTray = (found: { box: Box }) =>
    !items.some((item) => onOriginal(item, { x: found.box.x + found.box.w / 2, y: found.box.y + found.box.h / 2 }));
  // Turn about: near the fingertip, then a few points further along, different ones each time. Every
  // point at once would stutter the picture.
  const goFar = !lookedFar && far.length > 0;
  lookedFar = goFar;
  const looks = goFar
    ? Array.from({ length: Math.min(FAR_LOOKS, far.length) }, () => far[(farLook = (farLook + FAR_STRIDE) % far.length)])
    : near;
  let result = highlightAt(video, looks[0], avoid, notInTray);
  let found = looks[0];
  let ms = result.ms;
  for (const point of looks.slice(1)) {
    if (result.ok) break;
    maybeCapture(result.reason as CaptureReason, hand, result, now, 1000);
    result = highlightAt(video, point, avoid, notInTray);
    found = point;
    ms += result.ms;
  }
  stats.totalMs += ms;

  if (result.ok) {
    stats.ok++;
    if (!hasCandidate) log(`highlighting: ${describe(result)}${ms > result.ms ? `, ${ms} ms in total` : ""}`);
    hasHighlight = true;
    hasCandidate = true;
    following = null;
    setHighlightColor("blue");
    cursor = found;
    ray.to = found;
    dwell = 0;
    offTargetSince = null;
    maybeCapture("ok", hand, result, now, 5000);
    return;
  }

  if (result.reason === "background") stats.background++;
  else if (result.reason === "no-object") stats.noObject++;
  else stats.hand++;
  if (result.reason === "background" && now - lastBackgroundLog > 1000) {
    lastBackgroundLog = now;
    log(`ignored background: ${describe(result)}`);
  }
  maybeCapture(result.reason as CaptureReason, hand, result, now, 1000);

  // Keep showing the old candidate through short failures, so it doesn't flicker.
  if (hasCandidate && offFor > DROP_MS) {
    stopFollowing();
    dwell = 0;
  }
}

// e.g. "6% of view, edges 0, ragged 1.8, contrast 95, 42 ms"
function describe(r: HighlightResult) {
  return `${Math.round(r.coverage * 100)}% of view, edges ${r.edges}, ragged ${r.ragged.toFixed(1)}, contrast ${Math.round(r.contrast)}, solid ${Math.round(r.solid * 100)}%, ${r.ms} ms`;
}

function maybeCapture(reason: CaptureReason, hand: Hand, extra: Partial<HighlightResult>, now: number, everyMs: number) {
  if (!capture || now - lastCapture < everyMs) return;
  lastCapture = now;
  capture(reason, hand, extra);
}

function collectStats(hands: Hand[], now: number) {
  if (!statsStart) statsStart = now;
  stats.frames++;
  if (hands.length) stats.handFrames++;
  if (hands.some((h) => h.rawGesture === "Point")) stats.rawPoint++;
  if (hands.some((h) => h.gesture === "Point")) stats.stablePoint++;
  const notPointing = hands.find((h) => h.rawGesture !== "Point");
  if (notPointing) {
    stats.notPointing++;
    notPointing.straightness.forEach((v, i) => (stats.straight[i] += v));
  }

  if (now - statsStart < STATS_EVERY_MS) return;
  if (stats.handFrames > 0 || stats.followed > 0) {
    const pct = (n: number) => `${Math.round((n / stats.frames) * 100)}%`;
    const tries = stats.ok + stats.noObject + stats.background + stats.hand;
    // Average finger straightness when NOT recognized as pointing: if you were pointing, these
    // show which finger broke the rule (one finger > 1.1, the other three < 1.2, see pointingFinger).
    const fingers = stats.notPointing
      ? `, when not pointing i/m/r/p ${stats.straight.map((v) => (v / stats.notPointing).toFixed(2)).join("/")}`
      : "";
    log(
      `stats: hand in view ${pct(stats.handFrames)}, pointing ${pct(stats.rawPoint)} (stable ${pct(stats.stablePoint)})` +
        (tries
          ? `, highlight ok ${stats.ok}/${tries} [nothing ${stats.noObject}, background ${stats.background}, own hand ${stats.hand}], avg ${Math.round(stats.totalMs / tries)} ms`
          : "") +
        fingers +
        (stats.followed
          ? `, following matched ${Math.round((stats.followMatched / stats.followed) * 100)}% (avg diff ${Math.round(stats.followDiff / stats.followed)})`
          : ""),
    );
  }
  stats = newStats();
  statsStart = now;
}

// Tap on the video: select the tray object there, or lock the real object there straight away.
export function tapRealityShift(video: HTMLVideoElement, point: Point) {
  if (!ready || phase === "grabbing") return;
  const seen = lookAlong([point]);
  if ("item" in seen) {
    select(seen.item, "tap");
    return;
  }
  if (!seen.free.length) {
    log("tap: that spot is empty in the virtual view");
    return;
  }
  const result = highlightAt(video, point, [], (found) =>
    !items.some((item) => onOriginal(item, { x: found.box.x + found.box.w / 2, y: found.box.y + found.box.h / 2 })),
  );
  if (result.ok) {
    hasHighlight = true;
    hasCandidate = true;
    lockCandidate(video, "tap", performance.now());
  } else {
    log(`tap: no object there (${result.reason}: ${describe(result)})`);
  }
}

// ---------- Drawing (real view) ----------

export function drawRealityShift(ctx: CanvasRenderingContext2D, mirrored: boolean, now: number) {
  if (!ready) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const flipX = (x: number) => (mirrored ? 1 - x : x);
  const ring = (box: Box) => ({
    cx: flipX(box.x + box.w / 2) * w,
    cy: (box.y + box.h / 2) * h,
    radius: Math.hypot(box.w * w, box.h * h) / 2 + 14,
  });

  // Tray objects that aren't selected: a thin white outline and their number.
  for (const item of items) {
    if (item === selected && following === item) continue;
    const d = shiftSince(item.motionAt);
    ctx.save();
    if (mirrored) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.globalAlpha = item === selected ? 0.9 : 0.6;
    ctx.drawImage(item.outline, (item.mask.offset.x + d.x) * w, (item.mask.offset.y + d.y) * h, w, h);
    ctx.restore();
    const b = realBox(item);
    badge(ctx, String(item.id), flipX(b.x + b.w / 2) * w, b.y * h - 4, item === selected ? "#31a24c" : "rgba(28, 43, 51, 0.75)");
  }

  // The highlight: a candidate being chosen (blue) or the selected object (green).
  const box = highlightBox();
  if (hasHighlight && box) {
    const progress = hasCandidate ? Math.min(dwell / DWELL_MS, 1) : 0;
    ctx.globalAlpha = hasCandidate ? 0.6 + 0.4 * progress : 1;
    drawHighlight(ctx, mirrored);
    ctx.globalAlpha = 1;
    const { cx, cy, radius } = ring(box);

    if (hasCandidate && progress > 0) {
      progressRing(ctx, cx, cy, radius, progress);
      pill(ctx, "Hold to lock…", "#0866ff", cx, cy - radius - 22, w);
    }

    if (!hasCandidate && following && following === selected) {
      // "Pop": a green ring that grows and fades right after locking.
      const t = (now - lockedAt) / POP_MS;
      if (t < 1) {
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 8 * (1 - t) + 2;
        ctx.strokeStyle = "#31a24c";
        ctx.beginPath();
        ctx.arc(cx, cy, radius * (1 + 0.35 * t), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      const state = phase === "grabbing" ? "Moving…" : { locked: "Locked", moved: selected.command ? "Moved + transmuted (virtual)" : "Moved (virtual)", erased: "Erased (virtual)", changed: "Transmuted (virtual)", stored: "In inventory" }[selected.state];
      pill(ctx, `${selected.id} · ${state}`, "#31a24c", cx, Math.max(box.y * h - 26, 24), w);
    }
  }

  // The reality dial: which version is showing, under the selected object, and how far the hand
  // has twisted towards the next step.
  if (selected && phase === "idle" && (selected.variants.length || Math.abs(dialProgress()) > 0.15)) {
    const { cx, cy, radius } = ring(realBox(selected));
    const p = dialProgress();
    if (Math.abs(p) > 0.05) {
      ctx.lineCap = "round";
      ctx.lineWidth = 8;
      ctx.strokeStyle = "#9b51e0";
      ctx.beginPath();
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + p * (Math.PI / 2), p < 0);
      ctx.stroke();
    }
    if (selected.variants.length) {
      const n = selected.variants.length;
      const v = selected.variantAt ? selected.variants[selected.variantAt - 1] : null;
      const text = v ? `${v.idea || "Getting ideas…"}${v.status === "waiting" && v.idea ? " · making…" : ""}` : "Real object";
      pill(ctx, `⟳ ${selected.variantAt}/${n} · ${text}`, "#9b51e0", cx, Math.min(cy + radius + 26, h - 24), w);
    }
  }

  // A held gesture filling up: the ring around the selected object (where it is in the virtual world).
  if (selected && hold && !hold.done && phase === "idle") {
    const progress = Math.min((now - hold.since) / HOLD_TIMES[hold.what], 1);
    if (progress > 0.05) {
      // An object in the inventory isn't anywhere in the room: the ring goes around the hand.
      const { cx, cy, radius } =
        selected.state === "stored" ? { cx: flipX(hold.at.x) * w, cy: hold.at.y * h, radius: h * 0.12 } : ring(virtualBox(selected));
      const look = {
        transmute: { color: "#9b51e0", text: "Hold to transmute…" },
        grab: { color: "#0866ff", text: "Hold to grab…" },
        remove: { color: "#e41e3f", text: "Hold to remove…" },
        store: { color: "#e8710a", text: "Hold to take it…" },
        erase: { color: "#e41e3f", text: "Hold to erase…" },
        reset: { color: "#e41e3f", text: "Hold to put it back…" },
      }[hold.what];
      progressRing(ctx, cx, cy, radius, progress, look.color);
      pill(ctx, look.text, look.color, cx, cy - radius - 22, w);
    }
  }

  // Holding on a tray object to select it: the same ring, around where it is in the virtual world.
  if (hoverItem && dwell > 0) {
    const { cx, cy, radius } = ring(virtualBox(hoverItem));
    progressRing(ctx, cx, cy, radius, Math.min(dwell / DWELL_MS, 1));
    pill(ctx, `Hold to select ${hoverItem.id}…`, "#0866ff", cx, cy - radius - 22, w);
  }

  if (cursor && ray) {
    // Dashed aiming line from the fingertip.
    ctx.setLineDash([10, 10]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.beginPath();
    ctx.moveTo(flipX(ray.from.x) * w, ray.from.y * h);
    ctx.lineTo(flipX(ray.to.x) * w, ray.to.y * h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (cursor) {
    const x = flipX(cursor.x) * w;
    const y = cursor.y * h;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#0866ff";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  drawTray(ctx, items, selected, now);
}

// Lock/select progress: a ring that fills clockwise around the object.
export function progressRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, progress: number, color = "#0866ff") {
  ctx.lineCap = "round";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
}

// A label in a colored pill, centered on x and kept inside the frame.
export function pill(ctx: CanvasRenderingContext2D, label: string, color: string, x: number, y: number, frameW: number, textColor = "#ffffff") {
  ctx.font = "600 18px -apple-system, 'Segoe UI', Roboto, sans-serif";
  const width = ctx.measureText(label).width + 24;
  const left = Math.min(Math.max(x - width / 2, 8), frameW - width - 8);
  const top = Math.max(y - 16, 8);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(left, top, width, 32, 16);
  ctx.fill();
  ctx.fillStyle = textColor;
  ctx.textBaseline = "middle";
  ctx.fillText(label, left + 12, top + 16);
  ctx.textBaseline = "alphabetic";
}

// A small round number badge (tray objects in the real view).
function badge(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, Math.max(y, 16), 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 15px -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, Math.max(y, 16) + 1);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// ---------- Helpers ----------

// A small picture of the object (its exact outline) for the tray card.
function thumbnail(video: HTMLVideoElement, mask: Item["mask"], box: Box): string {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const x = Math.max(0, Math.floor(box.x * w));
  const y = Math.max(0, Math.floor(box.y * h));
  const bw = Math.max(1, Math.min(w - x, Math.ceil(box.w * w)));
  const bh = Math.max(1, Math.min(h - y, Math.ceil(box.h * h)));
  const scale = Math.min(1, 120 / Math.max(bw, bh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bw * scale));
  c.height = Math.max(1, Math.round(bh * scale));
  const cctx = c.getContext("2d")!;
  // Shape first, then the picture only where the shape is.
  cctx.drawImage(maskToCanvas(mask.pixels, mask.w, mask.h), (mask.offset.x * w - x) * scale, (mask.offset.y * h - y) * scale, w * scale, h * scale);
  cctx.globalCompositeOperation = "source-in";
  cctx.drawImage(video, -x * scale, -y * scale, w * scale, h * scale);
  return c.toDataURL("image/png");
}

function frameJpeg(video: HTMLVideoElement): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d")!.drawImage(video, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode frame"))), "image/jpeg", 0.9));
}
