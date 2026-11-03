"""SAM 3.1 finds things in a picture by name: the Time Knob's way of finding its object again."""

import base64
import io

from meta_sam_parser import (
    CompletedOutcome,
    SegmentationBoxRecord,
    SegmentationMaskRecord,
    decode_mask_to_raster,
    image_segmentation_format,
)
from PIL import Image

import remove
import spend

MAX_OBJECTS = 3  # outlines kept per phrase
MIN_CONFIDENCE = 0.4  # SAM's own score; a lower outline is more likely something else
SAM_SIDE = 1024


def outline(view: Image.Image, phrase: str) -> list[dict]:
    """SAM 3.1 finds `phrase` in one view: its objects' boxes (0..1 of the view) and masks, as PNGs.
    SAM misses long phrases ("black cables across floor" found nothing, "cable" did), so a miss is
    tried once more with just the last word."""
    found = find(view, phrase)
    words = phrase.split()
    return found if found or len(words) < 2 else find(view, words[-1])


def find(view: Image.Image, phrase: str) -> list[dict]:
    small = view.copy()
    small.thumbnail((SAM_SIDE, SAM_SIDE))
    try:
        r = remove.client().with_options(timeout=60, max_retries=1).responses.create(
            model="sam-3.1",
            input=[{"role": "user", "content": [
                {"type": "input_text", "text": phrase},
                {"type": "input_image", "image_url": remove.data_url(small, 85)},
            ]}],
            metadata={"mask_encoding": "one_bit"},
        )
    except Exception as e:
        raise remove.MetaError(f"SAM failed: {type(e).__name__}: {str(e)[:160]}")
    spend.add(spend.SAM_IMAGE_EACH, "SAM 3.1 outline")
    text = r.output_text or ""
    if not text.strip():
        return []
    parser = image_segmentation_format().create_parser()
    list(parser.push(text if text.endswith("\n") else text + "\n"))
    result = parser.finish(CompletedOutcome()).result
    W, H = small.size
    boxes = {b.object_id: b for b in result.records if isinstance(b, SegmentationBoxRecord)}
    found = []
    for m in result.records:
        if not isinstance(m, SegmentationMaskRecord):
            continue
        box = boxes.get(m.object_id)
        sure = m.confidence if m.confidence is not None else (box.confidence if box else None)
        if sure is not None and sure < MIN_CONFIDENCE:
            continue
        b = m.bounds
        raster = decode_mask_to_raster(m.mask)
        picture = Image.frombytes("L", (m.mask.width, m.mask.height), bytes(255 * v for v in raster))
        solid = Image.new("RGBA", picture.size, (255, 255, 255, 0))
        solid.putalpha(picture)
        buf = io.BytesIO()
        solid.save(buf, "PNG", optimize=True)
        found.append({
            "box": {"x": b.left / W, "y": b.top / H, "w": (b.right - b.left) / W, "h": (b.bottom - b.top) / H},
            "mask": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
            "sure": sure,
        })
    found.sort(key=lambda f: -(f["box"]["w"] * f["box"]["h"]))
    return found[:MAX_OBJECTS]
