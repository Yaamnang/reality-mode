import {
  highlightAt,
  isOnHighlight,
  highlightBox,
  drawHighlight,
  clearHighlight,
  setHighlightColor,
  followHighlight,
  highlightSeed,
  highlightMeanColor,
  moveHighlightTo,
  highlightFromBorder,
} from "./highlight";
import { sceneMotion, trackScene, resetSceneTracker, islandOf, onIslandsJoined } from "./sceneTracker";
import { createPin, focusPin, trackPins, removePin, pinMatrix, pinPoint, type Pin } from "./pinTracker";
import { warpLayers } from "./warp";
import { pointerFrom, pointsPast, FINGER_JOINTS, type Hand } from "./gestures";
import { drawHandShapes } from "./handLayer";
import { timeLook, timeDecide, timeStage, outlineObject, type TimeMoment } from "./api";
import { dialTurn, dialProgress, resetDial } from "./dial";
import { drawMagicCircle, drawTimeScale, burstSparks, drawSparks, clearSparks } from "./magicCircle";
import { cameraFrame, isPhone } from "./camera";
import { pill, progressRing } from "./realityShift";
import { changedArea } from "./virtualView";

// The Time Knob: point at one object and hold to lock it. Three Muse Spark agents say what it is, a
// judge decides and writes its timeline, and Muse Image draws each moment. Then open your hand:
// a magic circle appears on it, and twisting it moves the object through time. Left = back
// (a phone: exploded view, then raw materials), right = forward (only things that grow or decay,
// an apple rots; made things have no future stage).
// Everything is prepared right after the lock, while the object's border stays lit and a card in the view
// says what it is. A twist shows what's made and the card changes to describe it; turned to a stage
// still being drawn, the knob stays there and the wave plays when it arrives.
// Only what Meta changed around the object is pasted over the live camera, swapped in with a circular
// wave from the object, so the rest of the room (and you) stay live. It's pinned to the room around
// the object (pinTracker), so it stays put when the camera moves and isn't drawn when it's out of view.

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

interface Stage extends TimeMoment {
  at: number; // place on the timeline: -1, -2 = past (nearest first), 1, 2 = future
  patch: HTMLCanvasElement | null; // Meta's picture, only the area it changed around the object
  caption: string; // what Muse Spark sees in that picture
  status: "waiting" | "ready" | "failed";
}

// The frame the stages are drawn from.
interface Shot {
  canvas: HTMLCanvasElement;
  box: Box; // where the object is in it
  pin: Pin; // where that frame is in the live picture
  place: { s: number; tx: number; ty: number }; // that frame -> the pin's saved view, when SAM has re-placed it
}

interface Target {
  box: Box; // where it was when locked (0..1 of frame)
  seed: Point;
  color: number[];
  border: Point[] | null; // the border drawn by hand, null if it was found by pointing
  scanWait: boolean; // drawn: Meta hasn't been shown the frame yet
  motionAt: Point; // scene motion when locked
  name: string; // the judge's decision, "" until then
  about: string; // the judge's sentence about it, for the card
  sure: number;
  type: string;
  fate: string;
  kind: "natural" | "made" | "";
  stages: Stage[];
  at: number; // where the knob is: 0 = now
  request: AbortController;
  shot: Shot | null;
  needFrame: number | null; // since when the judge's timeline has been waiting for a clear frame
  lockedAt: number;
  failed: boolean;
}

const AGENTS = [
  { id: "closeup", name: "Close-up" },
  { id: "context", name: "Context" },
  { id: "material", name: "Material" },
];

// How to choose an object: the same as Reality Shift.
const SEGMENT_EVERY_MS = 200;
const SWITCH_MS = 250;
const DROP_MS = 700;
const DWELL_MS = 1200;
const RELOCK_MS = 2000; // with an object locked: pointing at another throws away what's prepared for this one
const POINT_STILL = 0.06; // a pointing hand that moves this far (of the frame) starts over: it's reaching or touching
const REACHES = [0.4, 0.9, 1.5];
// Past those, the line carries on across the whole view, so something out of reach can be pointed at.
const AIM_STEP = 0.03; // of the frame: how closely the line is checked for what's already been found
const FAR_STRIDE = 7; // each look further along tries these points, stepping this many at a time
const FAR_LOOKS = isPhone ? 1 : 2; // looks per try: each takes tens of ms
const START_POINT_MS = 300; // with an object locked, pointing must last this long to choose another
const LOST_MS = 1500;
const REFOLLOW_MS = 400;
const MAX_COLOR_CHANGE = 40;

const FRAME_WAIT_MS = 2000; // after the judge, wait this long for a hand to leave the object's area
// A hand counts as in the object's area within this much of its size: left and right, above, below.
// Meta may rub out a hand near the object, leaving a hole where the real hand still is.
const HAND_SIDE = 1;
const HAND_UP = 1;
const HAND_DOWN = 0.5;
// How far from the object Meta's picture is used: of the object's size, and at least KEEP_MIN of the frame.
const KEEP_SIDE = 1;
const KEEP_UP = 2;
const KEEP_DOWN = 1;
const KEEP_MIN = 0.12;
// Lost its place for this long: ask SAM 3.1 where the object is now, at most this often and this many
// times per lock (each ~3 s, $0.0025). Never per frame, and only while it's lost.
const REFIND_AFTER_MS = 1200;
const REFIND_EVERY_MS = 5000;
const MAX_REFINDS = 40;
const REFIND_MIN_SIZE = 0.25; // what SAM finds must be about the same size as the object: area, this much of it
const REFIND_MAX_SIZE = 4; // or this much
// Drawing a border with a fist, for things too big to be found by pointing. Distances are shares of the
// frame's shorter side.
const INK_START_MS = 1000; // a fist held still this long starts drawing: a hand just passing by doesn't
const INK_START_RADIUS = 0.05;
const FIST_GAP_MS = 350; // no fist for this long = finished
const STOP_MS = 1000; // a fist that stays put this long has finished too
const STOP_RADIUS = 0.03;
const MIN_LENGTH = 0.5; // a shorter line isn't a border
const MIN_AREA = 0.01; // of the frame
const CLOSE_LENGTH = 1; // once the line is this long, coming back to its start finishes it
const CLOSE_RADIUS = 0.06;
const MIN_STEP = 0.006; // points closer together than this aren't added
const SMOOTH = 2; // the finished border is averaged over this many points each way
const SCAN_WAIT_MS = 1500; // a drawn border: wait this long for the hand to leave before showing Meta the frame
const HAND_MAX_MARGIN = 0.15; // of the frame: however big the object, a hand this far from it isn't over it
const STILL = 0.008; // the camera counts as not moved while the picture has moved less than this much of the frame
const EDGE_FADE = 0.04; // the picture fades out over this much of the frame at the edge of what Meta drew
const REVEAL_MS = 900; // the wave that swaps one moment for another
const PALM_GRACE_MS = 300; // the circle survives gesture flicker this long
const CIRCLE_MAX = 0.22; // the circle's radius, at most this much of the frame's shorter side (a phone held close sees a huge hand)
const STEP_DEG = 40; // same as dial.ts: one step of the knob
const TYPE_MS = 16; // the card's description appears one letter per this long
const NOTE_MS = 2200;
const ORANGE = "#ff8a1f";
const FATE_COLORS: Record<string, string> = { Biodegradable: "#7ee08f", "Toxic waste": "#ff7b7b", "Never throw, burn": "#ffd66b" };
// What moved in front of the picture (an arm) is found by comparing the live camera with the frame
// the stages were drawn from, on a small copy: a pixel counts when a color channel differs this much.
const MOVED_WIDTH = 160;
const MOVED_DIFF = 38;

// Finger chains, from the wrist, for keeping the live hand in front of the picture.
let active = false;
let log: (message: string) => void = () => {};
let setStatus: (text: string) => void = () => {};
let videoEl: HTMLVideoElement | null = null;
let liveHands: Hand[] = [];
let clock = 0;
let lastFrame = 0;
let followedFrame = -1;

let target: Target | null = null;
let hasHighlight = false;
let hasCandidate = false;
let dwell = 0;
let cursor: Point | null = null;
let ray: { from: Point; to: Point } | null = null;
let lastSegment = 0;
let pointSince: number | null = null;
let offSince: number | null = null;
let lostSince: number | null = null;
let lastRefollow = 0;

// What's on screen: `showing` (null = the live camera), with a wave from `previous`.
let showing: HTMLCanvasElement | null = null;
let previous: HTMLCanvasElement | null = null;
let revealAt = -1e9;
let note = "";
let noteAt = -1e9;
let flash = 0;
let cardKey = ""; // what the card says now, and since when, so a new text types itself out
let cardAt = 0;
let twist = 0; // steps turned so far, degrees, clockwise on screen
let palm: { x: number; y: number; r: number; squash: number; axis: number; seen: number; alpha: number } | null = null;
let handLayer: HTMLCanvasElement | null = null;
let frameCopy: HTMLCanvasElement | null = null; // the camera frame everything was tracked on
let ink: { handId: number; points: Point[]; length: number; stillAt: Point; stillSince: number } | null = null;
let fistSince: number | null = null;
let fistAt: Point | null = null; // where the fist was when that started
let pointAnchor: Point | null = null; // where the pointing hand was when its hold started
let farLook = 0; // which point far along the pointing line to look at next
let lookedFar = true; // so the first look is near the fingertip
let fistSeen = 0;
let fistSpent = false; // this fist has finished a border: it has to open before it can draw another
let placeLostAt: number | null = null;
let refinding = false;
let lastRefind = -1e9;
let refinds = 0;
let movedCanvas: HTMLCanvasElement | null = null;
let readCanvas: HTMLCanvasElement | null = null;
let cleanPixels: Uint8ClampedArray | null = null; // small copy of the frame the stages were drawn from

// The camera tracker joined two parts of the room it had kept apart.
onIslandsJoined((from, shift) => {
  if (!target || islandOf(target.motionAt) !== from) return;
  target.motionAt = { x: target.motionAt.x - shift.x, y: target.motionAt.y - shift.y };
});

export function initTimeKnob(logger: (message: string) => void, status: (text: string) => void) {
  log = logger;
  setStatus = status;
}

export function enableTimeKnob(on: boolean) {
  if (on === active) return;
  active = on;
  resetTimeKnob();
}

// Everything back to the live camera, nothing locked.
export function resetTimeKnob() {
  ink = null;
  fistSince = null;
  fistSpent = false;
  placeLostAt = null;
  refinds = 0;
  lastRefind = -1e9;
  target?.request.abort();
  if (target?.shot) removePin(target.shot.pin);
  target = null;
  resetSceneTracker();
  dropHighlight();
  resetDial();
  clearSparks();
  showing = null;
  previous = null;
  revealAt = -1e9;
  cleanPixels = null;
  palm = null;
  twist = 0;
  note = "";
  cursor = null;
  ray = null;
  if (active) setStatus("Point at an object and hold, or draw around it with a closed fist.");
}

function dropHighlight() {
  hasHighlight = false;
  hasCandidate = false;
  dwell = 0;
  lostSince = null;
  clearHighlight();
}

function boxNow(t: Target): Box {
  // Its place in the frame the pictures are drawn from, through the pin, once there is one.
  const shot = t.shot;
  const at = shot && shotPoint(shot, shot.box.x + shot.box.w / 2, shot.box.y + shot.box.h / 2);
  if (at) {
    const w = shot!.box.w * shot!.place.s;
    const h = shot!.box.h * shot!.place.s;
    return { ...shot!.box, x: at.x - w / 2, y: at.y - h / 2, w, h };
  }
  const m = sceneMotion();
  return { ...t.box, x: t.box.x + m.x - t.motionAt.x, y: t.box.y + m.y - t.motionAt.y };
}

// ---------- Every frame ----------

export function updateTimeKnob(video: HTMLVideoElement, hands: Hand[], now: number, mirrored: boolean) {
  if (!active) return;
  const dt = lastFrame ? Math.min(now - lastFrame, 100) : 0;
  lastFrame = now;
  clock = now;
  videoEl = video;
  liveHands = hands;

  if (cameraFrame(video) !== followedFrame) {
    followedFrame = cameraFrame(video);
    // The object being chosen is followed itself; a locked one by the room around it.
    if (hasHighlight && hasCandidate) follow(video, now);
    if (target && video.videoWidth) {
      if (frameCopy?.width !== video.videoWidth || frameCopy.height !== video.videoHeight) {
        frameCopy = document.createElement("canvas");
        frameCopy.width = video.videoWidth;
        frameCopy.height = video.videoHeight;
      }
      frameCopy.getContext("2d")!.drawImage(video, 0, 0);
      trackScene(frameCopy, hands.map((h) => h.landmarks));
      trackPins(frameCopy, sceneMotion());
    }
  }
  if (target) watchPlace(target, now);
  if (target && hasHighlight && !hasCandidate) {
    const b = boxNow(target);
    moveHighlightTo({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  }

  // The frame to draw from: the first one since the lock with no hand over the object.
  if (target && !target.shot && !hands.some((h) => handOver(h, boxNow(target!)))) takeShot(video, target);
  if (target?.needFrame != null && (target.shot || now - target.needFrame > FRAME_WAIT_MS)) {
    target.needFrame = null;
    if (!target.shot) takeShot(video, target);
    drawStages(target);
  }

  const drawing = updateBorder(video, hands, now);
  if (target?.scanWait && (target.shot || now - target.lockedAt > SCAN_WAIT_MS)) {
    target.scanWait = false;
    startScan(target, target.shot?.canvas ?? video);
  }
  const pointing = drawing ? undefined : hands.find((h) => h.gesture === "Point");
  if (drawing) {
    pointSince = null;
    cursor = null;
    ray = null;
  } else if (pointing) {
    pointSince ??= now;
    if (!target || now - pointSince > START_POINT_MS) choose(video, pointing, now, dt);
  } else {
    pointSince = null;
    cursor = null;
    ray = null;
    if (hasCandidate && offSince !== null && now - offSince > DROP_MS) dropHighlight();
    offSince ??= hasCandidate ? now : null;
  }

  // The outline went (another object was being chosen): find it again.
  if (target && !hasHighlight && !showing && inView(target) && now - lastRefollow > REFOLLOW_MS) {
    lastRefollow = now;
    refollow(video, target, hands);
  }

  const turn = dialTurn(hands, mirrored, now);
  if (turn) {
    twist += turn * STEP_DEG;
    stepTimeKnob(turn);
  }
  trackPalm(video, hands, now, dt);
  flash = Math.max(0, flash - dt / 400);
}

// Where a spot of the frame the pictures were drawn from is now.
function shotPoint(shot: Shot, x: number, y: number) {
  return pinPoint(shot.pin, shot.place.s * x + shot.place.tx, shot.place.s * y + shot.place.ty);
}

// The frame the pictures were drawn from -> the live picture. null while lost.
function shotMatrix(shot: Shot): number[] | null {
  const m = pinMatrix(shot.pin);
  if (!m) return null;
  const { s, tx, ty } = shot.place;
  return [m[0] * s, m[1] * s, m[0] * tx + m[1] * ty + m[2], m[3] * s, m[4] * s, m[3] * tx + m[4] * ty + m[5], m[6] * s, m[7] * s, m[6] * tx + m[7] * ty + m[8]];
}

// Notices when the picture has lost its place, and when it's back.
function watchPlace(t: Target, now: number) {
  if (!t.shot || !t.name) return;
  if (inView(t)) {
    if (placeLostAt !== null) log(`time knob: back on the ${t.name}, ${((now - placeLostAt) / 1000).toFixed(1)} s after losing it`);
    placeLostAt = null;
    return;
  }
  if (placeLostAt === null) {
    placeLostAt = now;
    log(`time knob: lost its place on the ${t.name}, looking for it`);
  }
  if (!refinding && refinds < MAX_REFINDS && now - placeLostAt > REFIND_AFTER_MS && now - lastRefind > REFIND_EVERY_MS) refind(t, now);
}

// The room around the object couldn't be recognized. SAM looks for the object itself on one snapshot,
// and a new pin starts on that snapshot, so the picture has somewhere to stay from then on.
async function refind(t: Target, now: number) {
  if (!frameCopy) return;
  refinding = true;
  lastRefind = now;
  refinds++;
  const canvas = document.createElement("canvas");
  canvas.width = frameCopy.width;
  canvas.height = frameCopy.height;
  canvas.getContext("2d")!.drawImage(frameCopy, 0, 0);
  // Started now, so the camera can keep moving while SAM answers.
  const pin = createPin(canvas, sceneMotion(), overHands(liveHands));
  let used = false;
  try {
    const shot = t.shot!;
    const objects = await outlineObject(await frameJpeg(canvas), t.name, t.request.signal);
    const size = (o: { w: number; h: number }) => (o.w * o.h) / Math.max(shot.box.w * shot.box.h, 1e-6);
    const near = objects
      .map((o) => o.box)
      .filter((o) => size(o) > REFIND_MIN_SIZE && size(o) < REFIND_MAX_SIZE)
      .sort((a, b) => Math.abs(Math.log(size(a))) - Math.abs(Math.log(size(b))))[0];
    if (!near || target !== t || placeLostAt === null) {
      if (target === t && placeLostAt !== null) log(`time knob: SAM doesn't see the ${t.name} here`);
      return;
    }
    const s = Math.sqrt(size(near));
    const place = {
      s,
      tx: near.x + near.w / 2 - s * (shot.box.x + shot.box.w / 2),
      ty: near.y + near.h / 2 - s * (shot.box.y + shot.box.h / 2),
    };
    focusPin(pin, aroundMask(canvas, near), overHands(liveHands));
    removePin(shot.pin);
    shot.pin = pin;
    shot.place = place;
    used = true;
    // The outline belongs to the old view: it's found again when it's next needed.
    dropHighlight();
    flash = 1;
    log(`time knob: SAM 3.1 found the ${t.name} again`);
  } catch (err) {
    if (!t.request.signal.aborted) log(`time knob: SAM look failed: ${(err as Error).message}`);
  } finally {
    if (!used) removePin(pin);
    refinding = false;
  }
}

// Solid around the object: where a pin should take its spots from.
function aroundMask(frame: HTMLCanvasElement, box: Box) {
  const around = document.createElement("canvas");
  around.width = frame.width;
  around.height = frame.height;
  around.getContext("2d")!.fillRect((box.x - box.w) * frame.width, (box.y - box.h) * frame.height, box.w * 3 * frame.width, box.h * 3 * frame.height);
  return around;
}

function inView(t: Target) {
  if (t.shot && !pinMatrix(t.shot.pin)) return false;
  const b = boxNow(t);
  return b.x + b.w > 0 && b.x < 1 && b.y + b.h > 0 && b.y < 1;
}

function handOver(hand: Hand, b: Box) {
  const margin = (size: number, share: number) => Math.min(size * share, HAND_MAX_MARGIN);
  const mx = margin(b.w, HAND_SIDE);
  return hand.landmarks.some((p) => p.x > b.x - mx && p.x < b.x + b.w + mx && p.y > b.y - margin(b.h, HAND_UP) && p.y < b.y + b.h + margin(b.h, HAND_DOWN));
}

function takeShot(video: HTMLVideoElement, t: Target) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")!.drawImage(frameCopy ?? video, 0, 0);
  const box = boxNow(t);
  const pin = createPin(canvas, sceneMotion(), overHands(liveHands));
  // Spots around the object: it's the surface next to it that has to stay lined up.
  focusPin(pin, aroundMask(canvas, box), overHands(liveHands));
  t.shot = { canvas, box, pin, place: { s: 1, tx: 0, ty: 0 } };
  cleanPixels = smallPixels(canvas, canvas.width, canvas.height);
}

// Hands won't stay put, so a pin can't use them.
function overHands(hands: Hand[]) {
  const boxes = hands.map((hand) => ({
    x0: Math.min(...hand.landmarks.map((p) => p.x)) - 0.04,
    x1: Math.max(...hand.landmarks.map((p) => p.x)) + 0.04,
    y0: Math.min(...hand.landmarks.map((p) => p.y)) - 0.04,
    y1: Math.max(...hand.landmarks.map((p) => p.y)) + 0.04,
  }));
  return (x: number, y: number) => boxes.some((b) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1);
}

function follow(video: HTMLVideoElement, now: number) {
  const result = followHighlight(video);
  if (result?.matched) lostSince = null;
  else lostSince ??= now;
  if (lostSince !== null && now - lostSince > LOST_MS) dropHighlight();
}

function refollow(video: HTMLVideoElement, t: Target, hands: Hand[]) {
  if (t.border) {
    // Drawn by hand: there's no finding it again, only drawing the same border where it is now.
    const s = t.shot?.place.s ?? 1;
    const c = { x: t.box.x + t.box.w / 2, y: t.box.y + t.box.h / 2 };
    if (highlightFromBorder(video, t.border.map((p) => ({ x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s })))) {
      hasHighlight = true;
      hasCandidate = false;
      setHighlightColor("green");
    }
    return;
  }
  const before = boxNow(t);
  const d = { x: before.x - t.box.x, y: before.y - t.box.y };
  const result = highlightAt(video, { x: t.seed.x + d.x, y: t.seed.y + d.y }, hands.flatMap(fingerPoints), (found) => {
    const size = (found.box.w * found.box.h) / Math.max(before.w * before.h, 1e-6);
    const moved = Math.hypot(found.box.x + found.box.w / 2 - (before.x + before.w / 2), found.box.y + found.box.h / 2 - (before.y + before.h / 2));
    const recolored = Math.hypot(...found.color.map((v, i) => v - t.color[i]));
    return size > 0.5 && size < 2 && moved < 0.08 && recolored < MAX_COLOR_CHANGE;
  });
  if (!result.ok) return;
  hasHighlight = true;
  hasCandidate = false;
  lostSince = null;
  setHighlightColor("green");
}

function fingerPoints(hand: Hand) {
  const joints = FINGER_JOINTS[hand.finger];
  return [hand.landmarks[joints.tip], hand.landmarks[joints.pip]];
}

const holdNeeded = () => (target ? RELOCK_MS : DWELL_MS);

// Pointing: look along the finger for an object; holding on one locks it.
function choose(video: HTMLVideoElement, hand: Hand, now: number, dt: number) {
  const palm = hand.landmarks[9];
  if (!pointAnchor || Math.hypot(palm.x - pointAnchor.x, palm.y - pointAnchor.y) > POINT_STILL) {
    pointAnchor = { x: palm.x, y: palm.y };
    dwell = 0;
  }
  const near = REACHES.map((reach) => pointerFrom(hand.landmarks, reach, hand.finger));
  const tip = hand.landmarks[FINGER_JOINTS[hand.finger].tip];
  const far = pointsPast(hand.landmarks, hand.finger, Math.hypot(near[near.length - 1].x - tip.x, near[near.length - 1].y - tip.y) + AIM_STEP, AIM_STEP);
  const along = [...near, ...far];
  ray = { from: tip, to: along[along.length - 1] };
  cursor = along[0];

  // Already on the locked object: nothing to choose. Only right at the fingertip: the line carries on
  // past what you're pointing at, and could cross the locked object far behind it.
  if (target && hasHighlight && !hasCandidate && near.some((p) => isOnHighlight(p))) {
    dwell = 0;
    return;
  }
  const on = hasCandidate ? along.find((p) => isOnHighlight(p)) : undefined;
  if (on) {
    cursor = on;
    ray.to = on;
    offSince = null;
    dwell += dt;
    if (dwell >= holdNeeded()) lock(video, "held");
    return;
  }
  offSince ??= now;
  if (hasCandidate && now - offSince < SWITCH_MS) return;
  if (now - lastSegment < SEGMENT_EVERY_MS) return;
  lastSegment = now;

  const avoid = fingerPoints(hand);
  // Turn about: near the fingertip, then a few points further along, different ones each time. Every
  // point at once would stutter the picture.
  const goFar = !lookedFar && far.length > 0;
  lookedFar = goFar;
  const looks = goFar
    ? Array.from({ length: Math.min(FAR_LOOKS, far.length) }, () => far[(farLook = (farLook + FAR_STRIDE) % far.length)])
    : near;
  for (const p of looks) {
    const result = highlightAt(video, p, avoid, notTheLockedOne);
    if (result.ok) {
      hasHighlight = true;
      hasCandidate = true;
      setHighlightColor("blue");
      cursor = p;
      ray.to = p;
      dwell = 0;
      offSince = null;
      return;
    }
  }
  if (hasCandidate && now - offSince > DROP_MS) dropHighlight();
}

const notTheLockedOne = (found: { box: Box }) => {
  if (!target) return true;
  const b = boxNow(target);
  const x = found.box.x + found.box.w / 2;
  const y = found.box.y + found.box.h / 2;
  return !(x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h);
};

// A closed fist draws a border around something too big to be found by pointing. Opening the hand,
// holding still, or coming back to the start finishes it; a straight line closes the rest.
// Returns true while it's drawing.
function updateBorder(video: HTMLVideoElement, hands: Hand[], now: number): boolean {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w) return false;
  const unit = Math.min(w, h);
  const apart = (a: Point, b: Point) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h) / unit;
  const held = ink
    ? hands.find((hand) => hand.id === ink!.handId && (hand.gesture === "Closed_Fist" || hand.rawGesture === "Closed_Fist"))
    : hands.find((hand) => hand.gesture === "Closed_Fist");

  if (!held) {
    if (now - fistSeen > FIST_GAP_MS) {
      fistSince = null;
      fistSpent = false;
      if (ink) finishBorder(video);
    }
    return ink !== null;
  }
  fistSeen = now;
  fistSince ??= now;
  if (fistSpent) return false;
  const lm = held.landmarks;
  const pen = { x: (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4, y: (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4 };
  if (!ink) {
    if (!fistAt || apart(pen, fistAt) > INK_START_RADIUS) {
      fistAt = pen;
      fistSince = now;
    }
    if (now - fistSince < INK_START_MS) return false;
    if (hasCandidate) dropHighlight();
    ink = { handId: held.id, points: [pen], length: 0, stillAt: pen, stillSince: now };
    return true;
  }
  const last = ink.points[ink.points.length - 1];
  const step = apart(pen, last);
  if (step >= MIN_STEP) {
    ink.points.push(pen);
    ink.length += step;
  }
  if (apart(pen, ink.stillAt) > STOP_RADIUS) {
    ink.stillAt = pen;
    ink.stillSince = now;
  }
  const stopped = ink.length >= MIN_LENGTH && now - ink.stillSince >= STOP_MS;
  const closed = ink.length >= CLOSE_LENGTH && apart(pen, ink.points[0]) < CLOSE_RADIUS;
  if (stopped || closed) {
    fistSpent = true;
    finishBorder(video);
    return false;
  }
  return true;
}

function finishBorder(video: HTMLVideoElement) {
  const drawn = ink;
  ink = null;
  if (!drawn) return;
  const n = drawn.points.length;
  // Smoothed all the way round, so the straight closing line blends in at its ends.
  const smooth = drawn.points.map((_, i) => {
    let x = 0;
    let y = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) {
      const p = drawn.points[(i + k + n) % n];
      x += p.x;
      y += p.y;
    }
    return { x: x / (2 * SMOOTH + 1), y: y / (2 * SMOOTH + 1) };
  });
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = smooth[i];
    const b = smooth[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  if (drawn.length < MIN_LENGTH || Math.abs(area) / 2 < MIN_AREA || !highlightFromBorder(video, smooth)) {
    if (drawn.length >= MIN_LENGTH / 3) showNote("Draw a bigger border around it");
    return;
  }
  hasHighlight = true;
  hasCandidate = false;
  lock(video, "drawn", smooth);
  showNote("Move your hand away");
}

// Tap on the video: lock what's there straight away (demo backup).
export function tapTimeKnob(video: HTMLVideoElement, point: Point) {
  if (!active) return;
  const result = highlightAt(video, point, [], notTheLockedOne);
  if (!result.ok) {
    log(`tap: no object there (${result.reason})`);
    return;
  }
  hasHighlight = true;
  lock(video, "tap");
}

// ---------- Locking and asking Meta ----------

function lock(video: HTMLVideoElement, how: string, border: Point[] | null = null) {
  const box = highlightBox();
  const seed = highlightSeed();
  if (!box || !seed) return;
  placeLostAt = null;
  refinds = 0;
  lastRefind = -1e9;
  target?.request.abort();
  if (target?.shot) removePin(target.shot.pin);
  showing = null;
  previous = null;
  revealAt = -1e9;
  cleanPixels = null;
  const t: Target = {
    box,
    seed,
    color: highlightMeanColor() ?? [0, 0, 0],
    motionAt: sceneMotion(),
    border,
    scanWait: border !== null,
    name: "",
    about: "",
    sure: 0,
    type: "",
    fate: "",
    kind: "",
    stages: [],
    at: 0,
    request: new AbortController(),
    shot: null,
    needFrame: null,
    lockedAt: clock,
    failed: false,
  };
  target = t;
  hasCandidate = false;
  dwell = 0;
  pointSince = null;
  setHighlightColor("green");
  log(`time knob: object locked (${how}), asking 3 Muse Spark agents what it is…`);
  setStatus("Working out what it is…");
  // A hand that has just drawn a border is still in the way: Meta sees the frame once it has left.
  if (!t.scanWait) startScan(t, video);
}

function startScan(t: Target, source: HTMLVideoElement | HTMLCanvasElement) {
  frameJpeg(source)
    .then((frame) => scan(t, frame))
    .catch((err) => {
      if (t.request.signal.aborted) return;
      t.failed = true;
      log(`time knob: scan failed: ${(err as Error).message}`);
      setStatus("Scan failed. Is the server running? Point at the object to try again.");
    });
}

// The agents look at the same time, behind the scenes. Then the judge decides, and that's what's shown.
async function scan(t: Target, frame: Blob) {
  const { signal } = t.request;
  const opinions = await Promise.all(
    AGENTS.map(async (agent) => {
      const said = await timeLook(frame, t.box, agent.id, signal);
      log(`time knob: ${agent.name} agent says ${said.name || "(no idea)"}${said.name ? `, ${said.kind}, ${said.sure}% sure` : ""}`);
      return said;
    }),
  );
  const timeline = await timeDecide(frame, t.box, opinions, signal);
  if (signal.aborted) return;
  t.name = timeline.name;
  t.about = timeline.about;
  t.sure = timeline.sure;
  t.type = timeline.type;
  t.fate = timeline.fate;
  t.kind = timeline.kind;
  const stage = (m: TimeMoment, at: number): Stage => ({ ...m, at, patch: null, caption: "", status: "waiting" });
  t.stages = [...timeline.past.map((m, i) => stage(m, -(i + 1))), ...timeline.future.map((m, i) => stage(m, i + 1))];
  log(`time knob: judge says ${t.name} (${t.kind}). Past: ${timeline.past.map((m) => m.label).join(", ")}. Future: ${timeline.future.map((m) => m.label).join(", ") || "none"}`);
  t.needFrame = clock;
  updateStatus(t);
}

// Muse Image draws every stage at once; each is usable as soon as it arrives.
async function drawStages(t: Target) {
  const shot = t.shot!;
  const frame = await frameJpeg(shot.canvas);
  await Promise.all(
    t.stages.map(async (s) => {
      try {
        const r = await timeStage(frame, shot.box, t.name, s.look, s.label, t.request.signal);
        const image = new Image();
        image.src = r.image;
        await image.decode();
        s.patch = changedPart(shot, image, r.area);
        s.caption = r.caption ?? "";
        s.status = "ready";
        log(`time knob: "${s.label}" ready, ${Math.round((clock - t.lockedAt) / 1000)} s after the lock: ${s.caption}`);
      } catch (err) {
        if (t.request.signal.aborted) return;
        s.status = "failed";
        log(`time knob: drawing "${s.label}" failed: ${(err as Error).message}`);
      }
      if (target === t) {
        syncPicture(t);
        updateStatus(t);
      }
    }),
  );
  if (target === t && t.stages.some((s) => s.status === "ready")) {
    flash = 1;
    log(`time knob: timeline ready, ${Math.round((clock - t.lockedAt) / 1000)} s after the lock`);
  }
}

// Meta redraws the whole scene: keep only what it really changed around the object.
function changedPart(shot: Shot, image: HTMLImageElement, drawn?: { left: number; top: number; right: number; bottom: number }) {
  const { box } = shot;
  // Near the object only: a big piece of frozen room falls apart as soon as the camera moves. The
  // picture fades out at the limit, so it doesn't end in a straight line.
  const side = Math.max(box.w * KEEP_SIDE, KEEP_MIN);
  const limit = drawn && {
    left: Math.max(drawn.left, box.x - side),
    right: Math.min(drawn.right, box.x + box.w + side),
    top: Math.max(drawn.top, box.y - Math.max(box.h * KEEP_UP, KEEP_MIN)),
    bottom: Math.min(drawn.bottom, box.y + box.h + Math.max(box.h * KEEP_DOWN, KEEP_MIN)),
  };
  const reach = limit && {
    side: Math.max(box.x - limit.left, limit.right - box.x - box.w) / Math.max(box.w, 1e-6),
    up: (box.y - limit.top) / Math.max(box.h, 1e-6),
    down: (limit.bottom - box.y - box.h) / Math.max(box.h, 1e-6),
  };
  const area = changedArea(shot.canvas, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, box, image, reach, true);
  const patch = document.createElement("canvas");
  patch.width = area.width;
  patch.height = area.height;
  const c = patch.getContext("2d")!;
  c.drawImage(image, 0, 0, patch.width, patch.height);
  c.globalCompositeOperation = "destination-in";
  c.drawImage(area, 0, 0);
  if (limit) {
    // Fade towards the limit, unless that's the edge of the frame anyway.
    const W = patch.width;
    const H = patch.height;
    const fade = EDGE_FADE * Math.max(W, H);
    const x0 = limit.left <= 0 ? -3 * fade : limit.left * W + fade;
    const y0 = limit.top <= 0 ? -3 * fade : limit.top * H + fade;
    const x1 = limit.right >= 1 ? W + 3 * fade : limit.right * W - fade;
    const y1 = limit.bottom >= 1 ? H + 3 * fade : limit.bottom * H - fade;
    c.filter = `blur(${fade / 2}px)`;
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
    c.filter = "none";
  }
  return patch;
}

function updateStatus(t: Target) {
  const ready = t.stages.filter((s) => s.status === "ready").length;
  const waiting = t.stages.filter((s) => s.status === "waiting").length;
  const way = t.stages.some((s) => s.at > 0) ? "twist left for its past, right for its future" : "twist left to go back in time";
  if (waiting) setStatus(`${t.name}: preparing its timeline (${ready}/${t.stages.length})…`);
  else if (ready) setStatus(`${t.name}: open your hand and ${way}. Backup: ← → keys.`);
  else setStatus(`${t.name}: Meta couldn't draw its timeline. Point at it again to retry.`);
}

function stageAt(t: Target, at: number) {
  return t.stages.find((s) => s.at === at);
}

// Moves the knob one step. -1 = back in time, 1 = forward.
export function stepTimeKnob(dir: 1 | -1) {
  const t = target;
  if (!t || !t.stages.length) return;
  let at = t.at;
  do at += dir;
  while (at !== 0 && stageAt(t, at)?.status === "failed");
  if (at !== 0 && !stageAt(t, at)) {
    showNote(dir > 0 ? (t.kind === "made" ? "No future: made things don't age on their own" : "That's as far as it goes") : "That's where it began");
    return;
  }
  t.at = at;
  flash = 1;
  if (palm) burstSparks(palm.x, palm.y, palm.r);
  log(`time knob: ${at === 0 ? "now" : stageAt(t, at)!.label}`);
  syncPicture(t);
}

function showNote(text: string) {
  note = text;
  noteAt = clock;
}

// Starts the wave if the picture for where the knob is now isn't the one showing.
function syncPicture(t: Target) {
  const stage = t.at ? stageAt(t, t.at) : null;
  const want = stage?.status === "ready" ? stage.patch : null;
  if (want === showing) return;
  previous = showing;
  showing = want;
  revealAt = clock;
}

function trackPalm(video: HTMLVideoElement, hands: Hand[], now: number, dt: number) {
  const open = hands.find((h) => h.gesture === "Open_Palm");
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (open && w) {
    const lm = open.landmarks;
    const x = ((lm[0].x + lm[9].x) / 2) * w;
    const y = ((lm[0].y + lm[9].y) / 2) * h;
    const r = Math.min(CIRCLE_MAX * Math.min(w, h), Math.max(40, Math.hypot((lm[0].x - lm[9].x) * w, (lm[0].y - lm[9].y) * h) * 1.9));
    let squash = 1;
    let axis = 0;
    const world = open.world;
    if (world && world.length === 21) {
      const a = { x: world[5].x - world[0].x, y: world[5].y - world[0].y, z: world[5].z - world[0].z };
      const b = { x: world[17].x - world[0].x, y: world[17].y - world[0].y, z: world[17].z - world[0].z };
      const n = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
      const length = Math.hypot(n.x, n.y, n.z) || 1;
      squash = Math.max(0.55, Math.abs(n.z) / length);
      axis = Math.atan2(n.y, n.x);
    }
    const k = palm ? 0.45 : 1; // follows the hand, without its jitter
    palm = {
      x: palm ? palm.x + (x - palm.x) * k : x,
      y: palm ? palm.y + (y - palm.y) * k : y,
      r: palm ? palm.r + (r - palm.r) * k : r,
      squash: palm ? palm.squash + (squash - palm.squash) * k : squash,
      axis,
      seen: now,
      alpha: palm?.alpha ?? 0,
    };
  }
  if (palm) {
    const shown = target !== null && now - palm.seen < PALM_GRACE_MS;
    palm.alpha = Math.max(0, Math.min(1, palm.alpha + (shown ? dt / 220 : -dt / 300)));
    if (!shown && palm.alpha === 0) palm = null;
  }
}

// ---------- Drawing ----------

export function drawTimeKnob(ctx: CanvasRenderingContext2D, mirrored: boolean, now: number) {
  if (!active) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const flipX = (x: number) => (mirrored ? 1 - x : x);
  const t = target;

  drawPicture(ctx, mirrored, now, w, h);

  // The object's outline: while choosing it, and while the real object is what's showing.
  const box = highlightBox();
  if (hasHighlight && box && (hasCandidate || (!showing && !(t && t.shot && !pinMatrix(t.shot.pin))))) {
    const progress = hasCandidate ? Math.min(dwell / holdNeeded(), 1) : 0;
    ctx.globalAlpha = hasCandidate ? 0.6 + 0.4 * progress : 1;
    drawHighlight(ctx, mirrored);
    ctx.globalAlpha = 1;
    if (hasCandidate && progress > 0) {
      const cx = flipX(box.x + box.w / 2) * w;
      const cy = (box.y + box.h / 2) * h;
      const radius = Math.hypot(box.w * w, box.h * h) / 2 + 14;
      progressRing(ctx, cx, cy, radius, progress);
      pill(ctx, "Hold to lock…", "#0866ff", cx, cy - radius - 22, w);
    }
  }

  // Looking somewhere else: nothing to say about the room there.
  const here = t && (!t.shot || inView(t));
  if (t && here) drawCard(ctx, t, w, h, now);

  if (ink) drawInk(ctx, ink, flipX, w, h, now);

  if (cursor && ray) {
    ctx.setLineDash([10, 10]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.beginPath();
    ctx.moveTo(flipX(ray.from.x) * w, ray.from.y * h);
    ctx.lineTo(flipX(ray.to.x) * w, ray.to.y * h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#0866ff";
    ctx.beginPath();
    ctx.arc(flipX(cursor.x) * w, cursor.y * h, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // The magic circle on the open hand.
  let labelY = h - 90;
  if (t && palm && palm.alpha > 0) {
    const x = mirrored ? w - palm.x : palm.x;
    const axis = mirrored ? Math.PI - palm.axis : palm.axis;
    drawMagicCircle(ctx, x, palm.y, palm.r, palm.squash, axis, twist + dialProgress() * STEP_DEG, palm.alpha, flash, now);
    if (t.stages.length) drawTimeScale(ctx, x, palm.y, palm.r, t.stages, t.at, palm.alpha);
    labelY = Math.min(palm.y + palm.r * 1.25, h - 60);
  } else {
    drawSparks(ctx);
  }

  if (t?.name && !here) pill(ctx, `Looking for the ${t.name}…`, "#1c2b33", w / 2, h - 60, w);

  // Which moment it is.
  if (t && here) {
    const stage = t.at ? stageAt(t, t.at) : null;
    const px = palm && palm.alpha > 0 ? (mirrored ? w - palm.x : palm.x) : w / 2;
    if (now - noteAt < NOTE_MS) {
      pill(ctx, note, "#1c2b33", px, labelY, w);
    } else if (stage) {
      if (stage.status === "ready") pill(ctx, `${stage.at < 0 ? "◀" : "▶"} ${stage.label}`, ORANGE, px, labelY, w);
    } else if (t.stages.some((s) => s.status === "waiting") || !t.stages.some((s) => s.status === "ready")) {
      // Still preparing, or nothing to show: say nothing in the view.
    } else if (palm && palm.alpha > 0) {
      pill(ctx, `Now · ${t.name}`, ORANGE, px, labelY, w);
    } else {
      pill(ctx, "Open your hand and twist", ORANGE, px, labelY, w);
    }
  }
}

// The border being drawn, and the straight line that would close it.
function drawInk(ctx: CanvasRenderingContext2D, drawn: NonNullable<typeof ink>, flipX: (x: number) => number, w: number, h: number, now: number) {
  const place = (p: Point) => ({ x: flipX(p.x) * w, y: p.y * h });
  const first = place(drawn.points[0]);
  const pen = place(drawn.points[drawn.points.length - 1]);
  const thick = Math.max(4, Math.min(w, h) * 0.008);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = thick * 0.6;
  ctx.setLineDash([thick * 2, thick * 2]);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.beginPath();
  ctx.moveTo(pen.x, pen.y);
  ctx.lineTo(first.x, first.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = thick;
  ctx.strokeStyle = "#0866ff";
  ctx.beginPath();
  drawn.points.forEach((p, i) => {
    const q = place(p);
    if (i) ctx.lineTo(q.x, q.y);
    else ctx.moveTo(q.x, q.y);
  });
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(pen.x, pen.y, thick * 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Holding still finishes it: a ring fills up around the fist.
  if (drawn.length >= MIN_LENGTH) progressRing(ctx, pen.x, pen.y, thick * 5, Math.min((now - drawn.stillSince) / STOP_MS, 1));
  else pill(ctx, "Draw around it · open your hand to finish", "#0866ff", w / 2, h - 60, w);
}

// The moment showing: what changed around the object, swapped in by a wave from it, live hands in front.
function drawPicture(ctx: CanvasRenderingContext2D, mirrored: boolean, now: number, w: number, h: number) {
  const t = target;
  const progress = (now - revealAt) / REVEAL_MS;
  if (!t || !t.shot || (!showing && (!previous || progress >= 1))) return;
  // Lost or out of view: the room is just the room.
  const matrix = shotMatrix(t.shot);
  if (!matrix || !inView(t)) return;
  const pin = t.shot.pin;
  const stretched = (source: HTMLCanvasElement) => warpLayers(w, h, [{ source, matrix, alpha: 1, gain: pin.gain }]);
  const b = boxNow(t);
  const cx = (b.x + b.w / 2) * w;
  const cy = (b.y + b.h / 2) * h;

  ctx.save();
  if (mirrored) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  // The frame everything was tracked on, under the picture, so the room doesn't slide behind it.
  if (frameCopy) ctx.drawImage(frameCopy, 0, 0, w, h);
  if (progress >= 1) {
    const layer = stretched(showing!);
    if (layer) ctx.drawImage(layer, 0, 0, w, h);
  } else {
    const eased = 1 - (1 - Math.max(progress, 0)) ** 3;
    const radius = eased * Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.05;
    if (previous) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip("evenodd");
      const layer = stretched(previous);
      if (layer) ctx.drawImage(layer, 0, 0, w, h);
      ctx.restore();
    }
    if (showing) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      const layer = stretched(showing);
      if (layer) ctx.drawImage(layer, 0, 0, w, h);
      ctx.restore();
    }
  }
  drawLiveHands(ctx, w, h);
  // The edge of the wave.
  if (progress < 1) {
    const eased = 1 - (1 - Math.max(progress, 0)) ** 3;
    const radius = eased * Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.05;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, (1 - progress) * 1.5);
    ctx.shadowColor = "#ff6a00";
    ctx.shadowBlur = 30;
    ctx.strokeStyle = "#ffc46b";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// The real hands, cut out of the live video, so they stay in front of the moment showing.
function drawLiveHands(ctx: CanvasRenderingContext2D, w: number, h: number) {
  if (!videoEl) return;
  handLayer ??= document.createElement("canvas");
  if (handLayer.width !== w || handLayer.height !== h) {
    handLayer.width = w;
    handLayer.height = h;
  }
  const c = handLayer.getContext("2d")!;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, w, h);
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = "#fff";
  c.fillStyle = "#fff";
  drawHandShapes(c, liveHands, w, h);
  // Everything else that moved in front since the frame was taken: mostly the arm. Only while the
  // camera is where it was: once it moves, the whole room differs from that frame.
  const moved = cameraStill() ? movedMask(videoEl) : null;
  if (moved) c.drawImage(moved, 0, 0, w, h);
  c.globalCompositeOperation = "source-in";
  c.drawImage(frameCopy ?? videoEl, 0, 0, w, h);
  ctx.drawImage(handLayer, 0, 0);
}

function cameraStill() {
  const shot = target?.shot;
  if (!shot) return false;
  return [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].every(([x, y]) => {
    const p = shotPoint(shot, x, y);
    return p && Math.hypot(p.x - x, p.y - y) < STILL;
  });
}

// What the judge says the object is, or what's on screen at this moment of its life, top left of the view.
function drawCard(ctx: CanvasRenderingContext2D, t: Target, w: number, h: number, now: number) {
  const stage = t.at ? stageAt(t, t.at) : null;
  const dots = ".".repeat(1 + (Math.floor(now / 350) % 3));
  const tag = stage ? (stage.at < 0 ? "◀ Past" : "▶ Future") : "Now";
  const named = t.name && `${t.name[0].toUpperCase()}${t.name.slice(1)}${t.sure ? ` ${t.sure}%` : ""}`;
  const title = stage ? stage.label : named || (t.failed ? "Couldn't tell" : `Looking${dots}`);
  const text = !stage ? t.about : stage.status === "ready" ? stage.caption || stage.look : "Still drawing this moment…";
  const facts = stage ? "" : [t.type, t.fate].filter(Boolean).join(" · ");
  const key = `${title}|${text}`;
  if (key !== cardKey) {
    cardKey = key;
    cardAt = now;
  }
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.024));
  const pad = size * 0.8;
  const x = size * 0.8;
  const y = size * 0.8;
  const width = Math.min(w * 0.46, size * 24);
  const inner = width - pad * 2;
  const font = (weight: number, scale: number) => `${weight} ${Math.round(size * scale)}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.save();
  ctx.textBaseline = "top";
  ctx.font = font(400, 1);
  const lines = wrapText(ctx, text, inner);
  const factsH = facts ? size * 1.5 : 0;
  const height = pad * 2 + size * 1.2 + size * 1.7 + factsH + lines.length * size * 1.35;
  ctx.fillStyle = "rgba(13, 17, 23, 0.8)";
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, size * 0.7);
  ctx.fill();
  ctx.font = font(600, 0.8);
  ctx.fillStyle = "#ffc46b";
  ctx.fillText(tag, x + pad, y + pad, inner);
  ctx.font = font(700, 1.25);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(title, x + pad, y + pad + size * 1.2, inner);
  if (facts) {
    ctx.font = font(600, 1);
    ctx.fillStyle = FATE_COLORS[t.fate] ?? "#ffc46b";
    ctx.fillText(facts, x + pad, y + pad + size * 2.9, inner);
  }
  // The description types itself out; it's wrapped first so lines don't jump.
  ctx.font = font(400, 1);
  ctx.fillStyle = "#d7dde3";
  let left = Math.floor((now - cardAt) / TYPE_MS);
  lines.forEach((line, i) => {
    if (left > 0) ctx.fillText(line.slice(0, left), x + pad, y + pad + size * 2.9 + factsH + i * size * 1.35);
    left -= line.length + 1;
  });
  // A thin bar while the timeline is still being drawn.
  const ready = t.stages.filter((s) => s.status !== "waiting").length;
  if (ready < t.stages.length) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.fillRect(x + pad, y + height - pad * 0.6, inner, 3);
    ctx.fillStyle = ORANGE;
    ctx.fillRect(x + pad, y + height - pad * 0.6, (inner * (ready + 0.5)) / t.stages.length, 3);
  }
  ctx.restore();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const longer = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(longer).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = longer;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function smallPixels(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  readCanvas ??= document.createElement("canvas");
  const w = MOVED_WIDTH;
  const h = Math.max(1, Math.round((w * height) / Math.max(width, 1)));
  readCanvas.width = w;
  readCanvas.height = h;
  const c = readCanvas.getContext("2d", { willReadFrequently: !isPhone })!;
  c.drawImage(source, 0, 0, w, h);
  return c.getImageData(0, 0, w, h).data;
}

// A small mask of what differs from the frame the stages were drawn from. The camera re-adjusts its
// exposure on its own, so the overall brightness change is taken out; lone pixels (noise) are dropped.
function movedMask(video: HTMLVideoElement): HTMLCanvasElement | null {
  const before = cleanPixels;
  if (!before) return null;
  const now = smallPixels(video, video.videoWidth, video.videoHeight);
  if (now.length !== before.length) return null;
  const w = MOVED_WIDTH;
  const h = now.length / 4 / w;
  let drift = 0;
  for (let i = 0; i < now.length; i += 4) drift += now[i + 1] - before[i + 1];
  drift /= now.length / 4;
  const changed = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < now.length; i += 4, p++) {
    const d = Math.max(Math.abs(now[i] - before[i] - drift), Math.abs(now[i + 1] - before[i + 1] - drift), Math.abs(now[i + 2] - before[i + 2] - drift));
    if (d > MOVED_DIFF) changed[p] = 1;
  }
  movedCanvas ??= document.createElement("canvas");
  movedCanvas.width = w;
  movedCanvas.height = h;
  const c = movedCanvas.getContext("2d")!;
  const image = c.createImageData(w, h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let near = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near += changed[(y + dy) * w + x + dx];
      if (near >= 5) image.data[(y * w + x) * 4 + 3] = 255;
    }
  }
  c.putImageData(image, 0, 0);
  return movedCanvas;
}

function frameJpeg(source: HTMLVideoElement | HTMLCanvasElement): Promise<Blob> {
  let c = source as HTMLCanvasElement;
  if (source instanceof HTMLVideoElement) {
    c = document.createElement("canvas");
    c.width = source.videoWidth;
    c.height = source.videoHeight;
    c.getContext("2d")!.drawImage(source, 0, 0);
  }
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode frame"))), "image/jpeg", 0.9));
}
