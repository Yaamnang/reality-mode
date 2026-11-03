const device = /Android|iPhone|iPad/i.test(navigator.userAgent) ? "phone" : "laptop";

// Sends a log line to the `npm run dev` terminal (see terminalLog in vite.config.ts).
// Only works in dev mode; does nothing in a production build.
export function remoteLog(message: string) {
  import.meta.hot?.send("godmode:log", { device, message });
}

let frameCanvas: HTMLCanvasElement | null = null;

// Sends the current camera frame (raw, no overlay) plus details about it to the laptop, which
// saves them in godmode/debug-frames/ for the replay tool (tools/replay).
export function remoteFrame(video: HTMLVideoElement, details: Record<string, unknown>) {
  if (!import.meta.hot || !video.videoWidth) return;
  frameCanvas ??= document.createElement("canvas");
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  frameCanvas.getContext("2d")!.drawImage(video, 0, 0);
  const image = frameCanvas.toDataURL("image/jpeg", 0.85);
  import.meta.hot.send("godmode:frame", {
    device,
    image,
    details: { ...details, time: new Date().toISOString(), width: video.videoWidth, height: video.videoHeight },
  });
}
