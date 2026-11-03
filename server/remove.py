"""Erase one object from a camera frame with Meta's models.

Muse Spark names the object (so the edit prompt can say what to remove),
then Muse Image repaints the frame without it. The result is resized back to
the frame's exact size so the browser can lay it pixel-for-pixel over the video.
"""

import base64
import functools
import io
import json
import re
import time

from openai import APIConnectionError, APIStatusError
from PIL import Image, ImageChops, ImageDraw, ImageStat

import meta
import spend

# Long side sent to Meta. Smaller = cheaper and faster; 1024 still looks fine on a phone.
MAX_SIDE = 1024
# Extra margin around the box for the naming crop, as a fraction of the box size per side.
CROP_PAD = 0.3
# What the browser gets back. JPEG: ~160 KB vs ~880 KB as PNG for a 720x1280 frame.
OUT_QUALITY = 90


@functools.cache
def client():
    """One shared Meta client: building it takes ~150 ms, and it is safe to share between threads."""
    return meta.client()


class MetaError(Exception):
    """A Meta API call failed. The message is short and safe to show (no key)."""


def parse_box(raw: str) -> dict:
    """Checks the {"x","y","w","h"} box (0..1 of the frame) and clips it to the frame."""
    try:
        box = json.loads(raw)
        x, y, w, h = (float(box[k]) for k in ("x", "y", "w", "h"))
    except (ValueError, TypeError, KeyError):
        raise ValueError('box must be JSON like {"x":0.4,"y":0.4,"w":0.2,"h":0.1}')
    if w <= 0 or h <= 0:
        raise ValueError("box w and h must be > 0")
    # Clip to the frame: a box drawn slightly past the edge is still usable.
    x0, y0 = max(0.0, x), max(0.0, y)
    x1, y1 = min(1.0, x + w), min(1.0, y + h)
    if x1 - x0 < 0.005 or y1 - y0 < 0.005:
        raise ValueError("box is outside the frame or too small")
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def downscale(frame: Image.Image) -> Image.Image:
    """Shrinks the frame so its long side is at most MAX_SIDE, keeping the shape."""
    scale = MAX_SIDE / max(frame.size)
    if scale >= 1:
        return frame
    size = (round(frame.width * scale), round(frame.height * scale))
    return frame.resize(size, Image.LANCZOS)


def where(box: dict) -> str:
    """Rough position words ("lower left") so the edit prompt can't pick a look-alike elsewhere."""
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    row = "upper" if cy < 0.35 else "lower" if cy > 0.65 else "middle"
    col = "left" if cx < 0.35 else "right" if cx > 0.65 else "center"
    return "center" if (row, col) == ("middle", "center") else f"{row} {col}"


def data_url(img: Image.Image, quality: int = 90) -> str:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def no_tibet(value):
    """The user's rule: a Buddhist item is never called Tibetan. Works on text, or on every text inside
    a model's JSON answer, so it doesn't depend on the model obeying."""
    if isinstance(value, dict):
        return {k: no_tibet(v) for k, v in value.items()}
    if isinstance(value, list):
        return [no_tibet(v) for v in value]
    if not isinstance(value, str):
        return value
    text = re.sub(r"\b(?:from|of|in)\s+tibet\b", "", value, flags=re.I)
    text = re.sub(r"\btibetan\b", lambda m: "Buddhist" if m.group()[0].isupper() else "buddhist", text, flags=re.I)
    text = re.sub(r"\btibet\b", "the Himalayas", text, flags=re.I)
    text = re.sub(r"\b(buddhist)(?:[\s-]+buddhist)+\b", r"\1", text, flags=re.I)
    return re.sub(r"[ \t]{2,}", " ", text).replace(" .", ".").strip()


def clean_label(text: str) -> str:
    """Keeps the first line, drops quotes/punctuation and a leading "a"/"the", max 6 words."""
    line = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    line = re.sub(r"[^\w\s'-]", " ", line)
    words = line.split()
    if words and words[0].lower() in ("a", "an", "the"):
        words = words[1:]
    return no_tibet(" ".join(words[:6]))


def describe(frame: Image.Image, box: dict) -> str:
    """Asks Muse Spark for a short name of the object in the box. Returns "object" if that fails,
    because a vague name still lets the edit work (the position words help)."""
    W, H = frame.size
    px, py = box["w"] * CROP_PAD, box["h"] * CROP_PAD
    crop = frame.crop((
        round(max(0, box["x"] - px) * W),
        round(max(0, box["y"] - py) * H),
        round(min(1, box["x"] + box["w"] + px) * W),
        round(min(1, box["y"] + box["h"] + py) * H),
    ))
    # The whole scene, small, with the box outlined, so tiny crops still make sense.
    scene = frame.copy()
    scene.thumbnail((512, 512))
    sx, sy = scene.width, scene.height
    ImageDraw.Draw(scene).rectangle(
        (box["x"] * sx, box["y"] * sy, (box["x"] + box["w"]) * sx, (box["y"] + box["h"]) * sy),
        outline=(255, 0, 0), width=3,
    )
    prompt = (
        "The first image is a close-up crop of one object. The second image is the whole scene "
        "with that object outlined in red. Name the object in 2 to 6 words: its color and what it is, "
        'for example "silver AirPods case" or "blue water bottle". Ignore any hands. '
        "Reply with only the name."
    )
    try:
        # 30 s and one retry: naming the second object while Meta is busy erasing the first timed out.
        r = client().with_options(timeout=30, max_retries=1).responses.create(
            model="muse-spark-1.3",
            input=[{"role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": data_url(crop)},
                {"type": "input_image", "image_url": data_url(scene, 80)},
            ]}],
            # Minimal thinking, plenty of room: on an ambiguous crop (a phone with a tube touching it)
            # "low" effort thought past 1024 tokens and returned an empty name.
            reasoning={"effort": "minimal"},
            max_output_tokens=3000,
        )
        spend.add(spend.spark_cost(r.usage), "Muse Spark naming")
        label = clean_label(r.output_text)
        if not label:
            print(f"[remove] naming came back empty (status {r.status}), using 'object'", flush=True)
        return label or "object"
    except Exception as e:  # naming is a nice-to-have: never fail the request over it
        print(f"[remove] naming failed, using 'object': {type(e).__name__}: {str(e)[:120]}", flush=True)
        return "object"


# Used when Muse Spark's ideas can't be read.
FALLBACK_IDEAS = ["small potted cactus", "vintage brass pocket watch", "red apple", "glass snow globe"]


def ideas(frame: Image.Image, box: dict, label: str | None, n: int) -> list[str]:
    """Asks Muse Spark for `n` different things that could replace the object in the box (same
    spot, about the same size, believable there). Never fails: falls back to a fixed list."""
    W, H = frame.size
    scene = frame.copy()
    scene.thumbnail((768, 768))
    sx, sy = scene.width, scene.height
    ImageDraw.Draw(scene).rectangle(
        (box["x"] * sx, box["y"] * sy, (box["x"] + box["w"]) * sx, (box["y"] + box["h"]) * sy),
        outline=(255, 0, 0), width=3,
    )
    what = f"the {label}" if label else "the object"
    prompt = (
        f"In this photo {what} is outlined in red. Suggest {n} different objects that could stand in "
        "its exact spot instead: about the same size, believable on that surface, and varied and "
        'surprising (mix colors, materials and kinds), for example "small potted cactus" or '
        '"vintage brass pocket watch". Reply with only a JSON array of short names.'
    )
    try:
        r = client().with_options(timeout=30, max_retries=1).responses.create(
            model="muse-spark-1.3",
            input=[{"role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": data_url(scene, 85)},
            ]}],
            reasoning={"effort": "minimal"},
            max_output_tokens=3000,
        )
        spend.add(spend.spark_cost(r.usage), "Muse Spark ideas")
        text = r.output_text or ""
        found = json.loads(text[text.index("["): text.rindex("]") + 1])
        names = [clean_label(str(x)) for x in found if isinstance(x, (str, int, float))]
        names = [x for x in names if x][:n]
        if names:
            return names + FALLBACK_IDEAS[: n - len(names)]
        print(f"[ideas] no usable ideas in {text[:120]!r}", flush=True)
    except Exception as e:
        print(f"[ideas] failed, using the fallback list: {type(e).__name__}: {str(e)[:120]}", flush=True)
    return FALLBACK_IDEAS[:n]


def erase(frame: Image.Image, label: str, box: dict) -> Image.Image:
    """Asks Muse Image to repaint the frame without the object. Raises MetaError on failure."""
    # Muse Image has no mask input, so the prompt has to say exactly what to remove and
    # that nothing else may change (the browser pastes back only the object's area).
    prompt = (
        f"Remove the {label} ({where(box)} of the photo). Fill its spot with the surface that was "
        "behind it, matching the texture, lighting and shadows, as if it was never there. "
        "Keep everything else in the photo exactly the same: same framing, same position of every object."
    )
    return edit_image(frame, prompt, "erase")


def transmute(frame: Image.Image, label: str, box: dict, command: str) -> Image.Image:
    """Asks Muse Image to change the object as the user said ("make it gold"). Raises MetaError."""
    prompt = (
        f"Edit only the {label} ({where(box)} of the photo): {command}. "
        "Keep it in the same place, at the same size and angle, with lighting and shadows that match "
        "the scene, so it looks real. Keep everything else in the photo exactly the same: same framing, "
        "same position of every object."
    )
    return edit_image(frame, prompt, "transmute")


def edit_image(frame: Image.Image, prompt: str, what: str) -> Image.Image:
    """One Muse Image edit of the whole frame. Raises MetaError on failure."""
    buf = io.BytesIO()
    frame.save(buf, "JPEG", quality=95)
    try:
        result = client().with_options(timeout=90, max_retries=1).images.edit(
            model="muse-image-1.0",
            image=("frame.jpg", buf.getvalue(), "image/jpeg"),
            prompt=prompt,
            n=1,
            response_format="b64_json",
            extra_body={"output_format": "png"},
        )
    except APIStatusError as e:
        raise MetaError(f"Muse Image failed with HTTP {e.status_code}: {str(e.message)[:200]}")
    except APIConnectionError as e:
        raise MetaError(f"Muse Image unreachable: {type(e).__name__}")
    spend.add(spend.IMAGE_EACH, f"Muse Image {what}")  # billed once an image comes back
    try:
        return Image.open(io.BytesIO(base64.b64decode(result.data[0].b64_json))).convert("RGB")
    except Exception as e:
        raise MetaError(f"Muse Image returned no usable image: {type(e).__name__}")


def align(frame: Image.Image, edited: Image.Image, box: dict) -> tuple[Image.Image, int, int]:
    """Shifts `edited` so it lines up with `frame` around the box.

    Muse Image redraws the whole photo and drifts a little (tested: the top half moved up
    ~7 px of 1280, the bottom stayed put). The browser pastes back only the box area, so
    what matters is the fit right around the box: we try small shifts and keep the one
    whose ring around the box (the box itself changed on purpose) matches best.
    Returns (aligned image, dx, dy).
    """
    W, H = frame.size
    # Ring = box grown by 50% per side, minus the box itself.
    gx, gy = box["w"] * 0.5, box["h"] * 0.5
    region = (
        round(max(0, box["x"] - gx) * W), round(max(0, box["y"] - gy) * H),
        round(min(1, box["x"] + box["w"] + gx) * W), round(min(1, box["y"] + box["h"] + gy) * H),
    )
    a = frame.convert("L").crop(region)
    b_full = edited.convert("L")
    ring = Image.new("L", a.size, 255)
    ImageDraw.Draw(ring).rectangle((
        box["x"] * W - region[0], box["y"] * H - region[1],
        (box["x"] + box["w"]) * W - region[0], (box["y"] + box["h"]) * H - region[1],
    ), fill=0)

    def cost(dx: int, dy: int) -> float:
        b = b_full.crop((region[0] + dx, region[1] + dy, region[2] + dx, region[3] + dy))
        return ImageStat.Stat(ImageChops.difference(a, b), ring).mean[0]

    # Coarse search every 2 px, then refine around the best by 1 px.
    reach = max(4, round(0.02 * max(W, H)))
    best = min((cost(dx, dy), dx, dy) for dy in range(-reach, reach + 1, 2) for dx in range(-reach, reach + 1, 2))
    best = min((cost(best[1] + i, best[2] + j), best[1] + i, best[2] + j) for i in (-1, 0, 1) for j in (-1, 0, 1))
    _, dx, dy = best
    # Only move if it clearly helps; on flat surfaces every shift scores the same.
    if (dx, dy) == (0, 0) or best[0] > 0.85 * cost(0, 0):
        return edited, 0, 0
    aligned = frame.copy()  # edges uncovered by the shift keep the original pixels
    aligned.paste(edited, (-dx, -dy))
    return aligned, dx, dy


def remove_object(frame: Image.Image, box: dict, label: str | None) -> dict:
    """Erase pipeline: shrink, name, erase, resize back. Returns the JSON response body."""
    return run_edit(frame, box, label, "remove", lambda small, name: erase(small, name, box))


def transmute_object(frame: Image.Image, box: dict, label: str | None, command: str) -> dict:
    """Transmute pipeline: like erasing, but the object is changed as `command` says."""
    return run_edit(frame, box, label, "transmute", lambda small, name: transmute(small, name, box, command))


def run_edit(frame: Image.Image, box: dict, label: str | None, what: str, edit) -> dict:
    """Shrink, name (unless known), edit with Muse Image, resize back and align.
    Returns the JSON response body."""
    small = downscale(frame)

    t0 = time.perf_counter()
    label = clean_label(label) if label else describe(small, box)
    label = label or "object"
    t1 = time.perf_counter()
    edited = edit(small, label)
    t2 = time.perf_counter()

    # Same aspect ratio is expected (tested: 720x1280 in -> 1152x2048 out); warn if not,
    # because then the stretched result won't line up with the video.
    got = edited.size
    if abs(got[0] / got[1] - frame.width / frame.height) > 0.01:
        print(f"[{what}] WARNING aspect changed: sent {small.size}, got {got}", flush=True)
    out, dx, dy = align(frame, edited.resize(frame.size, Image.LANCZOS), box)

    buf = io.BytesIO()
    out.save(buf, "JPEG", quality=OUT_QUALITY)
    describe_ms, edit_ms = round((t1 - t0) * 1000), round((t2 - t1) * 1000)
    print(
        f"[{what}] label={label!r} describe={describe_ms}ms edit={edit_ms}ms "
        f"frame={frame.width}x{frame.height} sent={small.width}x{small.height} "
        f"meta_out={got[0]}x{got[1]} shift=({dx},{dy}) reply={len(buf.getvalue()) // 1024}KB",
        flush=True,
    )
    return {
        "image": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(),
        "label": label,
        "describe_ms": describe_ms,
        "edit_ms": edit_ms,
    }
