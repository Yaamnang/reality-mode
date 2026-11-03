export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch("/api/health");
    return res.ok;
  } catch {
    return false;
  }
}

// Grabs the current video frame as a JPEG and uploads it to the backend.
// Reality Shift will use this to send snapshots to SAM and inpainting.
export async function sendFrame(video: HTMLVideoElement): Promise<unknown> {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")!.drawImage(video, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode frame"))), "image/jpeg", 0.9),
  );

  const form = new FormData();
  form.append("image", blob, "frame.jpg");

  const res = await fetch("/api/frame", { method: "POST", body: form });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  return res.json();
}

export interface RemoveResult {
  image: string; // data URL of the full frame with the object removed, same size as the frame sent
  label: string; // what Muse Spark called the object, e.g. "silver AirPods case"
  describe_ms: number;
  edit_ms: number;
  caption?: string; // Time Knob stages: what Muse Spark sees in the finished picture
  area?: { left: number; top: number; right: number; bottom: number }; // Time Knob stages: the part of the frame Meta drew (0..1)
}

// Asks the server to erase the object in `box` (0..1 of the frame) with Meta's models.
// Takes ~20 s (Muse Image), so the app shows a quick local fill in the meantime.
// `label`: the object's name if already known (from describeObject), which skips naming it again.
export async function removeObject(
  frame: Blob,
  box: { x: number; y: number; w: number; h: number },
  signal?: AbortSignal,
  label?: string,
): Promise<RemoveResult> {
  return editRequest("/api/remove", frame, box, {}, signal, label);
}

// Asks the server to change the object in `box` as `command` says ("make it gold") with Muse Image
// (~20 s). Returns the whole edited frame, like removeObject.
export async function transmuteObject(
  frame: Blob,
  box: { x: number; y: number; w: number; h: number },
  command: string,
  signal?: AbortSignal,
  label?: string,
): Promise<RemoveResult> {
  return editRequest("/api/transmute", frame, box, { command }, signal, label);
}

// Asks Muse Spark for `n` things that could replace the object in `box`, e.g. "small potted cactus".
export async function replacementIdeas(
  frame: Blob,
  box: { x: number; y: number; w: number; h: number },
  n: number,
  signal?: AbortSignal,
  label?: string,
): Promise<string[]> {
  const form = new FormData();
  form.append("image", frame, "frame.jpg");
  form.append("box", JSON.stringify({ x: box.x, y: box.y, w: box.w, h: box.h }));
  form.append("n", String(n));
  if (label) form.append("label", label);
  const res = await fetch("/api/ideas", { method: "POST", body: form, signal });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  return (await res.json()).ideas;
}

// ---------- The Time Knob ----------

export interface Opinion {
  agent: string;
  name: string; // "" = this agent couldn't tell
  kind: "natural" | "made";
  sure: number; // 0..100
}

export interface TimeMoment {
  label: string; // for the display, e.g. "Exploded view"
  look: string; // what Muse Image should draw
}

export interface Timeline {
  name: string;
  kind: "natural" | "made";
  about: string; // one sentence for the viewer, "" if the judge gave none
  sure: number; // how sure the judge is of the name, 0..100
  type: string; // "Fruit", "Electronics"..., "" if the judge gave none
  fate: string; // "Biodegradable", "Recyclable", "Non-biodegradable", "Toxic waste", "Never throw, burn", or ""
  past: TimeMoment[]; // nearest first
  future: TimeMoment[]; // nearest first
}

async function timeForm(url: string, frame: Blob, box: { x: number; y: number; w: number; h: number }, fields: Record<string, string>, signal?: AbortSignal) {
  const form = new FormData();
  form.append("image", frame, "frame.jpg");
  form.append("box", JSON.stringify({ x: box.x, y: box.y, w: box.w, h: box.h }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(url, { method: "POST", body: form, signal });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  return res.json();
}

// One Muse Spark agent says what the object in `box` is (~3 s).
export function timeLook(frame: Blob, box: { x: number; y: number; w: number; h: number }, agent: string, signal?: AbortSignal): Promise<Opinion> {
  return timeForm("/api/time/look", frame, box, { agent }, signal);
}

// The judge reads the agents' answers, decides what it is and writes its timeline (~5 s).
export function timeDecide(frame: Blob, box: { x: number; y: number; w: number; h: number }, opinions: Opinion[], signal?: AbortSignal): Promise<Timeline> {
  return timeForm("/api/time/decide", frame, box, { opinions: JSON.stringify(opinions) }, signal);
}

// Muse Image draws one moment of the object's timeline (~30 s). Returns the whole frame.
export function timeStage(frame: Blob, box: { x: number; y: number; w: number; h: number }, label: string, look: string, title: string, signal?: AbortSignal): Promise<RemoveResult> {
  return editRequest("/api/time/stage", frame, box, { look, title }, signal, label);
}

async function editRequest(
  url: string,
  frame: Blob,
  box: { x: number; y: number; w: number; h: number },
  fields: Record<string, string>,
  signal?: AbortSignal,
  label?: string,
): Promise<RemoveResult> {
  const form = new FormData();
  form.append("image", frame, "frame.jpg");
  form.append("box", JSON.stringify({ x: box.x, y: box.y, w: box.w, h: box.h }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (label) form.append("label", label);
  const res = await fetch(url, { method: "POST", body: form, signal });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.detail, () => "");
    throw new Error(`server returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

// Asks the server to name the object in `box` with Muse Spark, e.g. "silver AirPods case" (~3 s).
export async function describeObject(frame: Blob, box: { x: number; y: number; w: number; h: number }): Promise<string> {
  const form = new FormData();
  form.append("image", frame, "frame.jpg");
  form.append("box", JSON.stringify({ x: box.x, y: box.y, w: box.w, h: box.h }));
  const res = await fetch("/api/describe", { method: "POST", body: form });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  return (await res.json()).label;
}

export interface OutlinedObject {
  box: { x: number; y: number; w: number; h: number }; // 0..1 of the picture
  mask: string; // PNG data URL, white where the object is, box-sized
}

// SAM 3.1 outlines what a short phrase names in one picture.
export async function outlineObject(picture: Blob, phrase: string, signal?: AbortSignal): Promise<OutlinedObject[]> {
  const form = new FormData();
  form.append("image", picture, "view.jpg");
  form.append("phrase", phrase);
  const res = await fetch("/api/outline", { method: "POST", body: form, signal });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.detail, () => "");
    throw new Error(`server returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()).objects;
}
