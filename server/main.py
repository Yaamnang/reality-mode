"""GODMODE backend: runs the heavier AI models (SAM, inpainting, depth) for the web app."""

import io
import json
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

import outline as outline_tools
import remove as remove_tools
import spend
import timeknob

app = FastAPI(title="GODMODE server")

# On a public link anyone can spend the Meta credit, so MAX_SPEND (USD, set by render.yaml) stops paid
# calls once this run of the server has used that much. A server that restarts starts counting again.
# Not set = no limits, for running on your own laptop.
MAX_SPEND = float(os.environ.get("MAX_SPEND") or 0)
MAX_PER_MINUTE = 60  # requests from one address; locking one object takes about 10
MAX_BODY = 8_000_000  # bytes; a camera frame is well under 1 MB
_recent: dict[str, list[float]] = {}
_recent_lock = threading.Lock()


def _too_many(address: str) -> bool:
    now = time.monotonic()
    with _recent_lock:
        if len(_recent) > 5000:
            _recent.clear()
        times = [t for t in _recent.get(address, []) if now - t < 60]
        times.append(now)
        _recent[address] = times
        return len(times) > MAX_PER_MINUTE


@app.middleware("http")
async def public_limits(request: Request, call_next):
    if MAX_SPEND and request.method == "POST" and request.url.path.startswith("/api/"):
        if int(request.headers.get("content-length") or 0) > MAX_BODY:
            return JSONResponse({"detail": "that picture is too big"}, status_code=413)
        if spend.this_run() >= MAX_SPEND:
            return JSONResponse({"detail": "this demo has used up its budget for now"}, status_code=429)
        address = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "")).split(",")[0].strip()
        if _too_many(address):
            return JSONResponse({"detail": "too many requests, wait a minute"}, status_code=429)
    return await call_next(request)


# The Vite dev server proxies /api, but allow direct calls too (e.g. from a phone on the same Wi-Fi).
# On Render the website comes from this same server, so nothing else needs to call it.
_site = os.environ.get("RENDER_EXTERNAL_URL")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[_site] if _site else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/spend")
def spend_summary():
    """Estimated Meta credit left (there's no balance API; see spend.py)."""
    if MAX_SPEND:
        raise HTTPException(status_code=404)  # not for a public link
    return spend.summary()


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/frame")
async def receive_frame(image: UploadFile = File(...)):
    """Receives one camera frame. Later: run SAM / inpainting / depth on it."""
    data = await image.read()
    try:
        frame = Image.open(io.BytesIO(data))
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="not an image")

    return {
        "width": frame.width,
        "height": frame.height,
        "bytes": len(data),
    }


@app.post("/api/remove")
def remove(
    image: UploadFile | None = File(None),
    box: str | None = Form(None),
    label: str | None = Form(None),
):
    """Erases the object in `box` from the frame with Meta's models (~20 s, ~$0.01).

    Plain `def` (not async) so the slow Meta calls run in a worker thread and
    /api/health keeps answering meanwhile. Fields are optional here so missing
    ones give our own 400 instead of FastAPI's 422.
    """
    if image is None:
        raise HTTPException(status_code=400, detail="missing image")
    if box is None:
        raise HTTPException(status_code=400, detail="missing box")
    try:
        parsed = remove_tools.parse_box(box)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        frame = Image.open(io.BytesIO(image.file.read())).convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="image is not a readable picture")
    try:
        return remove_tools.remove_object(frame, parsed, label)
    except remove_tools.MetaError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/transmute")
def transmute(
    image: UploadFile | None = File(None),
    box: str | None = Form(None),
    command: str | None = Form(None),
    label: str | None = Form(None),
):
    """Changes the object in `box` as `command` says ("make it gold") with Muse Image (~20 s, ~$0.01).
    Returns the whole edited frame, like /api/remove; the app pastes back only the object's area."""
    command = (command or "").strip()
    if not command:
        raise HTTPException(status_code=400, detail="missing command")
    if len(command) > 300:
        raise HTTPException(status_code=400, detail="command is too long")
    frame, parsed = read_frame_and_box(image, box)
    try:
        return remove_tools.transmute_object(frame, parsed, label, command)
    except remove_tools.MetaError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ideas")
def replacement_ideas(
    image: UploadFile | None = File(None),
    box: str | None = Form(None),
    label: str | None = Form(None),
    n: int = Form(4),
):
    """Muse Spark suggests `n` things that could replace the object in `box` (~3 s, a fraction of a
    cent), for the reality dial. Never fails: falls back to a fixed list."""
    frame, parsed = read_frame_and_box(image, box)
    return {"ideas": remove_tools.ideas(remove_tools.downscale(frame), parsed, label, max(1, min(n, 6)))}


@app.post("/api/time/look")
def time_look(
    image: UploadFile | None = File(None),
    box: str | None = Form(None),
    agent: str = Form("closeup"),
):
    """One Muse Spark agent says what the object in `box` is (~3 s). Never fails."""
    if agent not in timeknob.AGENTS:
        raise HTTPException(status_code=400, detail="unknown agent")
    frame, parsed = read_frame_and_box(image, box)
    return timeknob.look(remove_tools.downscale(frame), parsed, agent)


@app.post("/api/time/decide")
def time_decide(
    image: UploadFile | None = File(None),
    box: str | None = Form(None),
    opinions: str = Form("[]"),
):
    """The judge reads the agents' opinions, decides what it is and writes its timeline (~5 s). Never fails."""
    frame, parsed = read_frame_and_box(image, box)
    try:
        heard = json.loads(opinions)
    except ValueError:
        raise HTTPException(status_code=400, detail="opinions must be JSON")
    return timeknob.decide(remove_tools.downscale(frame), parsed, heard if isinstance(heard, list) else [])


@app.post("/api/time/stage")
def time_stage(
    image: UploadFile | None = File(None),
    box: str | None = Form(None),
    label: str | None = Form(None),
    look: str | None = Form(None),
    title: str | None = Form(None),
):
    """Muse Image draws one stage of the object's timeline (~20 s, ~$0.01). Returns the whole frame."""
    look = (look or "").strip()
    if not look:
        raise HTTPException(status_code=400, detail="missing look")
    frame, parsed = read_frame_and_box(image, box)
    try:
        return timeknob.draw_stage(frame, parsed, label or "object", look[:400], (title or "earlier form")[:60])
    except remove_tools.MetaError as e:
        raise HTTPException(status_code=502, detail=str(e))


def read_picture(image: UploadFile) -> Image.Image:
    try:
        return Image.open(io.BytesIO(image.file.read())).convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="image is not a readable picture")


@app.post("/api/outline")
def outline_object(image: UploadFile | None = File(None), phrase: str = Form("")):
    """SAM 3.1 outlines what a short phrase names in one picture (~$0.0025)."""
    phrase = phrase.strip()
    if image is None or not phrase or len(phrase) > 60:
        raise HTTPException(status_code=400, detail="send an image and a short phrase")
    picture = read_picture(image)
    try:
        return {"objects": outline_tools.outline(picture, phrase)}
    except remove_tools.MetaError as e:
        raise HTTPException(status_code=502, detail=str(e))



def read_frame_and_box(image: UploadFile | None, box: str | None):
    """Checks the uploaded frame and box; raises a 400 before any paid call."""
    if image is None:
        raise HTTPException(status_code=400, detail="missing image")
    if box is None:
        raise HTTPException(status_code=400, detail="missing box")
    try:
        parsed = remove_tools.parse_box(box)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        frame = Image.open(io.BytesIO(image.file.read())).convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="image is not a readable picture")
    return frame, parsed


@app.post("/api/describe")
def describe_object(
    image: UploadFile | None = File(None),
    box: str | None = Form(None),
):
    """Names the object in `box` with Muse Spark (~3 s, a fraction of a cent), so the object tray
    can show it right after locking. The name is sent back with /api/remove to skip naming there.
    Naming never fails the request: it falls back to "object"."""
    if image is None:
        raise HTTPException(status_code=400, detail="missing image")
    if box is None:
        raise HTTPException(status_code=400, detail="missing box")
    try:
        parsed = remove_tools.parse_box(box)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        frame = Image.open(io.BytesIO(image.file.read())).convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="image is not a readable picture")
    return {"label": remove_tools.describe(remove_tools.downscale(frame), parsed)}


# On Render, this same server serves the built website. Last, so it can't shadow /api.
_web = Path(__file__).resolve().parent.parent / "web" / "dist"
if _web.exists():
    app.mount("/", StaticFiles(directory=_web, html=True), name="web")
