import type { Hand } from "./gestures";

// Keeps hands in front of whatever is drawn over the camera: their shapes, from the hand landmarks,
// cut out of the live picture. The model only sees as far as the wrist, so the forearm is a guess: a
// straight line on from the hand. It only shows where something is drawn over the camera, and there
// a wrong guess shows a strip of the real room.

const CHAINS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
];
const PALM = [0, 1, 5, 9, 13, 17];
const FINGER_WIDTH = 0.36; // of the palm's length
const FOREARM_WIDTH = 0.85; // of the palm's length
const FOREARM_LENGTH = 3; // palm lengths past the wrist
const SOFT_EDGE = 3; // px of a 1280-wide frame

let layer: HTMLCanvasElement | null = null;

// Paints the hands' shapes on `c`, in its current style (lines and fills).
export function drawHandShapes(c: CanvasRenderingContext2D, hands: Hand[], w: number, h: number) {
  for (const hand of hands) {
    const lm = hand.landmarks;
    c.lineWidth = palmLength(hand, w, h) * FINGER_WIDTH;
    c.beginPath();
    for (const chain of CHAINS) {
      chain.forEach((j, i) => {
        if (i === 0) c.moveTo(lm[j].x * w, lm[j].y * h);
        else c.lineTo(lm[j].x * w, lm[j].y * h);
      });
    }
    c.stroke();
    c.beginPath();
    PALM.forEach((j, i) => {
      if (i === 0) c.moveTo(lm[j].x * w, lm[j].y * h);
      else c.lineTo(lm[j].x * w, lm[j].y * h);
    });
    c.closePath();
    c.fill();
    c.stroke();
  }
}

function palmLength(hand: Hand, w: number, h: number) {
  const lm = hand.landmarks;
  return Math.hypot((lm[0].x - lm[9].x) * w, (lm[0].y - lm[9].y) * h);
}

// The hands and forearms as a see-through picture of `source`. null if there are no hands.
export function cutOutHands(source: CanvasImageSource, hands: Hand[], w: number, h: number): HTMLCanvasElement | null {
  if (!hands.length) return null;
  layer ??= document.createElement("canvas");
  if (layer.width !== w || layer.height !== h) {
    layer.width = w;
    layer.height = h;
  }
  const c = layer.getContext("2d")!;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, w, h);
  c.filter = `blur(${Math.max(1, Math.round((SOFT_EDGE * w) / 1280))}px)`;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = "#fff";
  c.fillStyle = "#fff";
  drawHandShapes(c, hands, w, h);
  for (const hand of hands) {
    const wrist = hand.landmarks[0];
    const palm = hand.landmarks[9];
    c.lineWidth = palmLength(hand, w, h) * FOREARM_WIDTH;
    c.beginPath();
    c.moveTo(wrist.x * w, wrist.y * h);
    c.lineTo((wrist.x + (wrist.x - palm.x) * FOREARM_LENGTH) * w, (wrist.y + (wrist.y - palm.y) * FOREARM_LENGTH) * h);
    c.stroke();
  }
  c.filter = "none";
  c.globalCompositeOperation = "source-in";
  c.drawImage(source, 0, 0, w, h);
  return layer;
}
