#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "audio path required"}))
        sys.exit(1)

    audio_path = Path(sys.argv[1])
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    device = sys.argv[3] if len(sys.argv) > 3 else "cpu"
    compute_type = sys.argv[4] if len(sys.argv) > 4 else "int8"

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:
        print(json.dumps({"error": f"faster-whisper import failed: {exc}"}))
        sys.exit(1)

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments_iter, info = model.transcribe(str(audio_path), word_timestamps=True, vad_filter=True)

        segments = []
        full_text_parts = []
        for seg in segments_iter:
            text = (seg.text or "").strip()
            item = {
                "start": seg.start,
                "end": seg.end,
                "text": text,
            }
            words = []
            for word in getattr(seg, "words", []) or []:
                word_text = (getattr(word, "word", "") or "").strip()
                if not word_text:
                    continue
                words.append({
                    "start": getattr(word, "start", None),
                    "end": getattr(word, "end", None),
                    "word": word_text,
                })
            if words:
                item["words"] = words
            segments.append(item)
            if text:
                full_text_parts.append(text)

        print(json.dumps({
            "language": getattr(info, "language", "en") or "en",
            "fullText": " ".join(full_text_parts).strip(),
            "segments": segments,
        }))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
