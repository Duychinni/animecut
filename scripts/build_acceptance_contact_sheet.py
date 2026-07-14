#!/usr/bin/env python3
"""Build evidence contact sheets from rendered clips without altering footage."""
import json
import math
import sys


def main():
    if len(sys.argv) != 4:
        raise SystemExit('usage: build_acceptance_contact_sheet.py <manifest_json> <output_jpg> <filmstrip_dir>')
    manifest_path, output_path, filmstrip_dir = sys.argv[1:4]
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    from pathlib import Path

    manifest = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
    Path(filmstrip_dir).mkdir(parents=True, exist_ok=True)
    rows = []
    for clip in manifest['clips']:
        capture = cv2.VideoCapture(clip['final_mp4'])
        duration = float(clip['duration'])
        times = [duration * ratio for ratio in (0.02, 0.25, 0.50, 0.75, 0.96)]
        frames = []
        for timestamp in times:
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
            ok, frame = capture.read()
            if ok and frame is not None:
                frame = cv2.resize(frame, (180, 320), interpolation=cv2.INTER_AREA)
                cv2.putText(frame, f"{timestamp:.1f}s", (6, 312), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255,255,255), 1, cv2.LINE_AA)
                frames.append(frame)
        capture.release()
        thumb = cv2.imread(clip['thumbnail'])
        if thumb is not None:
            thumb = cv2.resize(thumb, (180, 320), interpolation=cv2.INTER_AREA)
            cv2.putText(thumb, 'THUMB', (6, 312), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0,255,255), 1, cv2.LINE_AA)
            frames.insert(0, thumb)
        row = np.hstack(frames)
        label = np.zeros((44, row.shape[1], 3), dtype=np.uint8)
        cv2.putText(label, f"{clip['rank']}. {clip['title'][:70]}", (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255,255,255), 1, cv2.LINE_AA)
        rows.append(np.vstack([label, row]))

        film_times = [index * 0.5 for index in range(max(1, int(math.ceil(duration / 0.5))))]
        film_frames = []
        capture = cv2.VideoCapture(clip['final_mp4'])
        for timestamp in film_times:
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
            ok, frame = capture.read()
            if not ok or frame is None: continue
            frame = cv2.resize(frame, (135, 240), interpolation=cv2.INTER_AREA)
            cv2.putText(frame, f"{timestamp:.1f}", (4, 232), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255,255,255), 1, cv2.LINE_AA)
            film_frames.append(frame)
        capture.release()
        columns = 10
        while len(film_frames) % columns:
            film_frames.append(np.zeros_like(film_frames[0]))
        film_rows = [np.hstack(film_frames[index:index+columns]) for index in range(0, len(film_frames), columns)]
        cv2.imwrite(str(Path(filmstrip_dir) / f"clip-{clip['rank']:02d}-filmstrip.jpg"), np.vstack(film_rows), [int(cv2.IMWRITE_JPEG_QUALITY), 92])

    width = max(row.shape[1] for row in rows)
    padded = [cv2.copyMakeBorder(row, 0, 0, 0, width-row.shape[1], cv2.BORDER_CONSTANT, value=(0,0,0)) for row in rows]
    cv2.imwrite(output_path, np.vstack(padded), [int(cv2.IMWRITE_JPEG_QUALITY), 94])


if __name__ == '__main__':
    main()
