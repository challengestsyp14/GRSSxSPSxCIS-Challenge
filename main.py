"""Generate a video with Seedance 2.5 through the Higgsfield API.

Credentials are read at runtime from ``HF_KEY`` in ``key-id:key-secret`` format, taken from
the environment or from ``.env.local`` (git-ignored). The value is never printed or logged.

The SDK's ``subscribe`` returns the response body for *every* terminal state, including
failed, moderated and cancelled requests, so this script checks the final status itself
before reporting a video URL.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import higgsfield_client
import httpx
from dotenv import load_dotenv
from higgsfield_client import (
    NSFW,
    Cancelled,
    Completed,
    CredentialsMissedError,
    Failed,
    HiggsfieldClientError,
    Status,
)

MODEL = "bytedance/seedance-2.5/text-to-video"
ARGUMENTS = {
    "prompt": "A cinematic scene at sunset",
    "duration": 5,
    "resolution": "720p",
    "aspect_ratio": "16:9",
}

FAILURE_MESSAGES = {
    Failed: "generation failed",
    NSFW: "request was blocked by content moderation",
    Cancelled: "request was cancelled",
}


def find_video_url(result: dict[str, Any]) -> str | None:
    video = result.get("video")
    if isinstance(video, dict) and isinstance(video.get("url"), str):
        return video["url"]

    videos = result.get("videos")
    if isinstance(videos, list) and videos and isinstance(videos[0], dict):
        url = videos[0].get("url")
        return url if isinstance(url, str) else None

    return None


def main() -> int:
    # Existing environment variables win; .env.local only fills what is missing.
    load_dotenv(Path(__file__).with_name(".env.local"), override=False)

    statuses: list[Status] = []

    def on_enqueue(request_id: str) -> None:
        print(f"submitted: request {request_id}")

    def on_queue_update(status: Status) -> None:
        if not statuses or type(status) is not type(statuses[-1]):
            print(f"status: {type(status).__name__}")
        statuses.append(status)

    try:
        result = higgsfield_client.subscribe(
            MODEL,
            arguments=ARGUMENTS,
            on_enqueue=on_enqueue,
            on_queue_update=on_queue_update,
        )
    except CredentialsMissedError:
        print(
            "error: HF_KEY is not set. Provide it as an environment variable or in .env.local "
            "(format key-id:key-secret).",
            file=sys.stderr,
        )
        return 2
    except HiggsfieldClientError as error:
        print(f"error: the Higgsfield API rejected the request: {error}", file=sys.stderr)
        return 1
    except httpx.HTTPError as error:
        print(f"error: could not reach the Higgsfield API: {type(error).__name__}", file=sys.stderr)
        return 1

    final = statuses[-1] if statuses else None
    for status_type, message in FAILURE_MESSAGES.items():
        if isinstance(final, status_type):
            print(f"error: {message}.", file=sys.stderr)
            return 1

    reported = result.get("status")
    if not isinstance(final, Completed) or reported not in (None, "completed"):
        shown = type(final).__name__ if final else "none"
        print(
            f"error: request did not complete (status {shown}, reported {reported!r}).",
            file=sys.stderr,
        )
        return 1

    url = find_video_url(result)
    if url is None:
        print(
            "error: request completed but no video URL was found "
            f"(response keys: {sorted(result)}).",
            file=sys.stderr,
        )
        return 1

    print(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
