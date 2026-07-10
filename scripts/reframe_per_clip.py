#!/usr/bin/env python3
import json
import math
import os
import sys
from pathlib import Path
from typing import Optional, Tuple

DEBUG_FRAME_NAME = 'debug-still.jpg'
SAFE_EDGE_MARGIN_X = 0.10
MOTION_MIN_AREA_RATIO = 0.0035


def fail(code: int, error: str):
    print(json.dumps({"ok": False, "error": error}))
    sys.exit(code)


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def center(b: Tuple[float, float, float, float]) -> Tuple[float, float]:
    x, y, w, h = b
    return x + w / 2.0, y + h / 2.0


def motion_regions(cv2, prev_gray, gray, width: float, height: float):
    if prev_gray is None:
        return []
    diff = cv2.absdiff(prev_gray, gray)
    diff = cv2.GaussianBlur(diff, (7, 7), 0)
    _, thresh = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
    thresh = cv2.dilate(thresh, None, iterations=2)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = max(1200.0, width * height * MOTION_MIN_AREA_RATIO)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = float(w * h)
        if area < min_area:
            continue
        boxes.append((float(x), float(y), float(w), float(h)))
    boxes.sort(key=lambda b: b[2] * b[3], reverse=True)
    return boxes[:5]


def merge_subject_and_motion(subject_box: Optional[Tuple[float, float, float, float]], motion_box: Optional[Tuple[float, float, float, float]], width: float):
    if subject_box is None and motion_box is None:
        return width / 2.0, True
    if subject_box is None and motion_box is not None:
        mx, _ = center(motion_box)
        return mx, True
    if subject_box is not None and motion_box is None:
        sx, _ = center(subject_box)
        return sx, False

    sx, _ = center(subject_box)
    mx, _ = center(motion_box)
    subject_area = subject_box[2] * subject_box[3]
    motion_area = motion_box[2] * motion_box[3]
    if subject_area <= 0:
        return mx, True

    center_delta_norm = abs(mx - sx) / max(width, 1.0)
    if center_delta_norm <= 0.08:
        return sx * 0.78 + mx * 0.22, False
    if center_delta_norm <= 0.18:
        return sx * 0.88 + mx * 0.12, False
    return sx, False


def save_debug_frame(cv2, frame, out_path: Path, detected_box, motion_box, crop_box):
    img = frame.copy()
    if detected_box is not None:
        x, y, w, h = [int(round(v)) for v in detected_box]
        cv2.rectangle(img, (x, y), (x + w, y + h), (0, 255, 0), 3)
    if motion_box is not None:
        x, y, w, h = [int(round(v)) for v in motion_box]
        cv2.rectangle(img, (x, y), (x + w, y + h), (0, 200, 255), 2)
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
    sample_count = min(42, max(12, int(math.ceil(duration * 1.15))))
    sample_times = [start_sec + (duration * i / max(1, sample_count - 1)) for i in range(sample_count)]

    mp_face = mp.solutions.face_detection
    detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.45)
    body_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_upperbody.xml')

    centers_x = []
    points = []
    detected_faces = []
    first_debug_frame = None
    first_box = None
    first_motion_box = None
    prev_gray = None

    for sample_t in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, sample_t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            continue

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        result = detector.process(rgb)

        selected_box: Optional[Tuple[float, float, float, float]] = None
        motion_box: Optional[Tuple[float, float, float, float]] = None
        fallback_used = False

        faces = []
        if result.detections:
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

        motion_boxes = motion_regions(cv2, prev_gray, gray, source_w, source_h)
        prev_gray = gray
        if motion_boxes:
            motion_box = motion_boxes[0]

        detected_faces.append({
            'timestamp': round(sample_t - start_sec, 3),
            'faces': [{'x': f[0], 'y': f[1], 'w': f[2], 'h': f[3], 'cx': center(f)[0], 'cy': center(f)[1]} for f in faces[:4]],
        })

        chosen_center_x, motion_fallback_used = merge_subject_and_motion(selected_box, motion_box, source_w)
        fallback_used = fallback_used or motion_fallback_used
        chosen_center_x = clamp(chosen_center_x, source_w * SAFE_EDGE_MARGIN_X, source_w * (1.0 - SAFE_EDGE_MARGIN_X))

        if selected_box is not None:
            _, cy = center(selected_box)
            chosen_center_y = cy
        elif motion_box is not None:
            _, cy = center(motion_box)
            chosen_center_y = cy
        else:
            chosen_center_y = source_h / 2.0

        if selected_box is not None:
            subject_w = selected_box[2]
            subject_h = selected_box[3]
            mode = 'face'
            framing = 'single'
            normalized_x = (chosen_center_x / max(source_w, 1.0)) * 0.82 + 0.5 * 0.18
            face_top = selected_box[1] / max(source_h, 1.0)
            normalized_y = face_top + 0.08
        elif motion_box is not None:
            subject_w = motion_box[2]
            subject_h = motion_box[3]
            mode = 'motion'
            framing = 'single'
            normalized_x = chosen_center_x / max(source_w, 1.0)
            normalized_y = chosen_center_y / max(source_h, 1.0)
        else:
            subject_w = crop_w
            subject_h = crop_h
            mode = 'fallback'
            framing = 'single'
            normalized_x = 0.5
            normalized_y = 0.42

        normalized_x = clamp(normalized_x, 0.0, 1.0)
        normalized_y = clamp(normalized_y, 0.0, 1.0)
        rel_t = round(sample_t - start_sec, 3)

        centers_x.append({
            'timestamp': rel_t,
            'detected_face': None if selected_box is None else {
                'x': selected_box[0],
                'y': selected_box[1],
                'w': selected_box[2],
                'h': selected_box[3],
            },
            'motion_box': None if motion_box is None else {
                'x': motion_box[0],
                'y': motion_box[1],
                'w': motion_box[2],
                'h': motion_box[3],
            },
            'chosen_center_x': chosen_center_x,
            'chosen_center_y': chosen_center_y,
            'fallback_used': fallback_used,
        })
        points.append({
            't': rel_t,
            'cx': chosen_center_x,
            'cy': chosen_center_y,
            'nx': normalized_x,
            'ny': normalized_y,
            'w': subject_w,
            'h': subject_h,
            'framing': framing,
            'mode': mode,
        })

        if first_debug_frame is None:
            first_debug_frame = frame.copy()
            first_box = selected_box
            first_motion_box = motion_box

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
        save_debug_frame(cv2, first_debug_frame, debug_dir / f'{clip_id}-{DEBUG_FRAME_NAME}', first_box, first_motion_box, crop_box)

    dual_frames = 0
    for frame in detected_faces:
        faces = frame.get('faces', [])
        if len(faces) >= 2:
            faces = sorted(faces[:2], key=lambda f: f['cx'])
            separation = abs(faces[1]['cx'] - faces[0]['cx']) / max(source_w, 1.0)
            size_ratio = min(faces[0]['w'] * faces[0]['h'], faces[1]['w'] * faces[1]['h']) / max(1.0, max(faces[0]['w'] * faces[0]['h'], faces[1]['w'] * faces[1]['h']))
            if separation >= 0.18 and size_ratio >= 0.38:
                dual_frames += 1

    split_stack = dual_frames >= max(2, math.ceil(len(detected_faces) * 0.35))

    result = {
        'ok': True,
        'mode': 'split_stack' if split_stack else 'timeline',
        'source_w': source_w,
        'source_h': source_h,
        'crop_w': crop_w,
        'crop_h': crop_h,
        'detected_center_x': avg_center_x,
        'crop_x': crop_x,
        'fallback_used': fallback_used,
        'motion_enabled': True,
        'samples': centers_x,
        'points': points,
        'meta': {
            'points': len(points),
            'sample_count': sample_count,
            'average_face_center': {
                'x': clamp(avg_center_x / max(source_w, 1.0), 0.0, 1.0),
                'y': 0.42,
            },
            'fallback_used': fallback_used,
        },
        'detected_faces': detected_faces,
        'ffmpeg_crop': f'crop={crop_w}:{crop_h}:{int(round(crop_x))}:0,scale=1080:1920',
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
