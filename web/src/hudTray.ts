import type { Hand } from "./gestures";
import type { Item } from "./realityShift";

// The object tray as a heads-up display: cards across the top of the camera view, worked by hand.
//   Three fingers up + move the hand sideways -> swipe the cards (a carousel; the middle one is focused)
//   Two fingers (✌) held                      -> select the focused card
// The swipe works anywhere in view (holding a hand up at the top of the frame is tiring and often
// goes out of view).

// Layout, as fractions of the frame height (cards keep their shape on wide and square cameras).
const CARD_H = 0.11;
const CARD_RATIO = 3.2; // width / height: room for the picture and a name
const GAP = 0.02;
const TOP = 0.03;
// Cards move this many times as far as the hand, so a short swipe crosses a card or two.
const SWIPE_GAIN = 1.6;
// ✌ must be held this long to select (it's easy to pass through on the way to another gesture).
const SELECT_HOLD_MS = 400;
// After the last three-finger frame, the tray stays in "browsing" mode this long (✌ works, the
// focused card stays big).
const ACTIVE_MS = 3000;
const MIDDLE_KNUCKLE = 9;
// The hand tracker misses a frame now and then: gaps shorter than this don't end a swipe.
const SWIPE_GAP_MS = 150;

let scroll = 0; // which card (fractional index) is in the middle
let lastPalmX: number | null = null;
let lastThreeAt = 0;
// Distance between card centers as a share of the frame width (set when drawing).
let slot = 0.2;
let activeUntil = 0;
let victorySince: number | null = null;
const images = new WeakMap<Item, HTMLImageElement>();

// Call every frame. Returns the index of the card to select, or null.
// `mirrored`: the view is mirrored, so hand movement on screen is the opposite of the raw frame.
// The gestures a hand can do by accident, or that the demo doesn't need: three-finger swipe + ✌ on the
// tray, both open hands for the inventory, left open hand to remove. Off since 2026-11-04: just showing
// a hand or touching something kept setting things off. true brings them all back.
export const EXTRA_GESTURES = false;

export function trayGestures(hands: Hand[], items: readonly Item[], selectedIndex: number, mirrored: boolean, now: number): number | null {
  const n = items.length;
  if (!n) {
    scroll = 0;
    lastPalmX = null;
    activeUntil = 0;
    return null;
  }

  const three = hands.find((h) => h.gesture === "Three");
  if (three) {
    const x = three.landmarks[MIDDLE_KNUCKLE].x;
    if (lastPalmX !== null) {
      // Drag: the cards follow the hand as seen on screen.
      const dx = (x - lastPalmX) * (mirrored ? -1 : 1);
      scroll = clamp(scroll - (dx / slot) * SWIPE_GAIN, -0.4, n - 0.6);
    }
    lastPalmX = x;
    lastThreeAt = now;
    activeUntil = now + ACTIVE_MS;
  } else if (now - lastThreeAt > SWIPE_GAP_MS) {
    lastPalmX = null;
    // Settle on a card: the nearest while browsing, otherwise the selected one.
    const target = now < activeUntil || selectedIndex < 0 ? Math.round(clamp(scroll, 0, n - 1)) : selectedIndex;
    scroll += (target - scroll) * 0.2;
  }

  const browsing = now < activeUntil;
  victorySince = browsing && hands.some((h) => h.gesture === "Victory") ? (victorySince ?? now) : null;
  if (victorySince !== null && now - victorySince >= SELECT_HOLD_MS) {
    victorySince = null;
    activeUntil = 0;
    return focusIndex(n);
  }
  return null;
}

function focusIndex(n: number) {
  return Math.round(clamp(scroll, 0, n - 1));
}

// Draws the cards over the camera view (the overlay canvas isn't mirrored, so text reads normally).
export function drawTray(ctx: CanvasRenderingContext2D, items: readonly Item[], selected: Item | null, now: number) {
  const n = items.length;
  if (!n) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const browsing = now < activeUntil;
  const focus = focusIndex(n);
  const cardH = CARD_H * H;
  const cardW = cardH * CARD_RATIO;
  slot = (cardW + GAP * H) / W;
  const font = Math.max(12, Math.round(cardH / 4.4));

  items.forEach((item, i) => {
    const focused = browsing && i === focus;
    const scale = focused ? 1.12 : 1;
    const w = cardW * scale;
    const h = cardH * scale;
    const cx = (0.5 + (i - scroll) * slot) * W;
    if (cx + w / 2 < 0 || cx - w / 2 > W) return;
    const x = cx - w / 2;
    const y = TOP * H;
    const r = h * 0.18;

    ctx.save();
    ctx.globalAlpha = browsing && !focused ? 0.75 : 1;
    ctx.shadowColor = focused ? "rgba(8, 102, 255, 0.7)" : "rgba(0, 0, 0, 0.25)";
    ctx.shadowBlur = focused ? 24 : 10;
    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (item === selected || focused) {
      ctx.lineWidth = item === selected ? 4 : 3;
      ctx.strokeStyle = "#0866ff";
      ctx.stroke();
    }

    // Picture of the object, then its name and state.
    const pad = h * 0.12;
    const size = h - pad * 2;
    ctx.fillStyle = "#f1f4f7";
    ctx.beginPath();
    ctx.roundRect(x + pad, y + pad, size, size, r * 0.6);
    ctx.fill();
    const img = imageOf(item);
    if (img.complete && img.naturalWidth) {
      const k = Math.min(size / img.naturalWidth, size / img.naturalHeight);
      ctx.drawImage(img, x + pad + (size - img.naturalWidth * k) / 2, y + pad + (size - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
    }
    const tx = x + pad * 2 + size;
    const maxText = x + w - pad - tx;
    ctx.fillStyle = "#1c2b33";
    ctx.font = `600 ${font}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(fit(ctx, item.label || `Object ${item.id}`, maxText), tx, y + h * 0.36);
    const state = `${item.id} · ${{ locked: "Locked", moved: item.command ? "Moved + transmuted" : "Moved", erased: "Erased", changed: "Transmuted", stored: "In inventory" }[item.state]}`;
    ctx.font = `600 ${Math.round(font * 0.8)}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillStyle = { locked: "#31a24c", moved: "#0866ff", erased: "#65676b", changed: "#9b51e0", stored: "#e8710a" }[item.state];
    ctx.fillText(state, tx, y + h * 0.7);

    // Holding ✌ on the focused card: a bar fills along its bottom edge.
    if (focused && victorySince !== null) {
      const t = Math.min((now - victorySince) / SELECT_HOLD_MS, 1);
      ctx.fillStyle = "#0866ff";
      ctx.fillRect(x + r, y + h - 5, (w - 2 * r) * t, 4);
    }
    ctx.restore();
  });

  // What to do next, under the cards.
  const hint = !EXTRA_GESTURES ? "" : browsing ? "Swipe with 3 fingers  ·  hold ✌ to select" : n > 1 ? "3 fingers up to browse objects" : "";
  if (hint) {
    ctx.font = `600 ${Math.round(font * 0.85)}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    const tw = ctx.measureText(hint).width + 24;
    const hy = TOP * H + cardH * 1.12 + 10;
    ctx.fillStyle = "rgba(28, 43, 51, 0.7)";
    ctx.beginPath();
    ctx.roundRect(W / 2 - tw / 2, hy, tw, font * 1.6, font * 0.8);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(hint, W / 2, hy + font * 0.8);
    ctx.textAlign = "start";
  }
  ctx.textBaseline = "alphabetic";
}

function imageOf(item: Item) {
  let img = images.get(item);
  if (!img) {
    img = new Image();
    img.src = item.thumb;
    images.set(item, img);
  }
  return img;
}

// Shortens text with "…" to fit `max` pixels.
function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
