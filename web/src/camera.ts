let currentStream: MediaStream | null = null;

export const isPhone = /Android|iPhone|iPad/i.test(navigator.userAgent);

// Counts new camera frames. A live video's currentTime moves between frames too, so comparing it
// ran the hand model about twice per frame on a 60 Hz screen.
const HAS_FRAME_CALLBACK = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
let frameCount = 0;
let watching = false;
let lastTime = -1;

function watchFrames(video: HTMLVideoElement) {
  if (watching || !HAS_FRAME_CALLBACK) return;
  watching = true;
  const tick = () => {
    frameCount++;
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
}

export function cameraFrame(video: HTMLVideoElement) {
  if (!HAS_FRAME_CALLBACK && video.currentTime !== lastTime) {
    lastTime = video.currentTime;
    frameCount++;
  }
  return frameCount;
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export function stopCamera(video: HTMLVideoElement) {
  currentStream?.getTracks().forEach((track) => track.stop());
  currentStream = null;
  video.srcObject = null;
}

export async function startCamera(video: HTMLVideoElement, deviceId?: string) {
  currentStream?.getTracks().forEach((track) => track.stop());

  currentStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // On phones this picks the back camera when no device is chosen.
      facingMode: deviceId ? undefined : "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      // A phone can't run the hand model 60 times a second, so a faster camera only adds work.
      frameRate: { ideal: isPhone ? 30 : 60 },
    },
  });

  video.srcObject = currentStream;
  await video.play();
  watchFrames(video);

  // "environment" = back camera. Laptops usually report "user" or nothing.
  return currentStream.getVideoTracks()[0].getSettings().facingMode;
}
