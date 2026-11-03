import {
  FilesetResolver,
  GestureRecognizer,
  InteractiveSegmenterLegacy,
  type Landmark,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { isPointing, pointerFrom, shapeGesture, thumbOut } from "../gestures";
import { highlightAt, initHighlighter } from "../highlight";

// Offline debugging: replays saved phone frames through the same gesture + highlight code the
// app uses, and draws what happened on each frame. Driven by tools/replay/replay.mjs in
// headless Chrome, but works from any page on the dev server:
//   const r = await import("/src/debug/replay.ts"); await r.runReplay([{ name, image }]);

export interface ReplayItem {
  name: string;
  image: string; // data URL (or any URL the page can load)
  meta?: Record<string, unknown>; // the .json the app saved next to the frame, if any
}

export type ReplayReason = "no-hand" | "not-pointing" | "no-object" | "background" | "hand" | "different" | "ok" | "error";

export interface ReplayResult {
  name: string;
  width: number;
  height: number;
  reason: ReplayReason;
  handFound: boolean;
  handedness?: string;
  mpGesture?: string; // MediaPipe's top gesture, whatever its score
  mpScore?: number;
  shape?: string; // our shapeGesture() backup
  thumb?: { out: number; down: number }; // thumbOut(): how far the thumb sticks out of a fist, which way
  isPointing?: boolean; // fresh frame (strict thresholds)
  isPointingLoose?: boolean; // if the previous frame was already pointing (looser thresholds)
  straightness?: number[]; // index, middle, ring, pinky: tip-to-wrist / pip-to-wrist, ~1.3+ straight, <1 curled
  pointer?: { x: number; y: number };
  pointerAtEdge?: boolean; // pointer was clamped to the frame edge
  fingerPx?: number; // index pip-to-tip length in pixels, small = hand far away
  // highlightAt()'s result, passed through. edges/ragged are its background-vs-object measurements.
  highlight?: {
    ok: boolean;
    reason?: string;
    coverage: number;
    ms: number;
    box?: { x: number; y: number; w: number; h: number };
    edges?: number;
    ragged?: number;
  };
  rawCoverage?: number; // share of the frame our own segment pass found under the pointer
  png: string; // annotated frame, data URL
  error?: string;
}

const WRIST = 0;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const FINGERS = [
  { pip: 6, tip: 8 },
  { pip: 10, tip: 12 },
  { pip: 14, tip: 16 },
  { pip: 18, tip: 20 },
];

let recognizer: GestureRecognizer | null = null;
// A second segmenter just for drawing: highlightAt() doesn't hand back its mask, and on failure
// we still want to see what the model picked (e.g. the whole desk, or the finger).
let viewSegmenter: InteractiveSegmenterLegacy | null = null;
let delegates = "";

export async function initReplay(): Promise<string> {
  if (recognizer) return delegates;
  const vision = await FilesetResolver.forVisionTasks("/mediapipe");

  const gestureOptions = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/models/gesture_recognizer.task", delegate },
    runningMode: "IMAGE" as const,
    numHands: 1,
    minHandDetectionConfidence: 0.4,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  let gestureDelegate = "GPU";
  try {
    recognizer = await GestureRecognizer.createFromOptions(vision, gestureOptions("GPU"));
  } catch {
    recognizer = await GestureRecognizer.createFromOptions(vision, gestureOptions("CPU"));
    gestureDelegate = "CPU";
  }

  const segOptions = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/models/magic_touch.tflite", delegate },
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
  try {
    viewSegmenter = await InteractiveSegmenterLegacy.createFromOptions(vision, segOptions("GPU"));
  } catch {
    viewSegmenter = await InteractiveSegmenterLegacy.createFromOptions(vision, segOptions("CPU"));
  }
  // Same warm-up as initHighlighter(). On GPU the size of the first image changes all later
  // masks, so without this our drawing wouldn't match what highlightAt() saw.
  const blank = document.createElement("canvas");
  blank.width = blank.height = 64;
  blank.getContext("2d")!.fillRect(0, 0, 64, 64);
  viewSegmenter.segment(blank, { keypoint: { x: 0.5, y: 0.5 } }).close();

  const highlightDelegate = await initHighlighter();
  delegates = `gestures ${gestureDelegate}, highlight ${highlightDelegate}`;
  return delegates;
}

export async function runReplay(items: ReplayItem[]): Promise<ReplayResult[]> {
  await initReplay();
  const results: ReplayResult[] = [];
  for (const item of items) results.push(await replayFrame(item));
  return results;
}

export async function replayFrame(item: ReplayItem): Promise<ReplayResult> {
  await initReplay();
  const img = await loadImage(item.image);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  // Draw into a canvas once and feed that to every model, like a video frame.
  const frame = document.createElement("canvas");
  frame.width = w;
  frame.height = h;
  frame.getContext("2d")!.drawImage(img, 0, 0);

  const out: ReplayResult = { name: item.name, width: w, height: h, reason: "no-hand", handFound: false, png: "" };
  let landmarks: NormalizedLandmark[] | null = null;
  let mask: { data: Uint8Array; w: number; h: number; target: number } | null = null;

  try {
    const result = recognizer!.recognize(frame);
    landmarks = result.landmarks[0] ?? null;
    const world: Landmark[] | undefined = result.worldLandmarks[0];
    if (landmarks && world) {
      out.handFound = true;
      out.handedness = result.handedness[0]?.[0]?.categoryName;
      const top = result.gestures[0]?.[0];
      out.mpGesture = top?.categoryName || "None";
      out.mpScore = round(top?.score ?? 0, 2);
      out.shape = shapeGesture(world);
      const thumb = thumbOut(world);
      out.thumb = { out: round(thumb.out, 2), down: round(thumb.down, 2) };
      out.straightness = FINGERS.map((f) => round(straightness(world, f), 2));
      out.isPointing = isPointing(world, false);
      out.isPointingLoose = isPointing(world, true);

      const pointer = pointerFrom(landmarks);
      out.pointer = { x: round(pointer.x, 3), y: round(pointer.y, 3) };
      out.pointerAtEdge = pointer.x <= 0 || pointer.x >= 1 || pointer.y <= 0 || pointer.y >= 1;
      const tip = landmarks[INDEX_TIP];
      const pip = landmarks[INDEX_PIP];
      out.fingerPx = Math.round(Math.hypot((tip.x - pip.x) * w, (tip.y - pip.y) * h));

      // Highlight even when not pointing, so we learn whether the object part would have worked.
      const hl = highlightAt(frame, pointer, [
        { x: tip.x, y: tip.y },
        { x: pip.x, y: pip.y },
      ]);
      out.highlight = { ...hl, coverage: round(hl.coverage, 4) };
      if (typeof out.highlight.ragged === "number") out.highlight.ragged = round(out.highlight.ragged, 2);
      out.reason = !out.isPointing ? "not-pointing" : hl.ok ? "ok" : hl.reason;

      mask = segmentForView(frame, pointer);
      if (mask) out.rawCoverage = round(mask.data.reduce((n, v) => n + (v === mask!.target ? 1 : 0), 0) / mask.data.length, 4);
    }
  } catch (e) {
    out.reason = "error";
    out.error = String((e as Error)?.stack ?? e);
  }

  out.png = annotate(frame, out, landmarks, mask, item.meta);
  return out;
}

// Same idea as highlightAt: the mask value under the point is "the object".
function segmentForView(frame: HTMLCanvasElement, point: { x: number; y: number }) {
  if (!viewSegmenter) return null;
  const result = viewSegmenter.segment(frame, { keypoint: point });
  const m = result.categoryMask;
  if (!m) {
    result.close();
    return null;
  }
  const data = m.getAsUint8Array().slice();
  const px = Math.min(m.width - 1, Math.max(0, Math.floor(point.x * m.width)));
  const py = Math.min(m.height - 1, Math.max(0, Math.floor(point.y * m.height)));
  const out = { data, w: m.width, h: m.height, target: data[py * m.width + px] };
  result.close();
  return out;
}

function annotate(
  frame: HTMLCanvasElement,
  r: ReplayResult,
  lm: NormalizedLandmark[] | null,
  mask: { data: Uint8Array; w: number; h: number; target: number } | null,
  meta?: Record<string, unknown>,
): string {
  const w = frame.width;
  const h = frame.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(frame, 0, 0);
  const unit = Math.max(w, h) / 640; // scale lines and text with the image size

  // Segment under the pointer: blue if the app would accept it, red if it was rejected.
  if (mask) {
    const good = r.highlight?.ok;
    const color = good ? [8, 102, 255, 120] : [255, 50, 50, 120];
    const m = document.createElement("canvas");
    m.width = mask.w;
    m.height = mask.h;
    const mctx = m.getContext("2d")!;
    const image = mctx.createImageData(mask.w, mask.h);
    for (let i = 0; i < mask.data.length; i++) if (mask.data[i] === mask.target) image.data.set(color, i * 4);
    mctx.putImageData(image, 0, 0);
    ctx.drawImage(m, 0, 0, w, h);
  }
  if (r.highlight?.box) {
    const b = r.highlight.box;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * unit;
    ctx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h);
  }

  // Hand skeleton, index finger in yellow.
  if (lm) {
    ctx.lineCap = "round";
    for (const { start, end } of GestureRecognizer.HAND_CONNECTIONS) {
      const index = start >= 5 && start <= 8 && end >= 5 && end <= 8;
      ctx.strokeStyle = index ? "#ffd400" : "rgba(255,255,255,0.9)";
      ctx.lineWidth = (index ? 3 : 2) * unit;
      ctx.beginPath();
      ctx.moveTo(lm[start].x * w, lm[start].y * h);
      ctx.lineTo(lm[end].x * w, lm[end].y * h);
      ctx.stroke();
    }
    for (const p of lm) {
      ctx.fillStyle = "#0866ff";
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 3 * unit, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Pointer from the replay (green = pointing, orange = not), and the one the app recorded (dashed grey).
  const ring = (p: { x: number; y: number }, color: string, dashed: boolean) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * unit;
    if (dashed) ctx.setLineDash([5 * unit, 4 * unit]);
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 12 * unit, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 2 * unit, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  };
  const appPointer = meta?.pointer as { x?: unknown; y?: unknown } | null | undefined;
  if (appPointer && typeof appPointer.x === "number" && typeof appPointer.y === "number") {
    ring({ x: appPointer.x, y: appPointer.y }, "rgba(200,200,200,0.95)", true);
  }
  if (r.pointer) ring(r.pointer, r.isPointing ? "#00e676" : "#ff9100", false);

  // Text panel, top-left.
  const lines = [
    `${r.name}`,
    `replay: ${r.reason.toUpperCase()}` + (meta?.reason ? `   (app said: ${meta.reason})` : ""),
  ];
  if (r.handFound) {
    lines.push(`MP: ${r.mpGesture} ${r.mpScore?.toFixed(2)}   shape: ${r.shape}   thumb out ${r.thumb?.out} down ${r.thumb?.down}   ${r.handedness ?? ""}`);
    lines.push(`isPointing: ${r.isPointing} (loose: ${r.isPointingLoose})`);
    lines.push(`straight i/m/r/p: ${r.straightness?.join(" / ")}`);
    const hl = r.highlight;
    if (hl) {
      const shape = hl.edges !== undefined ? `  edges ${hl.edges}  ragged ${hl.ragged}` : "";
      lines.push(`highlight: ${hl.ok ? "ok" : hl.reason}  cov ${(hl.coverage * 100).toFixed(1)}%${shape}  ${hl.ms} ms`);
    }
    if (hl && r.rawCoverage !== undefined && Math.abs(r.rawCoverage - hl.coverage) > 0.01) {
      lines.push(`(drawn mask ${(r.rawCoverage * 100).toFixed(1)}% differs from the app's)`);
    }
    lines.push(`pointer ${r.pointer?.x}, ${r.pointer?.y}${r.pointerAtEdge ? " (AT EDGE)" : ""}  finger ${r.fingerPx}px`);
  } else if (r.error) {
    lines.push(`error: ${r.error.split("\n")[0]}`);
  } else {
    lines.push("no hand detected");
  }
  if (meta && (meta.gesture || meta.rawGesture || meta.mpGesture)) {
    lines.push(`app: stable ${meta.gesture ?? "?"}, raw ${meta.rawGesture ?? "?"}, MP ${meta.mpGesture ?? "?"} ${typeof meta.mpScore === "number" ? meta.mpScore.toFixed(2) : ""}`);
  }

  const size = Math.round(13 * unit);
  ctx.font = `600 ${size}px "Segoe UI", Roboto, sans-serif`;
  const pad = 6 * unit;
  const lineH = size * 1.3;
  const boxW = Math.min(w, Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2);
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(0, 0, boxW, lines.length * lineH + pad * 2);
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 1 ? (r.reason === "ok" ? "#00e676" : "#ff5252") : "#ffffff";
    ctx.fillText(line, pad, pad + i * lineH);
  });

  return canvas.toDataURL("image/png");
}

// Mirrors gestures.ts: tip-to-wrist distance over pip-to-wrist distance.
function straightness(world: Landmark[], f: { pip: number; tip: number }) {
  const d = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return d(world[WRIST], world[f.tip]) / Math.max(d(world[WRIST], world[f.pip]), 1e-6);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not load image"));
    img.src = src;
  });
}

function round(v: number, digits: number) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
