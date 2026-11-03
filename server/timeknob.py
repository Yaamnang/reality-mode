"""The Time Knob's Meta calls: what is this object, and what did it look like at other times?

Three Muse Spark "agents" each look at the object in their own way and say what it is. A fourth,
the judge, reads their answers, decides, and writes the object's timeline: its stages going back
(and, for living things, forward) in time. Muse Image then draws each stage in place.
"""

import base64
import io
import json
import time

from PIL import Image, ImageDraw

import remove
import spend

MODEL = "muse-spark-1.3"
CROP_PAD = 0.3  # margin around the box for close-ups, as a fraction of the box size per side
# What Muse Image gets for a stage: the object and room around it (fractions of the box's size per
# side), at least this much of the frame.
STAGE_SIDE, STAGE_UP, STAGE_DOWN = 1.0, 2.0, 0.5  # the browser looks for changes in the area sent back
STAGE_MIN = 0.5

ANSWER_FORMAT = (
    'Reply with only JSON: {"name": "...", "kind": "...", "sure": 0-100}. '
    '"name" is 2 to 6 words: its color and exactly what it is, for example "silver AirPods case". '
    '"kind" is "natural" if it grew or was alive (fruit, vegetable, plant, egg, flower, wood log, '
    'fresh food) or "made" if people manufactured it. "sure" is how sure you are. Ignore any hands.'
)

# Each agent gets different pictures and a different way of judging, so they can disagree.
AGENTS = {
    "closeup": ("close", "This is a close-up of one object. Judge only by its shape, surface and small details."),
    "context": ("scene", "One object in this photo is outlined in red. Judge by where it is, what is around it and its size next to those things."),
    "material": ("close", "This is a close-up of one object. Judge by what it is made of and how it came to be: grown, or formed in a factory?"),
}


def close_up(frame: Image.Image, box: dict) -> Image.Image:
    W, H = frame.size
    px, py = box["w"] * CROP_PAD, box["h"] * CROP_PAD
    return frame.crop((
        round(max(0, box["x"] - px) * W),
        round(max(0, box["y"] - py) * H),
        round(min(1, box["x"] + box["w"] + px) * W),
        round(min(1, box["y"] + box["h"] + py) * H),
    ))


def scene_with_box(frame: Image.Image, box: dict) -> Image.Image:
    scene = frame.copy()
    scene.thumbnail((768, 768))
    sx, sy = scene.size
    ImageDraw.Draw(scene).rectangle(
        (box["x"] * sx, box["y"] * sy, (box["x"] + box["w"]) * sx, (box["y"] + box["h"]) * sy),
        outline=(255, 0, 0), width=3,
    )
    return scene


def ask(prompt: str, images: list[Image.Image], effort: str, what: str) -> dict:
    """One Muse Spark call that answers in JSON. Raises on anything unusable."""
    r = remove.client().with_options(timeout=45, max_retries=1).responses.create(
        model=MODEL,
        input=[{"role": "user", "content": [
            {"type": "input_text", "text": prompt},
            *[{"type": "input_image", "image_url": remove.data_url(i, 85)} for i in images],
        ]}],
        reasoning={"effort": effort},
        max_output_tokens=4000,
    )
    spend.add(spend.spark_cost(r.usage), f"Muse Spark {what}")
    text = r.output_text or ""
    return remove.no_tibet(json.loads(text[text.index("{"): text.rindex("}") + 1]))


def look(frame: Image.Image, box: dict, agent: str) -> dict:
    """One agent's opinion. Never fails: an agent that can't answer just says it doesn't know."""
    view, how = AGENTS[agent]
    picture = close_up(frame, box) if view == "close" else scene_with_box(frame, box)
    try:
        said = ask(f"{how} {ANSWER_FORMAT}", [picture], "minimal", f"agent {agent}")
        name = remove.clean_label(str(said.get("name", "")))
        kind = "natural" if said.get("kind") == "natural" else "made"
        sure = max(0, min(100, int(said.get("sure", 50))))
        if name:
            return {"agent": agent, "name": name, "kind": kind, "sure": sure}
    except Exception as e:
        print(f"[time] agent {agent} failed: {type(e).__name__}: {str(e)[:120]}", flush=True)
    return {"agent": agent, "name": "", "kind": "made", "sure": 0}


TIMELINE_RULES = """Three agents looked at the object in the picture and said:
{opinions}

You are the judge. Decide what it really is, then write its timeline. Each stage is one image edit: the object's spot in the same photo, at another moment of its history.

"past" goes back in time, nearest first. "future" goes forward, nearest first.

If it is "natural" (grown or alive): exactly 2 past stages and 2 future stages, following its real life cycle. An apple: past = "small hard green unripe apple on a leafy twig", then "white and pink apple blossoms on a twig". Future = "soft brown bruises, wrinkled skin", then "collapsed, rotten, covered in white and grey mold".

If it is "made" (manufactured): exactly 2 past stages and normally NO future stages, since made things don't change on their own.
- First past stage: if it is assembled from parts (phone, watch, lamp, toy), an EXPLODED VIEW: the real internal parts of this exact product, named specifically, hovering in mid-air above the surface with soft shadows below them, pulled apart along one line with even gaps, like an engineering exploded diagram made real. If it is one material (mug, bottle, spoon), it half made: for example a mug as wet clay on a potter's wheel.
- Second past stage: the RAW MATERIALS before manufacture, named specifically for this object, as small separate loose natural heaps directly on the bare surface where it stands, with nothing holding them and no trace of the object or its shape: for a phone, chunks of aluminium ore, quartz sand, copper ore, grey rock, a pool of crude oil. Never write powder, crystals, salt or white heaps: Meta's image filter refuses them.
- A future stage only if it visibly decays by itself over the years (iron rusts, paper yellows, a candle melts): at most 1.

"about": one sentence of at most 20 words telling a viewer what this object is and what it is for, in plain words.
"sure": how sure you are of the name, 0 to 100.
"type": 1 or 2 words for what kind of thing it is, like "Fruit", "Vegetable", "Electronics", "Plastic bottle", "Medicine".
"fate": what becomes of it when thrown away, exactly one of "Biodegradable", "Recyclable", "Non-biodegradable", "Toxic waste", "Never throw, burn". Electronics, batteries, chemicals and medicines are "Toxic waste".

Sacred and royal things: in Bhutan, Buddhist religious items (thangkas, statues, scriptures, prayer flags, prayer wheels, altar items) and any portrait of a king or royal family are never thrown away, they are burned respectfully. For these, "fate" is "Never throw, burn" and "type" is "Sacred item" or "Royal portrait". Their timeline must stay respectful: "future" is empty, and "past" shows only how it was made (a thangka: the bare stretched canvas with a pencil sketch, then the mineral pigments). Never show one torn, rotting, burning or taken apart. Never name a deity or a person in "name", "about" or "look": say "Buddhist thangka painting", "royal portrait". Never write "Tibet" or "Tibetan": these are Buddhist items.

Every stage has:
"label": 1 to 3 words for the display, like "Exploded view", "Raw materials", "Blossom", "Rotten".
"look": one sentence of at most 35 words saying exactly what can be seen. Only visible things, no story.

Reply with only JSON: {{"name": "...", "kind": "natural" or "made", "about": "...", "sure": 0, "type": "...", "fate": "...", "past": [{{"label": "...", "look": "..."}}], "future": [{{"label": "...", "look": "..."}}]}}"""


def fallback_timeline(name: str, kind: str) -> dict:
    """Used when the judge's answer can't be read."""
    if kind == "natural":
        return {
            "past": [
                {"label": "Younger", "look": f"the {name} much younger and smaller, fresh, early in its life"},
                {"label": "Beginning", "look": f"the very beginning of the {name}: the seed or bud it grew from"},
            ],
            "future": [
                {"label": "Older", "look": f"the {name} past its best, wrinkled and browning"},
                {"label": "Decayed", "look": f"the {name} collapsed, rotten and moldy"},
            ],
        }
    return {
        "past": [
            {"label": "Exploded view", "look": f"exploded view of the {name}: all its parts floating in the air, pulled apart along one line with even gaps, like a product teardown photograph"},
            {"label": "Raw materials", "look": f"the raw materials the {name} was made from, as small separate heaps of ore, sand and crystals on the surface"},
        ],
        "future": [],
    }


def stages(raw: object, most: int) -> list[dict]:
    """Keeps the usable stages from the judge's answer."""
    found = []
    for s in raw if isinstance(raw, list) else []:
        if isinstance(s, dict) and s.get("label") and s.get("look"):
            found.append({"label": remove.clean_label(str(s["label"])), "look": str(s["look"]).strip()[:300]})
    return found[:most]


def decide(frame: Image.Image, box: dict, opinions: list[dict]) -> dict:
    """The judge. Never fails: without a usable answer, the agents' most confident opinion and a
    generic timeline are used."""
    heard = [o for o in opinions if isinstance(o, dict) and o.get("name")]
    best = max(heard, key=lambda o: o.get("sure", 0), default={"name": "object", "kind": "made"})
    summary = "\n".join(f'- {o.get("agent")}: {o["name"]} ({o.get("kind")}, {o.get("sure", 0)}% sure)' for o in heard) or "- nobody could tell"
    try:
        said = ask(TIMELINE_RULES.format(opinions=summary), [close_up(frame, box)], "low", "judge")
        name = remove.clean_label(str(said.get("name", ""))) or best["name"]
        kind = "natural" if said.get("kind") == "natural" else "made"
        past = stages(said.get("past"), 2)
        future = stages(said.get("future"), 2 if kind == "natural" else 1)
        if past:
            fate = str(said.get("fate", "")).strip()
            return {
                "name": name,
                "kind": kind,
                "about": str(said.get("about", "")).strip()[:200],
                "sure": sure_of(said.get("sure"), sure_of(best.get("sure"))),
                "type": str(said.get("type", "")).strip()[:30],
                "fate": fate if fate in FATES else "",
                "past": past,
                "future": future,
            }
        print(f"[time] judge gave no past stages: {str(said)[:160]}", flush=True)
    except Exception as e:
        print(f"[time] judge failed: {type(e).__name__}: {str(e)[:120]}", flush=True)
    return {"name": best["name"], "kind": best["kind"], "about": "", "sure": sure_of(best.get("sure")), "type": "", "fate": "", **fallback_timeline(best["name"], best["kind"])}


FATES = ("Biodegradable", "Recyclable", "Non-biodegradable", "Toxic waste", "Never throw, burn")


def sure_of(value, default=0) -> int:
    try:
        return max(0, min(100, round(float(value))))
    except (TypeError, ValueError):
        return default


CHECK_RULES = """This photo was edited: a {name} was replaced by an earlier or later moment of its history. It was meant to show: {look}

Does the picture show that? Answer "ok": false only if it is clearly wrong. For example: it was meant to show loose heaps, but the {name} is still standing there, filled with them or holding them.

"caption" is one sentence of at most 20 words telling a viewer what can be seen where the {name} was, naming the real things in plain words. Say only what this picture shows. Don't mention editing, the photo or the room.

If it is wrong, "better" is a new description for the image editor that would fix it, one sentence of at most 35 words, only visible things, saying plainly what must not be there. Never write powder, crystals, salt or white heaps: Meta's image filter refuses them.

Reply with only JSON: {{"ok": true or false, "caption": "...", "problem": "...", "better": "..."}}"""

REWORD_RULES = """Meta's image filter refused to draw this description of a {name} at an earlier or later moment of its history: "{look}"

Write it again with the same idea in plain everyday words about harmless visible things: rocks, sand, beads, wood, metal parts. Never write powder, crystals, salt, chemicals, oil, white heaps or anything that could look like drugs or something dangerous. One sentence of at most 35 words.

Reply with only JSON: {{"look": "..."}}"""


def check_stage(picture: Image.Image, name: str, look: str) -> tuple[str | None, str]:
    """Muse Spark looks at what Muse Image drew. Returns a better description if it's clearly wrong
    (None if it's fine or the check itself fails) and a caption of what the picture really shows."""
    small = picture.copy()
    small.thumbnail((768, 768))
    try:
        said = ask(CHECK_RULES.format(name=name, look=look), [small], "minimal", "stage check")
        caption = str(said.get("caption", "")).strip()[:200]
        if said.get("ok") is False and said.get("better"):
            print(f"[time] check: {str(said.get('problem'))[:160]!r}", flush=True)
            return str(said["better"]).strip()[:300], caption
        return None, caption
    except Exception as e:
        print(f"[time] check failed: {type(e).__name__}: {str(e)[:120]}", flush=True)
    return None, ""


def reword(name: str, look: str, stage_title: str) -> str:
    """Muse Spark rewrites a description Meta's filter refused."""
    try:
        said = ask(REWORD_RULES.format(name=name, look=look), [], "minimal", "stage reword")
        if said.get("look"):
            return str(said["look"]).strip()[:300]
    except Exception as e:
        print(f"[time] reword failed: {type(e).__name__}: {str(e)[:120]}", flush=True)
    return f"the {name} at this stage of its history, shown plainly: {stage_title}"


def stage_area(box: dict) -> tuple[float, float, float, float]:
    """The part of the frame (0..1) Muse Image gets: left, top, right, bottom."""
    left = box["x"] - box["w"] * STAGE_SIDE
    right = box["x"] + box["w"] * (1 + STAGE_SIDE)
    top = box["y"] - box["h"] * STAGE_UP
    bottom = box["y"] + box["h"] * (1 + STAGE_DOWN)
    grow_x = max(0, STAGE_MIN - (right - left)) / 2
    grow_y = max(0, STAGE_MIN - (bottom - top)) / 2
    return max(0, left - grow_x), max(0, top - grow_y), min(1, right + grow_x), min(1, bottom + grow_y)


def draw_stage(frame: Image.Image, box: dict, label: str, look_like: str, stage_title: str) -> dict:
    """Muse Image draws the object's spot at another moment of its history. Unlike a transmute it
    may take more room than the object does now (a phone pulled apart is much longer). It only gets
    the area around the object: the browser pastes no more than that, and the fewer people and things
    in the picture, the less Meta's filter and redrawing get in the way. Muse Spark checks the result
    and rewrites what to draw if it's wrong or refused; one redraw at most. Returns the whole frame."""
    W, H = frame.size
    left, top, right, bottom = stage_area(box)
    px = round(left * W), round(top * H), round(right * W), round(bottom * H)
    crop = frame.crop(px)
    inside = {
        "x": (box["x"] * W - px[0]) / crop.width,
        "y": (box["y"] * H - px[1]) / crop.height,
        "w": box["w"] * W / crop.width,
        "h": box["h"] * H / crop.height,
    }
    name = remove.clean_label(label) or "object"

    def prompt(look: str) -> str:
        return (
            f"Edit this photo: the {name} ({remove.where(inside)} of the photo) is replaced by this, in the same "
            f"spot, and it may take more room than the {name} did: {look}. The {name} as it is now must be completely gone. It must look physically real, "
            "photographed by this same camera, with lighting and shadows that match the scene. "
            f"If a hand is touching or covering the {name}, remove it and show what is behind it. "
            "Keep everything else in the photo exactly the same: same framing, same position of every other object."
        )

    scale = remove.MAX_SIDE / max(crop.size)
    sent = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)

    def paint(look: str) -> tuple[Image.Image, str]:
        try:
            return remove.edit_image(sent, prompt(look), "time stage"), look
        except remove.MetaError as e:
            if "filtered" not in str(e):
                raise
            print(f"[time] filtered: {look!r}", flush=True)
            plainer = reword(name, look, stage_title)
            print(f"[time] reworded: {plainer!r}", flush=True)
            return remove.edit_image(sent, prompt(plainer), "time stage"), plainer

    t0 = time.perf_counter()
    edited, drawn = paint(look_like)
    better, caption = check_stage(edited, name, drawn)
    if better:
        print(f"[time] redrawing: {better!r}", flush=True)
        try:
            edited, drawn = paint(better)
            caption = check_stage(edited, name, drawn)[1]
        except remove.MetaError as e:
            print(f"[time] redraw failed, keeping the first picture: {str(e)[:120]}", flush=True)
    edit_ms = round((time.perf_counter() - t0) * 1000)
    if abs(edited.width / edited.height - crop.width / crop.height) > 0.01:
        print(f"[time] WARNING aspect changed: sent {sent.size}, got {edited.size}", flush=True)
    fitted, dx, dy = remove.align(crop, edited.resize(crop.size, Image.LANCZOS), inside)
    whole = frame.copy()
    whole.paste(fitted, px[:2])
    buf = io.BytesIO()
    whole.save(buf, "JPEG", quality=remove.OUT_QUALITY)
    print(f"[time] {label!r} {drawn[:40]!r} edit={edit_ms}ms crop={crop.size} sent={sent.size} meta_out={edited.size} shift=({dx},{dy})", flush=True)
    return {"image": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(), "label": name, "edit_ms": edit_ms, "caption": caption, "area": {"left": left, "top": top, "right": right, "bottom": bottom}}
