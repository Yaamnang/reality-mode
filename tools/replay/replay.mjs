// Replays saved debug frames through the app's own gesture + highlight code in headless Chrome,
// then writes annotated PNGs and a report.md.
//
// Usage (from the project root, with the dev server running at https://localhost:5173):
//   node tools/replay/replay.mjs [frames-folder]
// Default folder: debug-frames/. Output: <folder>/report/ (report.md + one PNG per frame).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP = process.env.APP_URL ?? "https://localhost:5173";
// A blank page on the dev server's origin, so we can import the app's modules without
// starting the app itself (camera, remote logging, etc.).
const BLANK = `${APP}/__replay__.html`;

const folder = resolve(process.argv[2] ?? join(ROOT, "debug-frames"));
const outDir = join(folder, "report");

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function loadFrames() {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
    .sort()
    .map((file) => {
      const name = basename(file, extname(file));
      const jsonPath = join(folder, `${name}.json`);
      let meta = null;
      if (existsSync(jsonPath)) {
        try {
          meta = JSON.parse(readFileSync(jsonPath, "utf8"));
        } catch (e) {
          console.warn(`  ! ${name}.json is not valid JSON, ignoring it (${e.message})`);
        }
      }
      const bytes = readFileSync(join(folder, file));
      const image = `data:${MIME[extname(file).toLowerCase()]};base64,${bytes.toString("base64")}`;
      return { file, name, image, meta };
    });
}

async function main() {
  const frames = loadFrames();
  if (frames.length === 0) {
    console.log(`No frames found in ${folder}. Save some from the app first (pairs of <name>.jpg + <name>.json).`);
    return;
  }
  console.log(`Replaying ${frames.length} frame(s) from ${folder}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    acceptInsecureCerts: true,
    args: ["--ignore-certificate-errors", "--enable-unsafe-swiftshader"],
  });

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const text = msg.text();
      // Only show real warnings and errors. Skip MediaPipe's log lines ("W1028 ...", "INFO: ...")
      // and Vite's live-reload socket, which headless Chrome blocks (harmless).
      if (msg.type() !== "error" && msg.type() !== "warn") return;
      if (/^[IW]\d{4} |^INFO:|WebSocket|\[vite\]|favicon|status of 404/.test(text)) return;
      console.log(`  [page ${msg.type()}] ${text.slice(0, 300)}`);
    });
    page.on("pageerror", (err) => console.log(`  [page error] ${err.message}`));

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url() === BLANK) {
        req.respond({ status: 200, contentType: "text/html", body: "<!doctype html><title>replay</title><body></body>" });
      } else {
        req.continue();
      }
    });

    try {
      await page.goto(BLANK, { waitUntil: "load", timeout: 15000 });
    } catch (e) {
      throw new Error(`Could not open ${APP}. Is the dev server running (cd web && npm run dev)?\n${e.message}`);
    }

    const delegates = await page.evaluate(async () => {
      const mod = await import("/src/debug/replay.ts");
      window.__replay = mod;
      return mod.initReplay();
    });
    console.log(`Models ready (${delegates})`);

    mkdirSync(outDir, { recursive: true });
    const results = [];
    // One frame per call, so big images don't make one giant message and we can show progress.
    for (const f of frames) {
      const r = await page.evaluate((item) => window.__replay.replayFrame(item), {
        name: f.name,
        image: f.image,
        meta: f.meta ?? undefined,
      });
      const png = `${f.name}.png`;
      writeFileSync(join(outDir, png), Buffer.from(r.png.split(",")[1], "base64"));
      delete r.png;
      results.push({ ...r, file: f.file, png, meta: f.meta });
      const hl = r.highlight ? (r.highlight.ok ? "ok" : r.highlight.reason) : "-";
      console.log(
        `  ${f.name}: ${r.reason}  (app: ${f.meta?.reason ?? "?"})  MP ${r.mpGesture ?? "-"} ${r.mpScore ?? ""}  pointing ${r.isPointing ?? "-"}  highlight ${hl}`,
      );
      if (r.error) console.log(`    error: ${r.error.split("\n")[0]}`);
    }

    writeFileSync(join(outDir, "report.md"), buildReport(results, delegates));
    writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
    console.log(`\nWrote ${join(outDir, "report.md")} and ${results.length} PNG(s).`);
  } finally {
    await browser.close();
  }
}

// What each failure means and what to try, in plain words.
const CAUSES = {
  "no-hand": "MediaPipe found no hand in the frame. Hand too small/far, cut off by the frame edge, blurry, or bad light.",
  "not-pointing":
    "A hand was found but isPointing() said no. Compare the finger straightness numbers (index/middle/ring/pinky, ~1.3+ = straight, <1 = curled) with the limits in isPointing() in web/src/gestures.ts.",
  "no-object": "Pointing worked, but the segmenter found nothing under the pointer (empty mask).",
  background:
    "Pointing worked, but the segment under the pointer looked like a surface (desk/wall) and was rejected: too much of the frame (coverage), touching the frame edges (edges), or a jagged outline (ragged). See highlight.ts for the limits.",
  hand: "Pointing worked, but the segment under the pointer contained the fingertip, i.e. it picked the hand. Pointer probably too close to the finger.",
  ok: "Worked.",
  error: "The replay itself crashed on this frame (see error).",
};

function buildReport(results, delegates) {
  const fmt = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "-");
  const out = [];
  out.push(`# Debug frame replay`);
  out.push("");
  out.push(`${new Date().toISOString()} · ${results.length} frame(s) · ${delegates}`);
  out.push("");
  out.push(
    "Replay runs each saved frame through the app's own `isPointing`, `pointerFrom` and `highlightAt` (single image, no smoothing or vote history, so it can differ a little from live).",
  );
  out.push("");
  out.push("| Frame | App reason | Replay | MP gesture (score) | shape | isPointing (loose) | straight i/m/r/p | pointer | finger px | highlight | coverage | edges | ragged | ms |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const m = r.meta ?? {};
    const hl = r.highlight;
    out.push(
      "| " +
        [
        `[${r.name}](${r.png})`,
        m.reason ?? "-",
        agrees(r) ? `**${r.reason}**` : `**${r.reason}** (differs)`,
        r.handFound ? `${r.mpGesture} (${fmt(r.mpScore)})` : "-",
        r.shape ?? "-",
        r.handFound ? `${r.isPointing} (${r.isPointingLoose})` : "-",
        r.straightness ? r.straightness.map((v) => fmt(v)).join(" / ") : "-",
        r.pointer ? `${fmt(r.pointer.x, 3)}, ${fmt(r.pointer.y, 3)}${r.pointerAtEdge ? " EDGE" : ""}` : "-",
        r.fingerPx ?? "-",
        hl ? (hl.ok ? "ok" : hl.reason) : "-",
        hl ? `${(hl.coverage * 100).toFixed(1)}%` : "-",
        hl?.edges ?? "-",
        hl?.ragged ?? "-",
        hl ? hl.ms : "-",
        ].join(" | ") +
        " |",
    );
  }

  out.push("");
  out.push("## Summary by cause");
  out.push("");
  const groups = new Map();
  for (const r of results) groups.set(r.reason, [...(groups.get(r.reason) ?? []), r]);
  const order = ["no-hand", "not-pointing", "no-object", "background", "hand", "error", "ok"];
  for (const reason of order) {
    const list = groups.get(reason);
    if (!list) continue;
    out.push(`### ${reason}: ${list.length} of ${results.length}`);
    out.push("");
    out.push(CAUSES[reason]);
    out.push("");
    for (const r of list) out.push(`- ${r.name}${detail(r)}`);
    out.push("");
  }

  // Frames where the replay disagrees with what the phone recorded live.
  const differ = results.filter((r) => !agrees(r));
  if (differ.length) {
    out.push("## Replay disagrees with the app");
    out.push("");
    out.push(
      "Live the app uses smoothed landmarks, a vote over recent frames, and hysteresis, so these may point at timing/smoothing problems rather than the single-frame logic.",
    );
    out.push("");
    for (const r of differ) out.push(`- ${r.name}: app said **${r.meta.reason}**, replay says **${r.reason}**${detail(r)}`);
    out.push("");
  }

  // Would the highlight have worked if pointing had been detected?
  const missed = results.filter((r) => r.reason === "not-pointing" && r.highlight?.ok);
  if (missed.length) {
    out.push(`Note: ${missed.length} not-pointing frame(s) would have highlighted fine: ${missed.map((r) => r.name).join(", ")}.`);
    out.push("");
  }
  return out.join("\n");
}

// The app has no separate "no hand" reason; it records that as not-pointing.
function agrees(r) {
  const app = r.meta?.reason;
  return !app || app === r.reason || (app === "not-pointing" && r.reason === "no-hand");
}

function detail(r) {
  const bits = [];
  if (r.handFound) bits.push(`MP ${r.mpGesture} ${r.mpScore}`);
  if (r.reason === "not-pointing" && r.straightness) bits.push(`straightness ${r.straightness.join("/")}`);
  if (r.highlight && !r.highlight.ok) {
    bits.push(`coverage ${(r.highlight.coverage * 100).toFixed(1)}%`);
    if (r.highlight.edges !== undefined) bits.push(`edges ${r.highlight.edges}, ragged ${r.highlight.ragged}`);
  }
  if (r.pointerAtEdge) bits.push("pointer clamped at frame edge");
  if (r.fingerPx !== undefined && r.fingerPx < 15) bits.push(`finger only ${r.fingerPx}px (hand far away)`);
  if (r.error) bits.push(`error: ${r.error.split("\n")[0]}`);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
