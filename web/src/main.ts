import { startCamera, stopCamera, listCameras } from "./camera";
import { checkHealth, sendFrame } from "./api";
import { initGestures, detectHands, drawHands, onGesture, onTrack, type Hand } from "./gestures";
import {
  initRealityShift,
  updateRealityShift,
  drawRealityShift,
  tapRealityShift,
  resetRealityShift,
  removeItem,
  setCapture,
  eraseSelected,
  transmuteSelected,
  selectedItem,
  trayItems,
} from "./realityShift";
import { drawVirtual, hasErase, anyFillFailed } from "./virtualView";
import { cutOutHands } from "./handLayer";
import { sceneMotion } from "./sceneTracker";
import { setupPhoneDialog } from "./phone";
import { remoteLog, remoteFrame } from "./remoteLog";
import { cameraFrame, isPhone } from "./camera";
import { trackerStats } from "./sceneTracker";
import { pinStats } from "./pinTracker";
import { initTimeKnob, enableTimeKnob, resetTimeKnob, updateTimeKnob, drawTimeKnob, tapTimeKnob, stepTimeKnob } from "./timeKnob";

const stage = document.querySelector<HTMLElement>("#stage")!;
const video = document.querySelector<HTMLVideoElement>("#video")!;
const overlay = document.querySelector<HTMLCanvasElement>("#overlay")!;
const hint = document.querySelector<HTMLDivElement>("#hint")!;
const cameraSelect = document.querySelector<HTMLSelectElement>("#camera-select")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start-btn")!;
const snapshotBtn = document.querySelector<HTMLButtonElement>("#snapshot-btn")!;
const fpsChip = document.querySelector<HTMLSpanElement>("#fps")!;
const gestureChip = document.querySelector<HTMLDivElement>("#gesture-chip")!;
const serverStatus = document.querySelector<HTMLSpanElement>("#server-status")!;
const logBox = document.querySelector<HTMLPreElement>("#log")!;
const handsToggle = document.querySelector<HTMLInputElement>("#hands-toggle")!;
const mirrorToggle = document.querySelector<HTMLInputElement>("#mirror-toggle")!;
const gestureReadout = document.querySelector<HTMLParagraphElement>("#gesture-readout")!;
const shiftToggle = document.querySelector<HTMLInputElement>("#shift-toggle")!;
const shiftStatus = document.querySelector<HTMLParagraphElement>("#shift-status")!;
const debugToggle = document.querySelector<HTMLInputElement>("#debug-toggle")!;
const views = document.querySelector<HTMLElement>("#views")!;
const layout = document.querySelector<HTMLElement>(".layout")!;
const virtualView = document.querySelector<HTMLDivElement>("#virtual-view")!;
const virtualCanvas = document.querySelector<HTMLCanvasElement>("#virtual")!;
const fillChip = document.querySelector<HTMLDivElement>("#fill-chip")!;
const eraseBtn = document.querySelector<HTMLButtonElement>("#erase-btn")!;
const resetBtn = document.querySelector<HTMLButtonElement>("#reset-btn")!;
const removeBtn = document.querySelector<HTMLButtonElement>("#remove-btn")!;
const transmuteForm = document.querySelector<HTMLFormElement>("#transmute-form")!;
const transmuteInput = document.querySelector<HTMLInputElement>("#transmute-input")!;
const transmuteBtn = document.querySelector<HTMLButtonElement>("#transmute-btn")!;
const tabs = document.querySelectorAll<HTMLButtonElement>("#mode-tabs button");
const shiftCard = shiftToggle.closest<HTMLElement>(".card")!;
const knobCard = document.querySelector<HTMLElement>("#knob-card")!;
const knobStatus = document.querySelector<HTMLParagraphElement>("#knob-status")!;
const knobReset = document.querySelector<HTMLButtonElement>("#knob-reset")!;
const ctx = overlay.getContext("2d")!;

let handsReady = false;
let shiftReady = false;
let hands: Hand[] = [];
// Front camera/webcam faces the user; a phone's back camera faces away. Affects Left/Right labels.
let facesUser = true;

function log(message: string) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  logBox.textContent = `${time}  ${message}\n` + logBox.textContent.slice(0, 6000);
  remoteLog(message);
}

// Errors on the phone are otherwise invisible, so send them to the terminal too.
window.addEventListener("error", (e) => log(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => log(`error: ${e.reason?.message ?? e.reason}`));
document.addEventListener("visibilitychange", () => {
  if (video.srcObject) log(document.hidden ? "app went to background (camera paused)" : "app back in foreground");
});

async function refreshCameraList() {
  const cameras = await listCameras();
  cameraSelect.innerHTML = "";
  cameras.forEach((camera, i) => {
    cameraSelect.append(new Option(camera.label || `Camera ${i + 1}`, camera.deviceId));
  });
}

async function cameraOn() {
  try {
    const facing = await startCamera(video, cameraSelect.value || undefined);
    facesUser = facing !== "environment";
    // Device labels are only visible after permission is granted, so list again.
    const selected = cameraSelect.value;
    await refreshCameraList();
    if (selected) cameraSelect.value = selected;

    // Mirror the front camera like a selfie view, but not a phone's back camera.
    mirrorToggle.checked = facesUser;
    applyMirror();

    // Fires if the camera stops on its own, e.g. unplugged or taken by another app.
    (video.srcObject as MediaStream).getVideoTracks()[0].addEventListener("ended", () => {
      log("camera ended unexpectedly");
      cameraOff();
    });

    hint.hidden = true;
    snapshotBtn.disabled = false;
    startBtn.textContent = "Stop camera";
    const which = facing === "environment" ? "back camera" : facing === "user" ? "front camera" : "webcam";
    log(`camera started: ${which}, ${video.videoWidth}x${video.videoHeight}`);
  } catch (err) {
    log(`camera error: ${(err as Error).message}`);
  }
}

function cameraOff() {
  stopCamera(video);
  hint.hidden = false;
  snapshotBtn.disabled = true;
  gestureChip.hidden = true;
  fpsChip.textContent = "– fps";
  startBtn.textContent = "Start camera";
  resetRealityShift();
  resetTimeKnob();
  log("camera stopped");
}

startBtn.addEventListener("click", () => (video.srcObject ? cameraOff() : cameraOn()));

// Switching camera while running restarts it with the new one.
cameraSelect.addEventListener("change", () => {
  if (video.srcObject) cameraOn();
});

snapshotBtn.addEventListener("click", async () => {
  try {
    const result = await sendFrame(video);
    log(`server got frame: ${JSON.stringify(result)}`);
  } catch (err) {
    log(`send failed: ${(err as Error).message}`);
  }
});

// Hand tracking. The model (~8 MB) loads the first time the switch is turned on.
async function enableHands() {
  if (!handsToggle.checked) {
    gestureReadout.textContent = "Off";
    gestureChip.hidden = true;
    return;
  }
  if (handsReady) return;
  gestureReadout.textContent = "Loading model…";
  try {
    const delegate = await initGestures();
    handsReady = true;
    log(`hand tracking ready, running on this device's ${delegate}`);
  } catch (err) {
    handsToggle.checked = false;
    gestureReadout.textContent = "Failed to load";
    log(`hand tracking error: ${(err as Error).message}`);
  }
}
handsToggle.addEventListener("change", enableHands);

onGesture((hand, previous) => {
  log(`${hand.side} hand: ${previous} → ${hand.gesture}`);
});
onTrack((side, event) => log(`${side} hand ${event}`));

// The object highlighter is shared by Reality Shift and the Time Knob; it loads once.
let highlighter: Promise<"GPU" | "CPU"> | null = null;
function loadHighlighter() {
  highlighter ??= initRealityShift(log).catch((err) => {
    highlighter = null;
    throw err;
  });
  return highlighter;
}

const SHIFT_HELP =
  "Right hand: point and hold still to lock or select · open hand 3 s to transmute, then twist it to switch. Left hand: fist 2 s to grab, open to drop · thumbs down 1 s to erase. Both fists 2 s: put the selected object back";

// Reality Shift: point to choose an object, keep pointing to lock, thumbs down to erase, wave to reset.
// Needs hand tracking for pointing, so turning it on turns hand tracking on too.
shiftToggle.addEventListener("change", async () => {
  if (!shiftToggle.checked) {
    resetRealityShift();
    shiftStatus.textContent = "Off";
    return;
  }
  if (!handsToggle.checked) {
    handsToggle.checked = true;
    enableHands();
  }
  if (shiftReady) {
    shiftStatus.textContent = SHIFT_HELP;
    return;
  }
  shiftStatus.textContent = "Loading model…";
  try {
    const delegate = await loadHighlighter();
    shiftReady = true;
    shiftStatus.textContent = SHIFT_HELP;
    log(`object highlighter ready, running on this device's ${delegate}`);
  } catch (err) {
    shiftToggle.checked = false;
    shiftStatus.textContent = "Failed to load";
    log(`object highlighter error: ${(err as Error).message}`);
  }
});

// Modes: one tab each, showing that mode's card. Opening one turns the other off. The Time Knob runs
// whenever its tab is open. The address remembers the tab (#time-knob), so a reload opens the same one.
type Mode = "shift" | "knob";
let mode: Mode = "shift";

function setMode(next: Mode) {
  mode = next;
  tabs.forEach((tab) => {
    const active = tab.dataset.mode === next;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  shiftCard.hidden = next !== "shift";
  knobCard.hidden = next !== "knob";
  if (next !== "shift" && shiftToggle.checked) {
    shiftToggle.checked = false;
    shiftToggle.dispatchEvent(new Event("change"));
  }
  enableTimeKnob(false);
  if (next === "knob") startKnobMode();
  history.replaceState(null, "", next === "knob" ? "#time-knob" : location.pathname + location.search);
}

// The Time Knob needs hand tracking and the object highlighter.
async function startKnobMode() {
  handsToggle.checked = true;
  enableHands();
  knobStatus.textContent = "Loading model…";
  try {
    await loadHighlighter();
    if (mode === "knob") enableTimeKnob(true);
  } catch (err) {
    knobStatus.textContent = "Failed to load";
    log(`object highlighter error: ${(err as Error).message}`);
  }
}

tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    if (tab.dataset.mode === mode) return;
    setMode(tab.dataset.mode as Mode);
    log(`mode: ${tab.textContent}`);
  }),
);

initTimeKnob(log, (text) => (knobStatus.textContent = text));
knobReset.addEventListener("click", resetTimeKnob);
// Backup for the twist: arrow keys move the knob.
window.addEventListener("keydown", (e) => {
  if (mode !== "knob" || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  e.preventDefault();
  stepTimeKnob(e.key === "ArrowLeft" ? -1 : 1);
});
setMode(location.hash === "#time-knob" ? "knob" : "shift");

// Debug capture: when pointing doesn't work, send that camera frame to the laptop (debug-frames/).
// On by default while we're tuning; frames stay on the laptop and are gitignored.
function applyDebug() {
  if (!debugToggle.checked) {
    setCapture(null);
    log("debug frames off");
    return;
  }
  setCapture((reason, hand, extra) => {
    remoteFrame(video, {
      reason,
      gesture: hand.gesture,
      rawGesture: hand.rawGesture,
      mpGesture: hand.mpGesture,
      mpScore: hand.mpScore,
      pointer: hand.pointer,
      facesUser,
      coverage: extra.coverage,
      edges: extra.edges,
      ragged: extra.ragged,
      contrast: extra.contrast,
    });
  });
  log("debug frames on: failed pointing frames are saved on the laptop");
}
debugToggle.addEventListener("change", applyDebug);
// Each saved frame stalls a phone for a moment, so it's off there unless switched on.
if (isPhone) debugToggle.checked = false;
// A public build has nowhere to save them.
if (import.meta.env.PROD) {
  debugToggle.checked = false;
  debugToggle.closest("label")!.hidden = true;
}
applyDebug();

// Tap the video to select an object directly.
// Converts the tap to 0..1 coordinates of the raw frame.
overlay.addEventListener("click", (e) => {
  if (!video.srcObject || !(mode !== "shift" || (shiftToggle.checked && shiftReady))) return;
  const rect = overlay.getBoundingClientRect();
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const shownW = video.videoWidth * scale;
  const shownH = video.videoHeight * scale;
  let x = (e.clientX - rect.left - (rect.width - shownW) / 2) / shownW;
  const y = (e.clientY - rect.top - (rect.height - shownH) / 2) / shownH;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  if (mirrorToggle.checked) x = 1 - x;
  if (mode === "knob") tapTimeKnob(video, { x, y });
  else tapRealityShift(video, { x, y });
});

function applyMirror() {
  video.classList.toggle("mirrored", mirrorToggle.checked);
}
mirrorToggle.addEventListener("change", applyMirror);
applyMirror();

// Keep the stage and overlay the same shape as the video, e.g. when a phone rotates.
function fitToVideo() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || (overlay.width === w && overlay.height === h)) return;
  overlay.width = w;
  overlay.height = h;
  stage.style.aspectRatio = `${w} / ${h}`;
  virtualView.style.aspectRatio = `${w} / ${h}`;
}

// Split view: once an object is erased, show Real | Virtual side by side.

function updateVirtual() {
  const split = hasErase();
  views.classList.toggle("split", split);
  layout.classList.toggle("split", split);
  virtualView.hidden = !split;
  if (split) {
    const front = cutOutHands(video, hands, video.videoWidth, video.videoHeight);
    drawVirtual(virtualCanvas, video, mirrorToggle.checked, sceneMotion(), performance.now(), selectedItem()?.edit ?? null, front);
    // The ripples show that Meta is working; only say something if an AI fill failed.
    const failed = anyFillFailed();
    fillChip.hidden = !failed;
    if (failed) fillChip.textContent = "Meta edit unavailable, showing a quick version";
  }
  const sel = selectedItem();
  eraseBtn.disabled = !sel || sel.state === "erased";
  resetBtn.disabled = trayItems().length === 0;
  removeBtn.disabled = !sel;
  transmuteBtn.disabled = !sel || sel.state === "erased" || sel.state === "stored";
}

eraseBtn.addEventListener("click", () => eraseSelected(video, "button"));
transmuteForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (transmuteSelected(video, transmuteInput.value, "typed")) transmuteInput.value = "";
});
removeBtn.addEventListener("click", () => {
  const sel = selectedItem();
  if (sel) removeItem(sel, "button");
});
resetBtn.addEventListener("click", () => {
  resetRealityShift();
  log("reset (button)");
});

// Render loop: the overlay canvas is where hands, predicted arcs and moved furniture are drawn.
let frames = 0;
let lastFpsTime = performance.now();
// For the speed line in the log: where each screen frame's time goes.
const SPEED_LOG_MS = 5000;
let speedFrom = performance.now();
let speedScreen = 0;
let speedCamera = 0;
let speedHandRuns = 0;
let speedHandMs = 0;
let speedOtherMs = 0;

function logSpeed(now: number) {
  speedScreen++;
  if (now - speedFrom < SPEED_LOG_MS) return;
  const s = (now - speedFrom) / 1000;
  const asked = (video.srcObject as MediaStream).getVideoTracks()[0]?.getSettings();
  const runs = Math.max(speedHandRuns, 1);
  log(
    `speed: ${(speedScreen / s).toFixed(0)} fps on screen, camera ${(speedCamera / s).toFixed(0)}/s (${video.videoWidth}x${video.videoHeight}, set to ${asked?.frameRate?.toFixed(0) ?? "?"}), ` +
      `hand model ${(speedHandRuns / s).toFixed(0)}/s at ${(speedHandMs / runs).toFixed(0)} ms, the rest ${(speedOtherMs / speedScreen).toFixed(0)} ms per screen frame (room tracker ${trackerStats().ms.toFixed(0)} ms, pin ${pinStats().ms.toFixed(0)} ms)`,
  );
  speedFrom = now;
  speedScreen = speedCamera = speedHandRuns = speedHandMs = speedOtherMs = 0;
}

let lastSpeedFrame = -1;

function render(now: number) {
  const started = performance.now();
  let handMs = 0;
  fitToVideo();
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (video.srcObject) {
    if (handsToggle.checked && handsReady) {
      const before = performance.now();
      const ran = cameraFrame(video) !== lastSpeedFrame;
      hands = detectHands(video, now, facesUser);
      if (ran) {
        handMs = performance.now() - before;
        speedHandMs += handMs;
        speedHandRuns++;
      }
    } else {
      hands = [];
    }

    if (shiftToggle.checked && shiftReady) {
      updateRealityShift(video, hands, now, mirrorToggle.checked);
      drawRealityShift(ctx, mirrorToggle.checked, now);
    }
    updateVirtual();
    if (mode === "knob") {
      updateTimeKnob(video, hands, now, mirrorToggle.checked);
      drawTimeKnob(ctx, mirrorToggle.checked, now);
    }

    if (handsToggle.checked && handsReady) {
      // The Time Knob's hand is shown by its magic circle.
      if (mode === "shift") drawHands(ctx, hands, mirrorToggle.checked);
      const summary = hands.map((h) => `${h.side} · ${h.gesture.replace("_", " ")}`).join("   ");
      // Only when it changes: writing to the page every frame makes the browser lay it out again.
      const readout = summary || "No hands in view";
      if (gestureReadout.textContent !== readout) gestureReadout.textContent = readout;
      if (gestureChip.textContent !== summary) gestureChip.textContent = summary;
      gestureChip.hidden = !summary;
    }

    frames++;
    if (now - lastFpsTime >= 1000) {
      fpsChip.textContent = `${frames} fps`;
      frames = 0;
      lastFpsTime = now;
    }
    if (cameraFrame(video) !== lastSpeedFrame) {
      lastSpeedFrame = cameraFrame(video);
      speedCamera++;
    }
    speedOtherMs += performance.now() - started - handMs;
    logSpeed(now);
  }

  requestAnimationFrame(render);
}

async function pollServer() {
  const ok = await checkHealth();
  serverStatus.textContent = ok ? "Server online" : "Server offline";
  serverStatus.className = `status ${ok ? "ok" : "down"}`;
}

setupPhoneDialog();
refreshCameraList();
pollServer();
setInterval(pollServer, 5000);
requestAnimationFrame(render);
