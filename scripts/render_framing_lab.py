#!/usr/bin/env python3
"""Render a 9:16 Framing Lab preview from smart-reframe metadata."""

import json
import sys
from pathlib import Path


def clamp(value, low, high):
    return max(low, min(high, value))


def main():
    if len(sys.argv) != 5:
        raise SystemExit("usage: render_framing_lab.py input metadata output duration")

    import cv2  # type: ignore

    input_path, metadata_path, output_path, requested_duration = sys.argv[1:]
    metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    timeline = metadata.get("reframe_timeline") or []
    fallback_points = metadata.get("points") or []
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise SystemExit("video_open_failed")

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    source_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    source_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    duration = float(requested_duration)
    writer = cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (540, 960))
    if not writer.isOpened():
        raise SystemExit("preview_writer_failed")

    frame_index = 0
    last_crop = None
    while frame_index / fps < duration:
        ok, frame = cap.read()
        if not ok:
            break
        timestamp = frame_index / fps
        segment = next((item for item in timeline if float(item.get("start", 0)) <= timestamp <= float(item.get("end", duration)) + 0.001), None)
        points = (segment or {}).get("points") or fallback_points
        point = min(points, key=lambda item: abs(float(item.get("t", 0)) - timestamp), default={})
        crop_w = int(round(float(point.get("cropW", source_h * 9 / 16))))
        crop_h = int(round(float(point.get("cropH", source_h))))
        crop_x = float(point.get("cropX", float(point.get("nx", 0.5)) * source_w - crop_w / 2))
        crop_y = float(point.get("cropY", 0))
        crop_w = int(clamp(crop_w, 2, source_w))
        crop_h = int(clamp(crop_h, 2, source_h))
        crop_x = int(clamp(crop_x, 0, source_w - crop_w))
        crop_y = int(clamp(crop_y, 0, source_h - crop_h))

        current = (crop_x, crop_y, crop_w, crop_h)
        if last_crop is not None:
            # Damp same-speaker micro movement. Speaker changes are already
            # represented as intentional timeline cuts by the analysis engine.
            alpha = 0.24
            current = tuple(int(round(old + (new - old) * alpha)) for old, new in zip(last_crop, current))
        last_crop = current
        x, y, w, h = current
        cropped = frame[y:y + h, x:x + w]
        if cropped.size:
            writer.write(cv2.resize(cropped, (540, 960), interpolation=cv2.INTER_AREA))
        frame_index += 1

    writer.release()
    cap.release()


if __name__ == "__main__":
    main()
