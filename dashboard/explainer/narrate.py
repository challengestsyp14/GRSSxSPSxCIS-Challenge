"""Voice-over and timings for the "Hiding in the noise" explainer.

Synthesises every line of script.json with a local Piper voice, then writes:

- build/narration.wav: the voice track, pauses included;
- ../src/noise/explainer.json: scene and caption timings, read by the renderer and the page;
- ../public/media/hiding-in-the-noise.en.vtt: English captions.

Usage: python narrate.py --voice /path/to/en-us-lessac-medium.onnx
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

from piper import PiperVoice
from piper.config import SynthesisConfig

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
#: Slightly slower than the voice's default pace, for an explainer.
LENGTH_SCALE = 1.08


def synthesize(voice: PiperVoice, text: str) -> tuple[bytes, int]:
    tmp = HERE / "build" / "line.wav"
    with wave.open(str(tmp), "wb") as out:
        voice.synthesize_wav(text, out, syn_config=SynthesisConfig(length_scale=LENGTH_SCALE))
    with wave.open(str(tmp), "rb") as src:
        return src.readframes(src.getnframes()), src.getframerate()


def vtt_time(seconds: float) -> str:
    ms = round(seconds * 1000)
    h, rest = divmod(ms, 3_600_000)
    m, rest = divmod(rest, 60_000)
    s, ms = divmod(rest, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--voice", required=True, help="Piper .onnx voice (its .json beside it)")
    args = parser.parse_args()

    script = json.loads((HERE / "script.json").read_text(encoding="utf-8"))
    (HERE / "build").mkdir(exist_ok=True)
    voice = PiperVoice.load(args.voice)

    pcm = bytearray()
    rate = 0
    t = 0.0
    scenes = []

    def pad(seconds: float) -> None:
        nonlocal t
        pcm.extend(b"\x00\x00" * round(seconds * rate))
        t += round(seconds * rate) / rate

    for scene in script["scenes"]:
        start = t
        cues = []
        for i, line in enumerate(scene["lines"]):
            audio, rate = synthesize(voice, line.get("say", line["text"]))
            if i == 0:
                pad(scene["leadS"])
            else:
                pad(script["pauseS"])
            begin = t
            pcm.extend(audio)
            t += len(audio) / 2 / rate
            cues.append({"start": round(begin, 3), "end": round(t, 3), "text": line["text"]})
        pad(scene["tailS"])
        scenes.append(
            {
                "id": scene["id"],
                "chapter": scene["chapter"],
                "start": round(start, 3),
                "end": round(t, 3),
                "cues": cues,
            }
        )

    with wave.open(str(HERE / "build" / "narration.wav"), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(bytes(pcm))

    timeline = {"title": script["title"], "duration": round(t, 3), "scenes": scenes}
    (ROOT / "src" / "noise").mkdir(parents=True, exist_ok=True)
    (ROOT / "src" / "noise" / "explainer.json").write_text(
        json.dumps(timeline, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    lines = ["WEBVTT", ""]
    for scene in scenes:
        for cue in scene["cues"]:
            lines += [f"{vtt_time(cue['start'])} --> {vtt_time(cue['end'])}", cue["text"], ""]
    media = ROOT / "public" / "media"
    media.mkdir(parents=True, exist_ok=True)
    (media / "hiding-in-the-noise.en.vtt").write_text("\n".join(lines), encoding="utf-8")
    print(f"{len(scenes)} scenes, {t:.1f} s of narration")


if __name__ == "__main__":
    main()
