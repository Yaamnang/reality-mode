// The Time Knob's glowing magic circle, drawn around the open hand. Three layers of rings and
// glyphs are painted once (glow is slow to draw every frame), then turned with the hand. The glyphs
// are made up from a small grid, so they need no special font and are our own.

const SIZE = 640; // px of each painted layer
const HALF = SIZE / 2;
const UNIT = HALF / 1.08; // radius 1 of the circle, in layer pixels (the glow needs a margin)
const LINE = "#ffc46b";
const CORE = "#fff0d0";
const GLOW = "#ff6a00";
const SLOW_SPIN = 0.012; // degrees per ms when the hand isn't turning
const MAX_SPARKS = 140;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // 1 -> 0
  size: number;
}

let layers: HTMLCanvasElement[] | null = null;
let sparks: Spark[] = [];

// Calls `paint` twice: once wide and glowing, once thin and bright.
function glowing(c: CanvasRenderingContext2D, width: number, paint: () => void) {
  c.save();
  c.lineCap = "round";
  c.lineJoin = "round";
  c.shadowColor = GLOW;
  c.shadowBlur = 22;
  c.strokeStyle = LINE;
  c.lineWidth = width * 1.6;
  c.beginPath();
  paint();
  c.stroke();
  c.shadowBlur = 6;
  c.strokeStyle = CORE;
  c.lineWidth = width * 0.6;
  c.beginPath();
  paint();
  c.stroke();
  c.restore();
}

function circle(c: CanvasRenderingContext2D, r: number) {
  c.moveTo(r * UNIT, 0);
  c.arc(0, 0, r * UNIT, 0, Math.PI * 2);
}

function polygon(c: CanvasRenderingContext2D, r: number, corners: number, turn = 0) {
  for (let i = 0; i <= corners; i++) {
    const a = turn + (i / corners) * Math.PI * 2;
    const x = Math.cos(a) * r * UNIT;
    const y = Math.sin(a) * r * UNIT;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
}

// A made-up glyph: a few strokes between the points of a small 3x3 grid, always the same per seed.
function glyph(c: CanvasRenderingContext2D, seed: number, size: number) {
  let s = seed * 2654435761;
  const next = (n: number) => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return Math.floor((s / 4294967296) * n);
  };
  const point = () => [(next(3) - 1) * size, (next(3) - 1) * size];
  let [x, y] = point();
  c.moveTo(x, y);
  for (let i = 0; i < 4; i++) {
    [x, y] = point();
    if (next(4) === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
}

function paintLayers(): HTMLCanvasElement[] {
  const layer = (paint: (c: CanvasRenderingContext2D) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const c = canvas.getContext("2d")!;
    c.translate(HALF, HALF);
    paint(c);
    return canvas;
  };

  // Outer: two rings with a band of glyphs between them and a ruler of ticks outside.
  const outer = layer((c) => {
    glowing(c, 3, () => circle(c, 1));
    glowing(c, 2, () => circle(c, 0.81));
    glowing(c, 1.5, () => {
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const long = i % 6 === 0 ? 1.05 : 1.025;
        c.moveTo(Math.cos(a) * UNIT, Math.sin(a) * UNIT);
        c.lineTo(Math.cos(a) * long * UNIT, Math.sin(a) * long * UNIT);
      }
    });
    const count = 26;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      c.save();
      c.rotate(a);
      c.translate(0, -0.905 * UNIT);
      glowing(c, 1.6, () => glyph(c, i + 1, 0.042 * UNIT));
      c.restore();
    }
  });

  // Middle: two squares crossing into an eight-pointed star, with small rings on its points.
  const middle = layer((c) => {
    glowing(c, 2.5, () => {
      polygon(c, 0.78, 4);
      polygon(c, 0.78, 4, Math.PI / 4);
    });
    glowing(c, 2, () => circle(c, 0.56));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      c.save();
      c.translate(Math.cos(a) * 0.78 * UNIT, Math.sin(a) * 0.78 * UNIT);
      glowing(c, 1.5, () => circle(c, 0.035));
      c.restore();
    }
  });

  // Inner: two triangles crossing, ring, broken ring and a small center.
  const inner = layer((c) => {
    glowing(c, 2, () => {
      polygon(c, 0.54, 3, -Math.PI / 2);
      polygon(c, 0.54, 3, Math.PI / 2);
    });
    glowing(c, 2, () => circle(c, 0.3));
    glowing(c, 1.5, () => {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        c.moveTo(Math.cos(a) * 0.2 * UNIT, Math.sin(a) * 0.2 * UNIT);
        c.arc(0, 0, 0.2 * UNIT, a, a + 0.7);
      }
    });
    glowing(c, 1.5, () => circle(c, 0.07));
  });
  return [outer, middle, inner];
}

// `squash` and `axis`: the circle lies flat in the palm's plane, so it's squeezed by `squash` along
// the screen direction `axis` (radians). `twist`: how far the hand has turned, degrees, clockwise.
export function drawMagicCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  squash: number,
  axis: number,
  twist: number,
  alpha: number,
  flash: number,
  now: number,
) {
  layers ??= paintLayers();
  const idle = now * SLOW_SPIN;
  const turns = [twist + idle, -twist * 0.7 - idle * 1.4, twist * 1.5 + idle * 0.6];
  const opening = 0.7 + 0.3 * alpha; // grows open as it fades in
  const size = (radius * 1.08 * opening * (1 + flash * 0.06)) | 0;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(x, y);
  ctx.rotate(axis);
  ctx.scale(squash, 1);
  ctx.rotate(-axis);

  const glow = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, size);
  glow.addColorStop(0, `rgba(255, 150, 40, ${0.18 * alpha + 0.2 * flash})`);
  glow.addColorStop(0.75, `rgba(255, 110, 0, ${0.08 * alpha + 0.1 * flash})`);
  glow.addColorStop(1, "rgba(255, 90, 0, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = alpha;
  layers.forEach((layer, i) => {
    ctx.save();
    ctx.rotate((turns[i] * Math.PI) / 180);
    ctx.drawImage(layer, -size, -size, size * 2, size * 2);
    ctx.restore();
  });
  ctx.restore();

  if (alpha > 0.3) spawnSparks(x, y, radius * opening, squash, axis, twist, 2);
  drawSparks(ctx);
}

// Sparks thrown off the rim, turning the way the hand turns.
function spawnSparks(x: number, y: number, radius: number, squash: number, axis: number, twist: number, count: number) {
  const dir = twist < 0 ? -1 : 1;
  for (let i = 0; i < count && sparks.length < MAX_SPARKS; i++) {
    const a = Math.random() * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // On the rim, squeezed the same way as the circle.
    const along = (cos * Math.cos(axis) + sin * Math.sin(axis)) * (squash - 1);
    const px = cos + along * Math.cos(axis);
    const py = sin + along * Math.sin(axis);
    const speed = radius * (0.006 + Math.random() * 0.012);
    sparks.push({
      x: x + px * radius,
      y: y + py * radius,
      vx: -sin * speed * dir + cos * speed * 0.3,
      vy: cos * speed * dir + sin * speed * 0.3,
      life: 1,
      size: 1 + Math.random() * 2.2,
    });
  }
}

// A burst of sparks, when the knob clicks onto another moment in time.
export function burstSparks(x: number, y: number, radius: number) {
  for (let i = 0; i < 40 && sparks.length < MAX_SPARKS * 1.5; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = radius * (0.015 + Math.random() * 0.04);
    sparks.push({
      x: x + Math.cos(a) * radius,
      y: y + Math.sin(a) * radius,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 1,
      size: 1.5 + Math.random() * 2.5,
    });
  }
}

export function drawSparks(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const s of sparks) {
    s.x += s.vx;
    s.y += s.vy;
    s.vy += 0.03;
    s.life -= 0.022;
    if (s.life <= 0) continue;
    ctx.globalAlpha = s.life;
    ctx.fillStyle = s.life > 0.6 ? CORE : LINE;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  sparks = sparks.filter((s) => s.life > 0);
}

export function clearSparks() {
  sparks = [];
}

// The time scale over the circle: a mark per moment (past on the left, now on top, future on the
// right), and a needle on the current one. `marks`: each stage's place (-2..2) and whether it's ready.
export function drawTimeScale(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  marks: { at: number; status: "waiting" | "ready" | "failed" }[],
  at: number,
  alpha: number,
) {
  const STEP = Math.PI / 5.5;
  const r = radius * 1.14;
  const place = (i: number) => {
    const a = -Math.PI / 2 + i * STEP;
    return { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
  };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = GLOW;

  const needle = place(at);
  ctx.shadowBlur = 14;
  ctx.strokeStyle = CORE;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + (needle.x - x) * 0.72, y + (needle.y - y) * 0.72);
  ctx.lineTo(needle.x, needle.y);
  ctx.stroke();

  for (const m of [{ at: 0, status: "ready" as const }, ...marks]) {
    const p = place(m.at);
    const here = m.at === at;
    ctx.shadowBlur = here ? 18 : 6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, here ? 10 : 6, 0, Math.PI * 2);
    if (m.status === "failed") {
      ctx.fillStyle = "rgba(120, 120, 120, 0.8)";
      ctx.fill();
    } else if (m.status === "waiting") {
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = here ? CORE : LINE;
      ctx.fill();
    }
  }
  ctx.restore();
}
