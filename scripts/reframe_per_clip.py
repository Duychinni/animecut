#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
from typing import Optional, Tuple

DEBUG_FRAME_NAME = 'debug-still.jpg'


def fail(code: int, error: str):
    print(json.dumps({"ok": False, "error": error}))
    sys.exit(code)


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def center(b: Tuple[float, float, float, float]) -> Tuple[float, float]:
    x, y, w, h = b
    return x + w / 2.0, y + h / 2.0


def save_debug_frame(cv2, frame, out_path: Path, detected_box, crop_box):
    img = frame.copy()
    if detected_box is not None:
        x, y, w, h = [int(round(v)) for v in detected_box]
        cv2.rectangle(img, (x, y), (x + w, y + h), (0, 255, 0), 3)
    if crop_box is not None:
        x, y, w, h = [int(round(v)) for v in crop_box]
        cv2.rectangle(img, (x, y), (x + w, y + h), (255, 0, 0), 3)
    cv2.line(img, (img.shape[1] // 2, 0), (img.shape[1] // 2, img.shape[0]), (0, 0, 255), 2)
    cv2.imwrite(str(out_path), img)


def main():
    if len(sys.argv) < 4:
        fail(2, 'usage: reframe_per_clip.py <input_path> <start_sec> <end_sec>')

    input_path = sys.argv[1]
    start_sec = float(sys.argv[2])
    end_sec = float(sys.argv[3])

    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
    except Exception as exc:
        fail(1, f'dependency_unavailable:{exc}')

    clip_id = os.environ.get('SMART_REFRAME_DEBUG_CLIP_ID', 'unknown')
    debug_enabled = os.environ.get('SMART_REFRAME_DEBUG_EXPORT', 'false').lower() == 'true'
    debug_dir = Path(os.environ.get('SMART_REFRAME_DEBUG_DIR', f'{Path.cwd()}/tmp/reframe-debug'))
    debug_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        fail(1, 'video_open_failed')

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    source_w = float(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920.0)
    source_h = float(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080.0)
    crop_w = round(source_h * 9.0 / 16.0)
    crop_h = int(source_h)

    duration = max(0.01, end_sec - start_sec)
    sample_count = 10
    sample_times = [start_sec + (duration * i / max(1, sample_count - 1)) for i in range(sample_count)]

    mp_face = mp.solutions.face_detection
    detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.45)
    body_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_upperbody.xml')

    centers_x = []
    first_debug_frame = None
    first_box = None

    for sample_t in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, sample_t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            continue

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        result = detector.process(rgb)

        selected_box: Optional[Tuple[float, float, float, float]] = None
        fallback_used = False

        if result.detections:
            faces = []
            for det in result.detections:
                bbox = det.location_data.relative_bounding_box
                x = max(0.0, bbox.xmin * source_w)
                y = max(0.0, bbox.ymin * source_h)
                w = max(1.0, bbox.width * source_w)
                h = max(1.0, bbox.height * source_h)
                faces.append((x, y, w, h))
            faces.sort(key=lambda b: b[2] * b[3], reverse=True)
            selected_box = faces[0]
        else:
            bodies = [] if body_cascade.empty() else list(body_cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(80, 80)))
            if bodies:
                x, y, w, h = max(bodies, key=lambda b: b[2] * b[3])
                selected_box = (float(x), float(y), float(w), float(h))
                fallback_used = True

        if selected_box is None:
            continue

        cx, cy = center(selected_box)
        centers_x.append({
            'timestamp': round(sample_t - start_sec, 3),
            'detected_face': {
                'x': selected_box[0],
                'y': selected_box[1],
                'w': selected_box[2],
                'h': selected_box[3],
            },
            'chosen_center_x': cx,
            'chosen_center_y': cy,
            'fallback_used': fallback_used,
        })

        if first_debug_frame is None:
            first_debug_frame = frame.copy()
            first_box = selected_box

    cap.release()
    detector.close()

    if not centers_x:
        avg_center_x = source_w / 2.0
        fallback_used = True
    else:
        avg_center_x = sum(item['chosen_center_x'] for item in centers_x) / len(centers_x)
        fallback_used = any(item['fallback_used'] for item in centers_x)

    crop_x = clamp(avg_center_x - crop_w / 2.0, 0.0, source_w - crop_w)
    crop_box = (crop_x, 0.0, float(crop_w), float(crop_h))

    if debug_enabled and first_debug_frame is not None:
        save_debug_frame(cv2, first_debug_frame, debug_dir / f'{clip_id}-{DEBUG_FRAME_NAME}', first_box, crop_box)

    result = {
        'ok': True,
        'mode': 'per_clip',
        'source_w': source_w,
        'source_h': source_h,
        'crop_w': crop_w,
        'crop_h': crop_h,
        'detected_center_x': avg_center_x,
        'crop_x': crop_x,
        'fallback_used': fallback_used,
        'samples': centers_x,
        'ffmpeg_crop': f'crop={crop_w}:{crop_h}:{int(round(crop_x))}:0,scale=1080:1920',
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
