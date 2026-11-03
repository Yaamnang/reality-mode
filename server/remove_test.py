"""Try removing an object from a photo with Meta's Muse Image (edit endpoint).

Run from server/:  python remove_test.py <input.jpg> <output.png> "<object to remove>"
Costs about $0.01 per run.
"""

import base64
import sys
import time

from openai import APIStatusError

import meta

source, output, thing = sys.argv[1], sys.argv[2], sys.argv[3]

# Muse Image has no mask input, so the prompt has to say exactly what to remove and
# that nothing else may change (we paste back only the object's area later).
prompt = (
    f"Remove the {thing} from the photo. Fill its spot with the surface that was behind it, "
    "matching the texture, lighting and shadows, as if it was never there. "
    "Keep everything else in the photo exactly the same: same framing, same position of every object."
)

start = time.time()
try:
    with open(source, "rb") as f:
        result = meta.client().images.edit(
            model="muse-image-1.0",
            image=f,
            prompt=prompt,
            n=1,
            response_format="b64_json",
            extra_body={"output_format": "png"},
        )
except APIStatusError as e:
    print(f"FAILED with HTTP {e.status_code}: {e.message}")
    sys.exit(1)

with open(output, "wb") as f:
    f.write(base64.b64decode(result.data[0].b64_json))
print(f"Saved {output} in {time.time() - start:.1f} s")
