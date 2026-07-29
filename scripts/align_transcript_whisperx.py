#!/usr/bin/env python3
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path


def main():
    if "--health" in sys.argv:
        try:
            import whisperx  # noqa: F401
            import torch  # noqa: F401
        except Exception as exc:
            print(f"caption alignment unavailable: {exc}", file=sys.stderr)
            sys.exit(1)
        print("caption alignment ready")
        return

    if len(sys.argv) < 3:
        print(json.dumps({"error": "audio path and transcript JSON path are required"}))
        sys.exit(1)

    audio_path = Path(sys.argv[1])
    transcript_path = Path(sys.argv[2])
    device = sys.argv[3] if len(sys.argv) > 3 else "cpu"

    try:
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
        source_segments = transcript.get("segments") or []
        alignable_segments = []
        for segment in source_segments:
            text = str(segment.get("text") or "").strip()
            start = segment.get("start")
            end = segment.get("end")
            if not text or start is None or end is None:
                continue
            alignable_segments.append({
                "start": float(start),
                "end": float(end),
                "text": text,
            })

        if not alignable_segments:
            raise RuntimeError("transcript contains no alignable segments")

        raw_language = str(transcript.get("language") or "en").strip().lower()
        # OpenAI verbose transcripts can return a language name ("english"),
        # while WhisperX alignment models are keyed by ISO codes ("en").
        # WhisperX, PyTorch, and model loaders occasionally print diagnostics to
        # stdout. Keep stdout as a strict machine-readable JSON channel; the
        # Node caller already captures stderr for diagnostics.
        with redirect_stdout(sys.stderr):
            import whisperx
            from whisperx.utils import TO_LANGUAGE_CODE

            language = TO_LANGUAGE_CODE.get(raw_language, raw_language)
            align_model, metadata = whisperx.load_align_model(
                language_code=language,
                device=device,
            )
            aligned = whisperx.align(
                alignable_segments,
                align_model,
                metadata,
                str(audio_path),
                device,
                return_char_alignments=False,
            )

        segments = []
        for segment in aligned.get("segments", []):
            words = []
            for word in segment.get("words", []) or []:
                word_text = str(word.get("word") or "").strip()
                start = word.get("start")
                end = word.get("end")
                if not word_text or start is None or end is None:
                    continue
                words.append({
                    "start": float(start),
                    "end": float(end),
                    "word": word_text,
                    "timing_source": "forced-alignment",
                    **({"alignment_score": float(word["score"])} if word.get("score") is not None else {}),
                })

            item = {
                "start": float(segment.get("start", 0)),
                "end": float(segment.get("end", 0)),
                "text": str(segment.get("text") or "").strip(),
            }
            if words:
                item["words"] = words
            segments.append(item)

        full_text = " ".join(
            segment["text"] for segment in segments if segment.get("text")
        ).strip()
        print(json.dumps({
            "language": language,
            "fullText": full_text or str(transcript.get("fullText") or ""),
            "segments": segments,
        }))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
