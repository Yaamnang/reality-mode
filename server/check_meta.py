"""One tiny call to check the Meta Model API works from here (key, billing, region).

Run from server/:  python check_meta.py
Costs a fraction of a cent. Prints the reply or the error, never the key.
"""

from openai import APIStatusError

import meta

# What each error code usually means, from Meta's docs.
HINTS = {
    401: "the key is wrong or was revoked",
    402: "billing isn't set up (add a payment method / claim credits)",
    403: "no permission: possibly the region (Bhutan) or account policy",
    404: "model not found or no access to it",
    429: "rate limited, try again in a moment",
}

try:
    r = meta.client().responses.create(
        model="muse-spark-1.3",
        input="Say ok.",
        reasoning={"effort": "low"},
        max_output_tokens=1024,  # reasoning tokens count too; 256 left no room for the answer
    )
    print("OK, Meta API works. Reply:", repr(r.output_text))
    print("Usage:", r.usage)
except APIStatusError as e:
    print(f"FAILED with HTTP {e.status_code}: {HINTS.get(e.status_code, 'see the message below')}")
    print("Message:", e.message)
except Exception as e:  # network errors, missing key, etc.
    print("FAILED:", type(e).__name__, e)
