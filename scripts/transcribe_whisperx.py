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
        import whisperx  # type: ignore
    except Exception as exc:
        print(json.dumps({"error": f"whisperx import failed: {exc}"}))
        sys.exit(1)

    try:
        model = whisperx.load_model(model_name, device, compute_type=compute_type)
        audio = whisperx.load_audio(str(audio_path))
        result = model.transcribe(audio, batch_size=4)

        language = result.get("language", "en")
        align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
        aligned = whisperx.align(result["segments"], align_model, metadata, str(audio_path), device)

        segments = []
        for seg in aligned.get("segments", []):
            item = {
                "start": seg.get("start"),
                "end": seg.get("end"),
                "text": seg.get("text", "").strip(),
            }
            words = []
            for word in seg.get("words", []) or []:
                word_text = (word.get("word") or "").strip()
                if not word_text:
                    continue
                words.append({
                    "start": word.get("start"),
                    "end": word.get("end"),
                    "word": word_text,
                })
            if words:
                item["words"] = words
            segments.append(item)

        full_text = " ".join(seg.get("text", "").strip() for seg in segments if seg.get("text")).strip()
        print(json.dumps({
            "language": language,
            "fullText": full_text,
            "segments": segments,
        }))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
