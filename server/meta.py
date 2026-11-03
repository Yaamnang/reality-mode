"""Meta Model API client (https://api.meta.ai/v1).

The key is read from godmode/.env on this laptop and never sent to the browser.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

BASE_URL = "https://api.meta.ai/v1"


def api_key() -> str:
    # MODEL_API_KEY is the name Meta's docs use; META_API is what this project's .env started with.
    key = os.environ.get("MODEL_API_KEY") or os.environ.get("META_API")
    if not key:
        raise RuntimeError("No Meta API key: set MODEL_API_KEY in godmode/.env")
    return key.strip().strip('"').strip("'")


def client() -> OpenAI:
    return OpenAI(base_url=BASE_URL, api_key=api_key())
