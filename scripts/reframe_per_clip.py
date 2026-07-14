#!/usr/bin/env python3
import json
import math
import os
import statistics
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple

DEBUG_FRAME_NAME = 'debug-still.jpg'
SAFE_EDGE_MARGIN_X = 0.10
MOTION_MIN_AREA_RATIO = 0.0035
AUDIO_SAMPLE_RATE = 16000
AUDIO_WINDOW_SEC = 0.18
SPEAKER_SWITCH_CONFIRM_SAMPLES = 2
FRAMING_SWITCH_CONFIRM_SAMPLES = 2
WIDE_FACE_HEIGHT_RATIO = 0.22
WIDE_FACE_WIDTH_RATIO = 0.105


def fail(code: int, error: str):
    print(json.dumps({"ok": False, "error": error}))
    sys.exit(code)


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def center(b: Tuple[float, float, float, float]) -> Tuple[float, float]:
    x, y, w, h = b
    return x + w / 2.0, y + h / 2.0


def box_match_score(a, b, width: float, height: float) -> float:
    if a is None or b is None:
        return 0.0
    acx, acy = center(a)
    bcx, bcy = center(b)
    distance = math.hypot((acx - bcx) / max(width, 1.0), (acy - bcy) / max(height, 1.0))
    size_ratio = min(a[2] * a[3], b[2] * b[3]) / max(1.0, max(a[2] * a[3], b[2] * b[3]))
    return clamp(1.0 - distance * 3.5, 0.0, 1.0) * 0.72 + size_ratio * 0.28


def mouth_motion_score(cv2, previous_gray, gray, face, previous_face=None) -> float:
    if previous_gray is None or face is None:
        return 0.0
    x, y, w, h = face
    px, py, pw, ph = previous_face if previous_face is not None else face
    # The lower-center face region captures lips/jaw while avoiding most eye and
    # hair movement. Comparing the same screen-space ROI also makes head motion
    # useful evidence without allowing it to decide the speaker by itself.
    x1 = int(clamp(x + w * 0.18, 0, gray.shape[1] - 1))
    x2 = int(clamp(x + w * 0.82, x1 + 1, gray.shape[1]))
    y1 = int(clamp(y + h * 0.52, 0, gray.shape[0] - 1))
    y2 = int(clamp(y + h * 0.94, y1 + 1, gray.shape[0]))
    current = gray[y1:y2, x1:x2]
    px1 = int(clamp(px + pw * 0.18, 0, previous_gray.shape[1] - 1))
    px2 = int(clamp(px + pw * 0.82, px1 + 1, previous_gray.shape[1]))
    py1 = int(clamp(py + ph * 0.52, 0, previous_gray.shape[0] - 1))
    py2 = int(clamp(py + ph * 0.94, py1 + 1, previous_gray.shape[0]))
    previous = previous_gray[py1:py2, px1:px2]
    if current.size == 0 or previous.size == 0:
        return 0.0
    if previous.shape != current.shape:
        previous = cv2.resize(previous, (current.shape[1], current.shape[0]), interpolation=cv2.INTER_LINEAR)
    diff = cv2.absdiff(current, previous)
    return clamp(float(diff.mean()) / 28.0, 0.0, 1.0)


def extract_audio_activity(input_path: str, start_sec: float, duration: float, sample_times):
    try:
        import numpy as np  # type: ignore
        ffmpeg = os.environ.get('FFMPEG_PATH', 'ffmpeg')
        command = [
            ffmpeg, '-hide_banner', '-loglevel', 'error', '-ss', str(max(0.0, start_sec)),
            '-t', str(max(0.01, duration)), '-i', input_path, '-vn', '-ac', '1',
            '-ar', str(AUDIO_SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
        ]
        completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=max(30, int(duration * 2)))
        if completed.returncode != 0 or not completed.stdout:
            return [0.0 for _ in sample_times], False
        pcm = np.frombuffer(completed.stdout, dtype=np.float32)
        half_window = max(1, int(AUDIO_WINDOW_SEC * AUDIO_SAMPLE_RATE / 2.0))
        rms_values = []
        for absolute_t in sample_times:
            sample_index = int(max(0.0, absolute_t - start_sec) * AUDIO_SAMPLE_RATE)
            lo = max(0, sample_index - half_window)
            hi = min(len(pcm), sample_index + half_window)
            window = pcm[lo:hi]
            rms_values.append(float(np.sqrt(np.mean(window * window))) if window.size else 0.0)
        if not rms_values or max(rms_values) <= 1e-7:
            return [0.0 for _ in sample_times], False
        noise_floor = float(np.percentile(rms_values, 20))
        speech_level = float(np.percentile(rms_values, 90))
        span = max(1e-6, speech_level - noise_floor)
        normalized = [clamp((value - noise_floor) / span, 0.0, 1.0) for value in rms_values]
        # A small temporal envelope avoids treating every syllable boundary as silence.
        activity = []
        for index, value in enumerate(normalized):
            neighbors = normalized[max(0, index - 1):min(len(normalized), index + 2)]
            activity.append(clamp(value * 0.65 + max(neighbors) * 0.35, 0.0, 1.0))
        return activity, True
    except Exception:
        return [0.0 for _ in sample_times], False


def scene_change_score(cv2, previous_gray, gray) -> float:
    if previous_gray is None:
        return 0.0
    small_previous = cv2.resize(previous_gray, (160, 90), interpolation=cv2.INTER_AREA)
    small_current = cv2.resize(gray, (160, 90), interpolation=cv2.INTER_AREA)
    return clamp(float(cv2.absdiff(small_previous, small_current).mean()) / 55.0, 0.0, 1.0)


def average_box(boxes):
    if not boxes:
        return None
    center_xs = [center(b)[0] for b in boxes]
    center_ys = [center(b)[1] for b in boxes]
    widths = [b[2] for b in boxes]
    heights = [b[3] for b in boxes]
    median_w = statistics.median(widths)
    median_h = statistics.median(heights)
    median_cx = statistics.median(center_xs)
    median_cy = statistics.median(center_ys)
    return (
        median_cx - median_w / 2.0,
        median_cy - median_h / 2.0,
        median_w,
        median_h,
    )


def build_single_subject_crop(source_w: float, source_h: float, avg_center_x: float, selected_boxes):
    avg_box = average_box(selected_boxes)
    if avg_box is None:
        crop_h = source_h
        crop_w = min(source_w, round(crop_h * 9.0 / 16.0))
        crop_x = clamp(avg_center_x - crop_w / 2.0, 0.0, max(0.0, source_w - crop_w))
        return crop_x, 0.0, float(crop_w), float(crop_h), None

    x, y, w, h = avg_box
    face_cx, _ = center(avg_box)

    # A face detector box is too small for shorts framing. Use the full source
    # height for the default 9:16 crop so 1080p horizontal sources are not
    # zoomed beyond the already-required vertical crop.
    crop_h = source_h
    crop_w = crop_h * 9.0 / 16.0

    if crop_w > source_w:
        crop_w = source_w
        crop_h = min(source_h, crop_w * 16.0 / 9.0)

    crop_x = clamp(face_cx - crop_w * 0.50, 0.0, max(0.0, source_w - crop_w))
    crop_y = clamp(y - crop_h * 0.08, 0.0, max(0.0, source_h - crop_h))
    return float(crop_x), float(crop_y), float(crop_w), float(crop_h), avg_box


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
    if len(sys.argv) == 2 and sys.argv[1] == '--health':
        try:
            import cv2  # type: ignore
            import mediapipe as mp  # type: ignore
            import numpy as np  # type: ignore
            detector = mp.solutions.face_detection.FaceDetection(
                model_selection=1,
                min_detection_confidence=0.45,
            )
            detector.close()
        except Exception as exc:
            fail(1, f'dependency_unavailable:{exc}')
        print(json.dumps({
            'ok': True,
            'python': sys.executable,
            'opencv': cv2.__version__,
            'mediapipe': mp.__version__,
            'numpy': np.__version__,
        }))
        return

    if len(sys.argv) < 4:
        fail(2, 'usage: reframe_per_clip.py <input_path> <start_sec> <end_sec> | --health')

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
    # Four observations per second is frequent enough to associate speech with
    # mouth motion and still bounded for long clips.
    sample_count = min(240, max(24, int(math.ceil(duration * 4.0))))
    sample_times = [start_sec + (duration * i / max(1, sample_count - 1)) for i in range(sample_count)]
    audio_activity, audio_available = extract_audio_activity(input_path, start_sec, duration, sample_times)

    mp_face = mp.solutions.face_detection
    detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.45)
    body_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_upperbody.xml')

    centers_x = []
    points = []
    detected_faces = []
    selected_subject_boxes = []
    first_debug_frame = None
    first_box = None
    first_motion_box = None
    prev_gray = None
    active_box = None
    pending_box = None
    pending_count = 0
    active_framing = 'single'
    pending_framing = None
    pending_framing_count = 0
    shot_id = 0
    speaker_switches = 0
    confident_speaker_samples = 0
    wide_context_samples = 0
    previous_faces = []

    for sample_index, sample_t in enumerate(sample_times):
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
        else:
            bodies = [] if body_cascade.empty() else list(body_cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(80, 80)))
            if bodies:
                x, y, w, h = max(bodies, key=lambda b: b[2] * b[3])
                selected_box = (float(x), float(y), float(w), float(h))
                fallback_used = True

        current_audio = audio_activity[sample_index] if sample_index < len(audio_activity) else 0.0
        scene_change = scene_change_score(cv2, prev_gray, gray)
        mouth_scores = []
        for face in faces:
            previous_match = max(previous_faces, key=lambda old: box_match_score(face, old, source_w, source_h)) if previous_faces else None
            if previous_match is not None and box_match_score(face, previous_match, source_w, source_h) < 0.24:
                previous_match = None
            mouth_scores.append(mouth_motion_score(cv2, prev_gray, gray, face, previous_match))

        selected_mouth_score = 0.0

        if faces:
            scored_faces = []
            for face, mouth_score in zip(faces, mouth_scores):
                area_quality = clamp((face[2] * face[3]) / max(1.0, source_w * source_h * 0.08), 0.0, 1.0)
                continuity = box_match_score(face, active_box, source_w, source_h)
                # Audio gates the mouth evidence. During silence continuity wins,
                # so the crop stays fixed instead of chasing incidental motion.
                continuity_weight = 0.52 - current_audio * 0.30
                score = area_quality * 0.14 + continuity * continuity_weight + mouth_score * current_audio * 0.88
                scored_faces.append((score, mouth_score, face))
            scored_faces.sort(key=lambda item: item[0], reverse=True)
            candidate_score, candidate_mouth, candidate_box = scored_faces[0]
            active_match = box_match_score(candidate_box, active_box, source_w, source_h)
            should_switch = active_box is not None and active_match < 0.48
            active_face = max(faces, key=lambda face: box_match_score(face, active_box, source_w, source_h)) if active_box is not None else None
            active_face_index = faces.index(active_face) if active_face in faces else -1
            active_mouth = mouth_scores[active_face_index] if active_face_index >= 0 else 0.0
            strong_speaker_evidence = (
                current_audio >= 0.28
                and candidate_mouth >= 0.12
                and (active_box is None or active_match >= 0.48 or candidate_mouth >= active_mouth + 0.045)
            )

            if active_box is None or scene_change >= 0.72:
                if active_box is not None:
                    shot_id += 1
                    speaker_switches += 1
                active_box = candidate_box
                pending_box = None
                pending_count = 0
            elif should_switch and strong_speaker_evidence:
                if box_match_score(candidate_box, pending_box, source_w, source_h) >= 0.58:
                    pending_count += 1
                else:
                    pending_box = candidate_box
                    pending_count = 1
                if pending_count >= SPEAKER_SWITCH_CONFIRM_SAMPLES:
                    active_box = candidate_box
                    pending_box = None
                    pending_count = 0
                    shot_id += 1
                    speaker_switches += 1
            else:
                # Refresh the tracked box using the best match to its previous location.
                best_continuation = max(faces, key=lambda face: box_match_score(face, active_box, source_w, source_h))
                if box_match_score(best_continuation, active_box, source_w, source_h) >= 0.32:
                    active_box = best_continuation
                pending_box = None
                pending_count = 0

            selected_box = active_box
            selected_index = max(range(len(faces)), key=lambda idx: box_match_score(faces[idx], selected_box, source_w, source_h))
            selected_mouth_score = mouth_scores[selected_index]
            if strong_speaker_evidence:
                confident_speaker_samples += 1

        motion_boxes = motion_regions(cv2, prev_gray, gray, source_w, source_h)
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
            selected_subject_boxes.append(selected_box)
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
            face_height_ratio = selected_box[3] / max(source_h, 1.0)
            face_width_ratio = selected_box[2] / max(source_w, 1.0)
            desired_framing = 'wide_context' if (
                face_height_ratio <= WIDE_FACE_HEIGHT_RATIO
                or face_width_ratio <= WIDE_FACE_WIDTH_RATIO
            ) else 'single'

            if desired_framing == active_framing:
                pending_framing = None
                pending_framing_count = 0
            else:
                if desired_framing == pending_framing:
                    pending_framing_count += 1
                else:
                    pending_framing = desired_framing
                    pending_framing_count = 1
                if pending_framing_count >= FRAMING_SWITCH_CONFIRM_SAMPLES:
                    active_framing = desired_framing
                    pending_framing = None
                    pending_framing_count = 0
                    shot_id += 1

            framing = active_framing
            if framing == 'wide_context':
                wide_context_samples += 1
            normalized_x = chosen_center_x / max(source_w, 1.0)
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
            'shot_id': shot_id,
            'cut': bool(points and points[-1].get('shot_id') != shot_id),
            'audio_activity': round(current_audio, 4),
            'speaker_confidence': round(selected_mouth_score * current_audio, 4),
            'scene_change': round(scene_change, 4),
        })

        prev_gray = gray
        previous_faces = faces

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

    crop_x, crop_y, crop_w, crop_h, avg_subject_box = build_single_subject_crop(source_w, source_h, avg_center_x, selected_subject_boxes)
    crop_box = (crop_x, crop_y, float(crop_w), float(crop_h))

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

    # Preserve the legacy two-up layout only when active-speaker evidence is not
    # available. With reliable audio/visual evidence, speaker-directed cuts are
    # more natural and retain more detail than permanently shrinking both faces.
    split_stack = (
        dual_frames >= max(2, math.ceil(len(detected_faces) * 0.35))
        and (not audio_available or confident_speaker_samples < max(3, len(points) * 0.08))
    )

    result = {
        'ok': True,
        'mode': 'split_stack' if split_stack else 'per_clip',
        'source_w': source_w,
        'source_h': source_h,
        'crop_w': crop_w,
        'crop_h': crop_h,
        'detected_center_x': avg_center_x,
        'crop_x': crop_x,
        'crop_y': crop_y,
        'fallback_used': fallback_used,
        'motion_enabled': True,
        'samples': centers_x,
        'points': points,
        'meta': {
            'points': len(points),
            'sample_count': sample_count,
            'frames_with_detection_pct': len(selected_subject_boxes) / max(1, len(sample_times)),
            'average_face_center': {
                'x': clamp(avg_center_x / max(source_w, 1.0), 0.0, 1.0),
                'y': 0.42,
            },
            'average_subject_box': None if avg_subject_box is None else {
                'x': avg_subject_box[0],
                'y': avg_subject_box[1],
                'w': avg_subject_box[2],
                'h': avg_subject_box[3],
            },
            'fallback_used': fallback_used,
            'audio_available': audio_available,
            'speaker_switches': speaker_switches,
            'confident_speaker_samples': confident_speaker_samples,
            'wide_context_samples': wide_context_samples,
            'analysis_rate_fps': sample_count / duration,
        },
        'detected_faces': detected_faces,
        'ffmpeg_crop': f'crop={int(round(crop_w))}:{int(round(crop_h))}:{int(round(crop_x))}:{int(round(crop_y))},scale=1080:1920',
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
