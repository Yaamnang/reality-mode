import { FilesetResolver, GestureRecognizer, type Landmark, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { cameraFrame } from "./camera";

// Built-in MediaPipe gestures, plus "Point" which we detect ourselves from the finger shape.
// MediaPipe's "Pointing_Up" is reported as "Point".
export type GestureName =
  | "None"
  | "Closed_Fist"
  | "Open_Palm"
  | "Point"
  | "Thumb_Down"
  | "Thumb_Up"
  | "Victory"
  | "ILoveYou"
  | "Three"; // index, middle and ring up, pinky folded: swipes the object tray

export interface Hand {
  id: number; // stays the same while the hand is in view
  side: "Left" | "Right";
  gesture: GestureName; // stable gesture (won the recent-frames vote)
  rawGesture: GestureName; // this frame only, before the vote
  mpGesture: string; // what MediaPipe itself said this frame, for debugging
  mpScore: number;
  landmarks: NormalizedLandmark[]; // 21 smoothed points, x/y in 0..1 of the raw video frame
  world?: Landmark[]; // the same 21 points in 3D, meters, around the hand's center (not smoothed)
  pointer: { x: number; y: number }; // a spot just past the pointing fingertip, 0..1
  finger: PointFinger; // which finger is pointing (index unless MediaPipe mixed the fingers up)
  straightness: number[]; // index, middle, ring, pinky: ~1.3+ straight, below 1 curled (for debugging)
}

// Fired when a hand's gesture changes and the new one wins the recent-frames vote.
export type GestureListener = (hand: Hand, previous: GestureName) => void;
// Fired when a hand comes into view or leaves it.
export type TrackListener = (side: Hand["side"], event: "appeared" | "left view") => void;

// Landmark indices, see https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
export const WRIST = 0;
export const INDEX_PIP = 6;
export const INDEX_TIP = 8;
const THUMB_MCP = 2;
const THUMB_TIP = 4;
const MIDDLE_MCP = 9;

// The fingers that can count as "the pointing finger". Seen from above/behind, MediaPipe sometimes
// mixes up the hand and labels the pointing index finger as the pinky, so a lone pinky counts too.
export type PointFinger = "index" | "pinky";
export const FINGER_JOINTS: Record<PointFinger, { mcp: number; pip: number; tip: number }> = {
  index: { mcp: 5, pip: 6, tip: 8 },
  pinky: { mcp: 17, pip: 18, tip: 20 },
};
const FINGERS = [
  { pip: 6, tip: 8 }, // index
  { pip: 10, tip: 12 }, // middle
  { pip: 14, tip: 16 }, // ring
  { pip: 18, tip: 20 }, // pinky
];

const MIN_SCORE = 0.5;
// Thumbs up/down (from the shape, so it works from behind the hand): all four fingers folded
// (straightness below FIST_FOLDED), the thumb tip at least THUMB_OUT palm lengths away from the
// folded fingers, and pointing up or down by at least THUMB_VERTICAL (0.6 = within ~50° of vertical).
// Strict, because seen from behind, a finger pointing down at the desk can be mistaken for a thumb
// (a real frame: index 1.02, "thumb" out 0.54, down 0.78).
const FIST_FOLDED = 1.0;
const THUMB_OUT = 0.45;
const THUMB_VERTICAL = 0.6;
// A gesture becomes active when it wins VOTES of the last WINDOW frames.
const WINDOW = 6;
const VOTES = 4;
// Two hands: the right hand chooses (point, tray, dial), the left hand changes (grab, erase,
// remove). Hands are followed by position, so two hands don't swap.
const NUM_HANDS = 2;
// Lower = finds hands in harder conditions (dim light, odd angles), but more false alarms. Default 0.5.
const DETECTION_CONFIDENCE = 0.4;

// Pointer position: past the fingertip by a share of the finger's on-screen length (knuckle to
// tip), but at least MIN_REACH of the frame, so it doesn't land on the finger when pointing at the camera.
const POINTER_REACH = 0.4;
const MIN_REACH = 0.04;

// A hand in this frame is the same hand as last frame if its wrist moved less than this (0..1 of frame).
const MATCH_DISTANCE = 0.2;
// Keep a hand's state for this long after it disappears, so one missed frame doesn't reset it.
const LOST_GRACE_MS = 300;

// Smoothing (One Euro filter). Lower MIN_CUTOFF = steadier when still. Higher BETA = less lag when moving fast.
const MIN_CUTOFF = 1.0;
const BETA = 30;


let recognizer: GestureRecognizer | null = null;
let lastFrame = -1;
let latest: Hand[] = [];
let framesProcessed = 0;
let detectMs = 0;
const gestureListeners: GestureListener[] = [];
const trackListeners: TrackListener[] = [];

// A hand we're following across frames. Matched by position, because MediaPipe's
// Left/Right label often flips back and forth for the same hand.
interface Track {
  id: number;
  wrist: { x: number; y: number };
  lastSeen: number;
  sides: Hand["side"][]; // recent labels, the most common one wins
  side: Hand["side"];
  stable: GestureName;
  history: GestureName[];
  pointing: PointFinger | null;
  filters: OneEuro[]; // one per landmark coordinate (21 x, 21 y)
}

let tracks: Track[] = [];
let nextId = 1;

export async function initGestures(): Promise<"GPU" | "CPU"> {
  // The wasm runtime and model are served from web/public, so this works offline.
  const vision = await FilesetResolver.forVisionTasks("/mediapipe");
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/models/gesture_recognizer.task", delegate },
    runningMode: "VIDEO" as const,
    numHands: NUM_HANDS,
    minHandDetectionConfidence: DETECTION_CONFIDENCE,
    minHandPresenceConfidence: DETECTION_CONFIDENCE,
    minTrackingConfidence: DETECTION_CONFIDENCE,
  });

  try {
    recognizer = await GestureRecognizer.createFromOptions(vision, options("GPU"));
    return "GPU";
  } catch {
    recognizer = await GestureRecognizer.createFromOptions(vision, options("CPU"));
    return "CPU";
  }
}

export function onGesture(listener: GestureListener) {
  gestureListeners.push(listener);
}

export function onTrack(listener: TrackListener) {
  trackListeners.push(listener);
}

// How many camera frames hand tracking has processed so far (for measuring its speed).
export function processedFrames() {
  return framesProcessed;
}

// How long the model took on the latest camera frame, in ms.
export function lastDetectMs() {
  return detectMs;
}

// Call once per animation frame. Skips work when the video hasn't produced a new frame.
// `facesUser`: true for a front camera/webcam, false for a phone's back camera.
export function detectHands(video: HTMLVideoElement, now: number, facesUser: boolean): Hand[] {
  if (!recognizer || video.readyState < 2 || cameraFrame(video) === lastFrame) return latest;
  lastFrame = cameraFrame(video);
  framesProcessed++;

  const detectStart = performance.now();
  const result = recognizer.recognizeForVideo(video, now);
  detectMs = performance.now() - detectStart;
  const matched = matchTracks(result.landmarks.map((lm) => lm[WRIST]), now);

  latest = result.landmarks.map((raw, i) => {
    const track = matched[i];
    track.wrist = { x: raw[WRIST].x, y: raw[WRIST].y };
    track.lastSeen = now;

    // MediaPipe's label is used as it is, for both cameras. Swapping it for a front camera (as its
    // docs suggest for selfies) is only right when the palm faces the camera; we see the back of
    // the hand, and on 300 real webcam frames the swap made the right hand "Left".
    const side: Hand["side"] = result.handedness[i]?.[0]?.categoryName === "Left" ? "Left" : "Right";
    track.sides.push(side);
    if (track.sides.length > 15) track.sides.shift();
    const isNew = track.sides.length === 1;
    track.side = mostCommon(track.sides).name;
    if (isNew) trackListeners.forEach((fn) => fn(track.side, "appeared"));

    const landmarks = raw.map((p, j) => ({
      ...p,
      x: track.filters[j * 2].filter(p.x, now),
      y: track.filters[j * 2 + 1].filter(p.y, now),
    }));
    // Real-world 3D points in meters. Distances between them don't depend on camera angle.
    const world = result.worldLandmarks[i] ?? raw;

    const top = result.gestures[i]?.[0];
    const mpGesture = top?.categoryName ?? "None";
    const mpScore = top?.score ?? 0;

    // Pointing is decided by finger shape first. MediaPipe often calls a pointing hand
    // "Thumb_Up", "Closed_Fist" or "None", especially sideways or with the thumb out.
    const straight = FINGERS.map((f) => straightness(world, f));
    track.pointing = pointingFinger(world, track.pointing) ?? (mpGesture === "Pointing_Up" && mpScore >= MIN_SCORE ? "index" : null);
    // Our own 3D shape check wins for every gesture: a POV camera sees the back of the hand, and
    // MediaPipe's gesture model was trained mostly on palms (it calls back-of-hand pointing
    // "Thumb_Up"). MediaPipe is only asked when the shape is unclear.
    const shape = shapeGesture(world);
    let gesture: GestureName;
    if (track.pointing) gesture = "Point";
    else if (shape !== "None") gesture = shape;
    // Never a thumb gesture from MediaPipe alone: it calls back-of-hand pointing "Thumb_Up".
    else if (mpScore >= MIN_SCORE && !["Pointing_Up", "None", "Thumb_Up", "Thumb_Down"].includes(mpGesture))
      gesture = mpGesture as GestureName;
    else gesture = "None";

    track.history.push(gesture);
    if (track.history.length > WINDOW) track.history.shift();

    const hand: Hand = {
      id: track.id,
      side: track.side,
      gesture: track.stable,
      rawGesture: gesture,
      mpGesture,
      mpScore,
      landmarks,
      world,
      pointer: pointerFrom(landmarks, POINTER_REACH, track.pointing ?? "index"),
      finger: track.pointing ?? "index",
      straightness: straight,
    };

    const winner = mostCommon(track.history);
    if (winner.count >= VOTES && winner.name !== track.stable) {
      const previous = track.stable;
      track.stable = winner.name;
      hand.gesture = track.stable;
      gestureListeners.forEach((fn) => fn(hand, previous));
    }

    return hand;
  });

  // Two hands in view can't both be the same hand. If they got the same label, go by where they
  // are: a POV camera sees your left hand on the left of the picture; a camera facing you sees
  // it on the right (raw, not mirrored, picture).
  if (latest.length === 2 && latest[0].side === latest[1].side) {
    const [a, b] = latest;
    const aOnLeft = a.landmarks[WRIST].x < b.landmarks[WRIST].x;
    const aIsLeft = facesUser ? !aOnLeft : aOnLeft;
    a.side = aIsLeft ? "Left" : "Right";
    b.side = aIsLeft ? "Right" : "Left";
  }

  // Drop hands that have been gone for a while.
  tracks = tracks.filter((t) => {
    const keep = now - t.lastSeen <= LOST_GRACE_MS;
    if (!keep) trackListeners.forEach((fn) => fn(t.side, "left view"));
    return keep;
  });

  return latest;
}

// Pairs each detected wrist with the hand we were already following, closest pairs first,
// so two nearby hands don't swap. Wrists with no close match become new hands.
function matchTracks(wrists: { x: number; y: number }[], now: number): Track[] {
  const pairs: { track: Track; i: number; d: number }[] = [];
  for (const track of tracks) {
    wrists.forEach((w, i) => {
      const d = dist(track.wrist, w);
      if (d < MATCH_DISTANCE) pairs.push({ track, i, d });
    });
  }
  pairs.sort((a, b) => a.d - b.d);

  const result: Track[] = [];
  const used = new Set<Track>();
  for (const { track, i } of pairs) {
    if (result[i] || used.has(track)) continue;
    result[i] = track;
    used.add(track);
  }
  return wrists.map((w, i) => result[i] ?? newTrack(w, now));
}

function newTrack(wrist: { x: number; y: number }, now: number): Track {
  const track: Track = {
    id: nextId++,
    wrist: { x: wrist.x, y: wrist.y },
    lastSeen: now,
    sides: [],
    side: "Right",
    stable: "None",
    history: [],
    pointing: null,
    filters: Array.from({ length: 42 }, () => new OneEuro()),
  };
  tracks.push(track);
  return track;
}

// How straight a finger is: fingertip distance from the wrist divided by its middle joint's
// distance. About 1.3+ when straight, below 1 when curled into the palm.
function straightness(world: Landmark[], finger: { pip: number; tip: number }) {
  const wrist = world[WRIST];
  return dist(wrist, world[finger.tip]) / Math.max(dist(wrist, world[finger.pip]), 1e-6);
}

// Exactly one finger out (the index, or the "pinky" when MediaPipe mixed the fingers up), the
// others folded (loosely is fine), and that finger clearly straighter than the rest. The thumb is
// ignored, since people point with it tucked in or sticking out. `was` = the finger that was
// pointing last frame: it gets looser limits, so pointing doesn't flicker at the boundary.
export function pointingFinger(world: Landmark[], was: PointFinger | null): PointFinger | null {
  const s = FINGERS.map((f) => straightness(world, f)); // index, middle, ring, pinky
  const check = (finger: PointFinger, keep: boolean) => {
    const i = finger === "index" ? 0 : 3;
    const others = s.filter((_, j) => j !== i);
    return keep
      ? s[i] > 1.0 && others.every((v) => v < 1.3) && s[i] - Math.max(...others) > 0.1
      : s[i] > 1.1 && others.every((v) => v < 1.2) && s[i] - Math.max(...others) > 0.2;
  };
  if (was && check(was, true)) return was;
  if (check("index", false)) return "index";
  if (check("pinky", false)) return "pinky";
  return null;
}

// Kept for tools/replay: is any finger pointing?
export function isPointing(world: Landmark[], wasPointing: boolean): boolean {
  return pointingFinger(world, wasPointing ? "index" : null) !== null;
}

// A spot past the pointing fingertip along the finger (knuckle to tip), in 0..1 coordinates of the
// raw frame. The whole finger gives a steadier direction than its last joint, which often bends.
// Points further along the pointing line, from `past` (0..1 of the frame) beyond the fingertip to the
// edge of the view, every `step`. Near to far. Unlike pointerFrom, it stops at the edge.
export function pointsPast(landmarks: NormalizedLandmark[], finger: PointFinger, past: number, step: number) {
  const tip = landmarks[FINGER_JOINTS[finger].tip];
  const base = landmarks[FINGER_JOINTS[finger].mcp];
  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  const len = Math.hypot(dx, dy);
  const points: { x: number; y: number }[] = [];
  if (len < 0.01) return points; // pointing at the camera: no line to follow
  for (let d = past; ; d += step) {
    const x = tip.x + (dx / len) * d;
    const y = tip.y + (dy / len) * d;
    if (x < 0 || x > 1 || y < 0 || y > 1) return points;
    points.push({ x, y });
  }
}

export function pointerFrom(
  landmarks: NormalizedLandmark[],
  reach = POINTER_REACH,
  finger: PointFinger = "index",
): { x: number; y: number } {
  const tip = landmarks[FINGER_JOINTS[finger].tip];
  const base = landmarks[FINGER_JOINTS[finger].mcp];
  let dx = tip.x - base.x;
  let dy = tip.y - base.y;
  let len = Math.hypot(dx, dy);
  // Finger pointing straight at the camera looks like a dot. Use the wrist-to-tip direction then.
  if (len < 0.01) {
    dx = tip.x - landmarks[WRIST].x;
    dy = tip.y - landmarks[WRIST].y;
    len = Math.max(Math.hypot(dx, dy), 1e-6);
  }
  const distance = Math.max(len * reach, MIN_REACH);
  return {
    x: clamp01(tip.x + (dx / len) * distance),
    y: clamp01(tip.y + (dy / len) * distance),
  };
}

// The gesture from the finger shape alone. Uses 3D distances, so it works at any angle and from
// either side of the hand (palm or back toward the camera).
// The thumb isn't checked for an open palm: with the palm facing up it often lies close to the hand.
export function shapeGesture(world: Landmark[]): GestureName {
  const s = FINGERS.map((f) => straightness(world, f));

  const [index, middle, ring, pinky] = s;
  if (s.every((v) => v > 1.1)) return "Open_Palm";
  if (s.every((v) => v < FIST_FOLDED)) {
    const thumb = thumbOut(world);
    if (thumb.out > THUMB_OUT && thumb.down < -THUMB_VERTICAL) return "Thumb_Up";
    if (thumb.out > THUMB_OUT && thumb.down > THUMB_VERTICAL) return "Thumb_Down";
  }
  if (s.every((v) => v < 1.0)) return "Closed_Fist";
  // Pinky clearly folded, so a slightly relaxed open palm doesn't count as three fingers.
  if (index > 1.1 && middle > 1.1 && ring > 1.1 && pinky < 1.0) return "Three";
  if (index > 1.1 && middle > 1.1 && ring < 1.05 && pinky < 1.05) return "Victory";
  return "None";
}

// How far the thumb sticks out of a fist, and which way it points. `out` = thumb tip distance from
// the nearest of the index knuckle, the folded index finger and the folded middle finger, in palm
// lengths (wrist to middle knuckle): a thumb wrapped over or along a fist touches them. `down` =
// how much the thumb (its knuckle to its tip) points down the picture, -1 (straight up) .. 1.
// World landmarks keep the picture's directions (y down), so this needs the camera held upright.
export function thumbOut(world: Landmark[]) {
  const palm = Math.max(dist(world[WRIST], world[MIDDLE_MCP]), 1e-6);
  const tip = world[THUMB_TIP];
  const out = Math.min(...[5, 6, 10].map((j) => dist(tip, world[j]))) / palm;
  const len = Math.max(dist(world[THUMB_MCP], tip), 1e-6);
  return { out, down: (tip.y - world[THUMB_MCP].y) / len };
}

function mostCommon<T>(items: T[]) {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best = { name: items[0], count: 0 };
  for (const [name, count] of counts) if (count > best.count) best = { name, count };
  return best;
}

function dist(a: { x: number; y: number; z?: number }, b: { x: number; y: number; z?: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

// One Euro filter: smooths heavily when the hand is still, lightly when it moves fast.
// https://gery.casiez.net/1euro/
class OneEuro {
  private value: number | null = null;
  private speed = 0;
  private lastTime = 0;

  filter(x: number, timeMs: number): number {
    if (this.value === null) {
      this.value = x;
      this.lastTime = timeMs;
      return x;
    }
    const dt = Math.max((timeMs - this.lastTime) / 1000, 0.001);
    this.lastTime = timeMs;

    this.speed += smoothing(1.0, dt) * ((x - this.value) / dt - this.speed);
    const cutoff = MIN_CUTOFF + BETA * Math.abs(this.speed);
    this.value += smoothing(cutoff, dt) * (x - this.value);
    return this.value;
  }
}

function smoothing(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

// Draws each hand's gesture label. `mirrored` flips x to match a mirrored video.
export function drawHands(ctx: CanvasRenderingContext2D, hands: Hand[], mirrored: boolean) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const px = (p: { x: number; y: number }) => ({ x: (mirrored ? 1 - p.x : p.x) * w, y: p.y * h });

  for (const hand of hands) {
    // Label in a white pill under the wrist, kept inside the frame.
    const wrist = px(hand.landmarks[WRIST]);
    const label = `${hand.side} · ${hand.gesture.replace("_", " ")}`;
    ctx.font = "600 18px -apple-system, 'Segoe UI', Roboto, sans-serif";
    const width = ctx.measureText(label).width + 24;
    const x = Math.min(Math.max(wrist.x, width / 2 + 8), w - width / 2 - 8);
    const y = Math.min(wrist.y + 16, h - 40);
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.beginPath();
    ctx.roundRect(x - width / 2, y, width, 32, 16);
    ctx.fill();
    ctx.fillStyle = "#1c2b33";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 16);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }
}
