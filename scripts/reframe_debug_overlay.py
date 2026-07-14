#!/usr/bin/env python3
"""Render an evidence overlay from the production smart-reframe metadata."""
import bisect
import json
import os
import subprocess
import sys
from collections import deque
from pathlib import Path

import cv2  # type: ignore


def clamp(value, low, high):
    return max(low, min(high, value))


def crop_rect(center_x, source_w, source_h):
    width = min(source_w, source_h * 9.0 / 16.0)
    x = clamp(center_x - width / 2.0, 0.0, source_w - width)
    return int(round(x)), 0, int(round(width)), int(round(source_h))


def draw_label(frame, text, origin, color):
    x, y = origin
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
    cv2.rectangle(frame, (x - 3, y - th - 7), (x + tw + 5, y + 4), (0, 0, 0), -1)
    cv2.putText(frame, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA)


def main():
    if len(sys.argv) != 7:
        raise SystemExit('usage: reframe_debug_overlay.py input metadata start end output command_file')
    input_path, metadata_path, start_raw, end_raw, output_path, command_path = sys.argv[1:]
    start_sec, end_sec = float(start_raw), float(end_raw)
    data = json.loads(Path(metadata_path).read_text(encoding='utf-8'))
    samples = data.get('detected_faces', [])
    sample_times = [float(item.get('timestamp', 0.0)) for item in samples]
    final_mode = data.get('mode', 'per_clip')

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise SystemExit('video_open_failed')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    source_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or data.get('source_w') or 1920)
    source_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or data.get('source_h') or 1080)
    cap.set(cv2.CAP_PROP_POS_MSEC, start_sec * 1000.0)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    silent_path = output.with_suffix('.silent.mp4')
    writer = cv2.VideoWriter(str(silent_path), cv2.VideoWriter_fourcc(*'mp4v'), fps, (source_w, source_h))
    path_points = deque(maxlen=max(30, int(round(fps * 3))))
    frame_index = 0
    duration = max(0.0, end_sec - start_sec)

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        rel_t = frame_index / fps
        if rel_t > duration:
            break
        index = bisect.bisect_left(sample_times, rel_t)
        if index >= len(samples):
            index = len(samples) - 1
        elif index > 0 and abs(sample_times[index - 1] - rel_t) < abs(sample_times[index] - rel_t):
            index -= 1
        sample = samples[index] if samples else {}
        active_id = sample.get('active_track_id')
        center_x = float(sample.get('chosen_center_x', source_w / 2.0))
        center_y = float(sample.get('chosen_center_y', source_h / 2.0))
        path_points.append((int(round(center_x)), int(round(center_y))))

        faces = sample.get('faces', [])
        for face in faces:
            x, y, w, h = [int(round(float(face.get(key, 0)))) for key in ('x', 'y', 'w', 'h')]
            track_id = face.get('track_id')
            predicted = bool(face.get('predicted'))
            is_active = track_id == active_id
            color = (0, 255, 0) if is_active else ((0, 215, 255) if predicted else (255, 180, 0))
            cv2.rectangle(frame, (x, y), (x + w, y + h), color, 4 if is_active else 2)
            draw_label(frame, f"ID {track_id}{' ACTIVE' if is_active else ''}{' PRED' if predicted else ''}", (x, max(22, y)), color)

        if final_mode == 'split_stack' and len(faces) >= 2:
            strongest = sorted(faces, key=lambda face: float(face.get('w', 0)) * float(face.get('h', 0)), reverse=True)[:2]
            for slot, face in enumerate(strongest, start=1):
                face_center = float(face.get('cx', float(face.get('x', 0)) + float(face.get('w', 0)) / 2.0))
                x, y, w, h = crop_rect(face_center, source_w, source_h)
                cv2.rectangle(frame, (x, y), (x + w, y + h), (255, 0, 255), 2)
                draw_label(frame, f'STACK SLOT {slot}', (x + 5, 45 + (slot - 1) * 26), (255, 0, 255))
        else:
            x, y, w, h = crop_rect(center_x, source_w, source_h)
            cv2.rectangle(frame, (x, y), (x + w, y + h), (255, 0, 255), 3)

        if len(path_points) > 1:
            cv2.polylines(frame, [__import__('numpy').array(path_points, dtype='int32')], False, (255, 255, 0), 2, cv2.LINE_AA)
        cv2.circle(frame, (int(round(center_x)), int(round(center_y))), 7, (0, 0, 255), -1)
        draw_label(frame, f"t={rel_t:06.2f}s layout={final_mode}/{sample.get('layout_mode', 'unknown')}", (12, source_h - 18), (255, 255, 255))
        if sample.get('scene_cut'):
            draw_label(frame, 'HARD CUT / TRACK RESET', (12, 32), (0, 0, 255))
        writer.write(frame)
        frame_index += 1

    cap.release()
    writer.release()
    ffmpeg = os.environ.get('FFMPEG_PATH', 'ffmpeg')
    command = [
        ffmpeg, '-y', '-i', str(silent_path), '-ss', str(start_sec), '-to', str(end_sec), '-i', input_path,
        '-map', '0:v:0', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', str(output),
    ]
    Path(command_path).write_text(subprocess.list2cmdline(command), encoding='utf-8')
    completed = subprocess.run(command, check=False)
    silent_path.unlink(missing_ok=True)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


if __name__ == '__main__':
    main()
