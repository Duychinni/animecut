#!/usr/bin/env python3
"""Source-level anonymous speaker diarization for AnimaCut Phase 1.

The script writes embeddings to the explicit local output path and never emits
raw vectors on stdout/stderr. Stdout is reserved for one JSON result object.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import os
import subprocess
import sys
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np


SCHEMA_VERSION = 1
CONFIDENCE_SOURCE = "embedding_margin_v1"


@dataclass
class RawTurn:
    start: float
    end: float
    source_label: str
    speaker_key: str = ""
    overlap: bool = False
    embedding: np.ndarray | None = None


def _speaker_suffix(index: int) -> str:
    value = index
    chars: list[str] = []
    while True:
        chars.append(chr(ord("a") + value % 26))
        value = value // 26 - 1
        if value < 0:
            break
    return "".join(reversed(chars))


def stable_speaker_mapping(turns: Iterable[RawTurn]) -> dict[str, str]:
    first_seen: dict[str, float] = {}
    for turn in turns:
        first_seen[turn.source_label] = min(first_seen.get(turn.source_label, turn.start), turn.start)
    ordered = sorted(first_seen, key=lambda label: (first_seen[label], label))
    return {label: f"speaker_{_speaker_suffix(index)}" for index, label in enumerate(ordered)}


def mark_overlaps(turns: list[RawTurn]) -> None:
    for index, turn in enumerate(turns):
        turn.overlap = any(
            other.source_label != turn.source_label
            and min(turn.end, other.end) - max(turn.start, other.start) >= 0.05
            for other in turns[index + 1 :]
        ) or any(
            other.source_label != turn.source_label
            and min(turn.end, other.end) - max(turn.start, other.start) >= 0.05
            for other in turns[:index]
        )


def normalize_embedding(value: Any) -> np.ndarray | None:
    array = np.asarray(value, dtype=np.float32).reshape(-1)
    if array.size == 0 or not np.all(np.isfinite(array)):
        return None
    norm = float(np.linalg.norm(array))
    if norm <= 1e-8:
        return None
    return array / norm


def build_centroids(turns: list[RawTurn]) -> dict[str, np.ndarray]:
    grouped: dict[str, list[np.ndarray]] = {}
    for turn in turns:
        if turn.embedding is not None:
            grouped.setdefault(turn.speaker_key, []).append(turn.embedding)
    centroids: dict[str, np.ndarray] = {}
    for speaker_key, vectors in grouped.items():
        centroid = normalize_embedding(np.mean(np.stack(vectors), axis=0))
        if centroid is not None:
            centroids[speaker_key] = centroid
    return centroids


def turn_confidence(turn: RawTurn, centroids: dict[str, np.ndarray], turn_count: int) -> float | None:
    if turn.embedding is None or turn.speaker_key not in centroids:
        return None
    own_similarity = float(np.dot(turn.embedding, centroids[turn.speaker_key]))
    other_similarities = [
        float(np.dot(turn.embedding, centroid))
        for speaker_key, centroid in centroids.items()
        if speaker_key != turn.speaker_key
    ]
    other_similarity = max(other_similarities) if other_similarities else -0.20
    margin_score = float(np.clip((own_similarity - other_similarity + 0.05) / 0.45, 0.0, 1.0))
    duration_score = float(np.clip((turn.end - turn.start) / 2.5, 0.0, 1.0))
    independent_turn_score = float(np.clip(turn_count / 3.0, 0.0, 1.0))
    confidence = 0.55 * margin_score + 0.25 * duration_score + 0.20 * independent_turn_score
    if turn.overlap:
        confidence *= 0.70
    return round(float(np.clip(confidence, 0.05, 0.98)), 4)


def merged_speech_ranges(turns: list[RawTurn]) -> list[tuple[float, float]]:
    ranges = sorted((max(0.0, turn.start), max(0.0, turn.end)) for turn in turns if turn.end > turn.start)
    merged: list[tuple[float, float]] = []
    for start, end in ranges:
        if not merged or start > merged[-1][1] + 0.02:
            merged.append((start, end))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
    return merged


def non_speech_ranges(turns: list[RawTurn], duration: float, minimum_gap: float = 0.25) -> list[tuple[float, float]]:
    ranges = merged_speech_ranges(turns)
    gaps: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in ranges:
        if start - cursor >= minimum_gap:
            gaps.append((cursor, start))
        cursor = max(cursor, end)
    if duration - cursor >= minimum_gap:
        gaps.append((cursor, duration))
    return gaps


def classify_gap(samples: np.ndarray, sample_rate: int, start: float, end: float) -> str:
    lo = max(0, int(start * sample_rate))
    hi = min(samples.size, int(end * sample_rate))
    if hi <= lo:
        return "unknown"
    window = samples[lo:hi].astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(window * window) + 1e-12))
    dbfs = 20.0 * math.log10(max(rms, 1e-8))
    return "silence" if dbfs <= -42.0 else "music_or_broll"


def extract_pcm(ffmpeg: str, source: Path, output: Path, timeout_sec: int) -> None:
    command = [
        ffmpeg,
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(output),
    ]
    subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout_sec)


def load_pcm(path: Path) -> tuple[np.ndarray, int, float]:
    with wave.open(str(path), "rb") as handle:
        sample_rate = handle.getframerate()
        frame_count = handle.getnframes()
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise RuntimeError("Expected 16-bit mono PCM from FFmpeg")
        samples = np.frombuffer(handle.readframes(frame_count), dtype="<i2").copy()
    duration = frame_count / float(sample_rate) if sample_rate else 0.0
    return samples, sample_rate, duration


def _pipeline_annotation(output: Any) -> Any:
    return getattr(output, "speaker_diarization", output)


def run(args: argparse.Namespace) -> dict[str, Any]:
    try:
        import torch
        from pyannote.audio import Inference, Model, Pipeline
        from pyannote.core import Segment
    except Exception as exc:  # pragma: no cover - environment-specific
        raise RuntimeError(f"diarization dependency import failed: {exc}") from exc

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not token:
        raise RuntimeError("HF_TOKEN is required for the configured diarization models")

    source = Path(args.input).resolve()
    embedding_output = Path(args.embedding_output).resolve()
    if not source.is_file():
        raise RuntimeError("Input media does not exist")
    embedding_output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="animacut-diarization-") as temp_dir:
        pcm_path = Path(temp_dir) / "source.wav"
        extract_pcm(args.ffmpeg, source, pcm_path, args.extract_timeout_sec)
        samples, sample_rate, duration = load_pcm(pcm_path)

        pipeline = Pipeline.from_pretrained(args.model, revision=args.model_revision, token=token)
        if args.device != "cpu":
            pipeline.to(torch.device(args.device))
        output = pipeline(str(pcm_path))
        annotation = _pipeline_annotation(output)

        turns: list[RawTurn] = []
        for segment, _, source_label in annotation.itertracks(yield_label=True):
            start = max(0.0, float(segment.start))
            end = min(duration, float(segment.end))
            if end - start >= 0.05:
                turns.append(RawTurn(start=start, end=end, source_label=str(source_label)))
        turns.sort(key=lambda turn: (turn.start, turn.end, turn.source_label))
        if not turns:
            raise RuntimeError("Diarization produced no speech turns")

        mapping = stable_speaker_mapping(turns)
        for turn in turns:
            turn.speaker_key = mapping[turn.source_label]
        mark_overlaps(turns)

        embedding_model = Model.from_pretrained(
            args.embedding_model,
            revision=args.embedding_model_revision,
            token=token,
        )
        inference = Inference(embedding_model, window="whole")
        if args.device != "cpu":
            inference.to(torch.device(args.device))

        for turn in turns:
            if turn.end - turn.start < 0.65:
                continue
            try:
                turn.embedding = normalize_embedding(
                    inference.crop(str(pcm_path), Segment(turn.start, turn.end))
                )
            except Exception:
                turn.embedding = None

        centroids = build_centroids(turns)
        ordered_speakers = sorted(set(turn.speaker_key for turn in turns))
        if set(ordered_speakers) != set(centroids):
            missing = sorted(set(ordered_speakers) - set(centroids))
            raise RuntimeError(f"Could not create reusable embeddings for: {', '.join(missing)}")

        embedding_matrix = np.stack([centroids[key] for key in ordered_speakers]).astype(np.float32)
        np.savez_compressed(
            embedding_output,
            speaker_keys=np.asarray(ordered_speakers),
            embeddings=embedding_matrix,
        )

        counts = {key: sum(1 for turn in turns if turn.speaker_key == key) for key in ordered_speakers}
        evidence = {
            key: sum(turn.end - turn.start for turn in turns if turn.speaker_key == key)
            for key in ordered_speakers
        }
        serialized_turns: list[dict[str, Any]] = []
        for turn in turns:
            serialized_turns.append(
                {
                    "start_sec": round(turn.start, 4),
                    "end_sec": round(turn.end, 4),
                    "speaker_key": turn.speaker_key,
                    "confidence": turn_confidence(turn, centroids, counts[turn.speaker_key]),
                    "confidence_source": CONFIDENCE_SOURCE,
                    "overlap": turn.overlap,
                    "classification": "speech",
                }
            )

        gaps = non_speech_ranges(turns, duration)
        for start, end in gaps:
            serialized_turns.append(
                {
                    "start_sec": round(start, 4),
                    "end_sec": round(end, 4),
                    "speaker_key": None,
                    "confidence": None,
                    "confidence_source": None,
                    "overlap": False,
                    "classification": classify_gap(samples, sample_rate, start, end),
                }
            )
        serialized_turns.sort(key=lambda item: (item["start_sec"], item["end_sec"], item["speaker_key"] or ""))

        speakers = [
            {
                "speaker_key": key,
                "evidence_duration_sec": round(evidence[key], 4),
                "embedding_index": index,
                "embedding_dimension": int(embedding_matrix.shape[1]),
            }
            for index, key in enumerate(ordered_speakers)
        ]

        return {
            "schema_version": SCHEMA_VERSION,
            "provider": "pyannote",
            "provider_version": importlib.metadata.version("pyannote.audio"),
            "model": args.model,
            "model_revision": args.model_revision,
            "embedding_model": args.embedding_model,
            "embedding_model_revision": args.embedding_model_revision,
            "duration_sec": round(duration, 4),
            "embedding_file": str(embedding_output),
            "speakers": speakers,
            "turns": serialized_turns,
            "diagnostics": {
                "speech_turn_count": len(turns),
                "overlap_turn_count": sum(1 for turn in turns if turn.overlap),
                "non_speech_range_count": len(gaps),
                "confidence_source": CONFIDENCE_SOURCE,
            },
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--embedding-output")
    parser.add_argument("--model", default="pyannote/speaker-diarization-community-1")
    parser.add_argument("--model-revision", default="main")
    parser.add_argument("--embedding-model", default="pyannote/wespeaker-voxceleb-resnet34-LM")
    parser.add_argument("--embedding-model-revision", default="main")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--extract-timeout-sec", type=int, default=300)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.health:
        try:
            print(json.dumps({"ok": True, "pyannote_audio": importlib.metadata.version("pyannote.audio")}))
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}))
            raise SystemExit(1)
        return
    if not args.input or not args.embedding_output:
        print(json.dumps({"error": "--input and --embedding-output are required"}))
        raise SystemExit(2)
    try:
        print(json.dumps(run(args), separators=(",", ":")))
    except subprocess.TimeoutExpired:
        print(json.dumps({"error": "audio extraction timed out"}))
        raise SystemExit(3)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
