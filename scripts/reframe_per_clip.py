#!/usr/bin/env python3
import json
import math
import os
import statistics
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple

from editorial_layout_planner import plan_editorial_timeline
from layout_qa import validate_layout_timeline

DEBUG_FRAME_NAME = 'debug-still.jpg'
SAFE_EDGE_MARGIN_X = 0.10
FACE_SOURCE_EDGE_MARGIN_RATIO = 0.012
FACE_SOURCE_TOP_MARGIN_RATIO = 0.008
UNSAFE_FACE_REJECT_RATIO = 0.35
MOTION_MIN_AREA_RATIO = 0.0035
AUDIO_SAMPLE_RATE = 16000
AUDIO_WINDOW_SEC = 0.18
SPEAKER_SWITCH_CONFIRM_SAMPLES = 2
FRAMING_SWITCH_CONFIRM_SAMPLES = 2
LAYOUT_MIN_HOLD_SAMPLES = 4
LAYOUT_CONFIRM_SAMPLES = 2
STACK_PAIR_CONFIRM_SAMPLES = 4
STACK_ENTER_CONFIRM_SAMPLES = 4
STACK_PARTICIPATION_WINDOW_SEC = 6.0
STACK_TURN_WINDOW_SEC = 4.5
STACK_REACTION_WINDOW_SEC = 3.0
STACK_MIN_RAPID_SWITCHES = 2
STACK_SCORE_MARGIN = 0.15
STACK_LAYOUT_ENABLED = True
SCENE_CUT_LOOKAHEAD_SEC = 0.25
WIDE_FACE_HEIGHT_RATIO = 0.22
WIDE_FACE_WIDTH_RATIO = 0.105
FIXED_LAYOUT_MODE = 'FIXED_TWO_REGION_CONVERSATION'
LEGACY_FIXED_LAYOUT_MODE = 'FIXED_TWO_PANEL_INTERVIEW'
FIXED_SPEAKER_CONFIDENCE = float(os.getenv('FIXED_SPEAKER_CONFIDENCE', '0.42'))
FIXED_SPEAKER_MARGIN = float(os.getenv('FIXED_SPEAKER_MARGIN', '0.08'))
FIXED_UNCERTAINTY_HOLD_SEC = float(os.getenv('FIXED_UNCERTAINTY_HOLD_SEC', '0.55'))
FIXED_MIN_CONFIRMED_TURN_SEC = float(os.getenv('FIXED_MIN_CONFIRMED_TURN_SEC', '0.45'))
SILENCE_AUDIO_THRESHOLD = float(os.getenv('SILENCE_AUDIO_THRESHOLD', '0.10'))
SILENCE_HOLD_SEC = float(os.getenv('SILENCE_HOLD_SEC', '1.20'))
SILENCE_WIDEN_SEC = float(os.getenv('SILENCE_WIDEN_SEC', '1.00'))


def fail(code: int, error: str):
    print(json.dumps({"ok": False, "error": error}))
    sys.exit(code)


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def center(b: Tuple[float, float, float, float]) -> Tuple[float, float]:
    x, y, w, h = b
    return x + w / 2.0, y + h / 2.0


def face_source_completeness(face, source_w: float, source_h: float) -> float:
    """Return how safely a detected face clears the source-frame edges.

    A detector box touching the source edge usually means the source itself
    contains only part of that person's face. No crop movement can recover
    pixels that are not present, so those detections must not become camera
    targets.
    """
    x, y, w, h = (float(value) for value in face[:4])
    horizontal_margin = min(x, source_w - (x + w))
    top_margin = y
    horizontal_required = max(2.0, source_w * FACE_SOURCE_EDGE_MARGIN_RATIO)
    top_required = max(2.0, source_h * FACE_SOURCE_TOP_MARGIN_RATIO)
    horizontal_score = clamp(horizontal_margin / horizontal_required, 0.0, 1.0)
    top_score = clamp(top_margin / top_required, 0.0, 1.0)
    return min(horizontal_score, top_score)


def face_is_complete_in_source(face, source_w: float, source_h: float) -> bool:
    return face_source_completeness(face, source_w, source_h) >= 1.0


def box_match_score(a, b, width: float, height: float) -> float:
    if a is None or b is None:
        return 0.0
    acx, acy = center(a)
    bcx, bcy = center(b)
    distance = math.hypot((acx - bcx) / max(width, 1.0), (acy - bcy) / max(height, 1.0))
    size_ratio = min(a[2] * a[3], b[2] * b[3]) / max(1.0, max(a[2] * a[3], b[2] * b[3]))
    return clamp(1.0 - distance * 3.5, 0.0, 1.0) * 0.72 + size_ratio * 0.28


def box_iou(a, b) -> float:
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    intersection = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))
    union = aw * ah + bw * bh - intersection
    return intersection / max(1.0, union)


def dedupe_boxes(boxes):
    kept = []
    for box in sorted(boxes, key=lambda item: item[2] * item[3], reverse=True):
        duplicate = False
        for existing in kept:
            box_cx, box_cy = center(box)
            existing_cx, existing_cy = center(existing)
            center_distance = math.hypot(box_cx - existing_cx, box_cy - existing_cy)
            size_reference = max(box[2], box[3], existing[2], existing[3], 1.0)
            size_ratio = min(box[2] * box[3], existing[2] * existing[3]) / max(1.0, max(box[2] * box[3], existing[2] * existing[3]))
            if box_iou(box, existing) >= 0.34 or (center_distance <= size_reference * 0.28 and size_ratio >= 0.34):
                duplicate = True
                break
        if duplicate:
            continue
        kept.append(box)
    return kept


def create_face_track(cv2, np, track_id: int, box):
    kalman = cv2.KalmanFilter(8, 4)
    kalman.transitionMatrix = np.array([
        [1, 0, 0, 0, 1, 0, 0, 0],
        [0, 1, 0, 0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0, 0, 1, 0],
        [0, 0, 0, 1, 0, 0, 0, 1],
        [0, 0, 0, 0, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 1, 0, 0],
        [0, 0, 0, 0, 0, 0, 1, 0],
        [0, 0, 0, 0, 0, 0, 0, 1],
    ], dtype=np.float32)
    kalman.measurementMatrix = np.zeros((4, 8), dtype=np.float32)
    kalman.measurementMatrix[:4, :4] = np.eye(4, dtype=np.float32)
    kalman.processNoiseCov = np.eye(8, dtype=np.float32) * 0.035
    kalman.measurementNoiseCov = np.eye(4, dtype=np.float32) * 0.18
    kalman.errorCovPost = np.eye(8, dtype=np.float32)
    kalman.statePost = np.array([[box[0]], [box[1]], [box[2]], [box[3]], [0], [0], [0], [0]], dtype=np.float32)
    return {
        'id': track_id,
        'kalman': kalman,
        'box': box,
        'hits': 1,
        'missed': 0,
        'observed': True,
    }


def clamp_track_box(box, width: float, height: float):
    x, y, w, h = box
    w = clamp(float(w), 8.0, max(8.0, width))
    h = clamp(float(h), 8.0, max(8.0, height))
    x = clamp(float(x), 0.0, max(0.0, width - w))
    y = clamp(float(y), 0.0, max(0.0, height - h))
    return (x, y, w, h)


def update_face_tracks(cv2, np, tracks, detections, next_track_id: int, width: float, height: float):
    for track in tracks:
        predicted = track['kalman'].predict().reshape(-1)
        track['box'] = clamp_track_box(tuple(float(value) for value in predicted[:4]), width, height)
        track['observed'] = False

    candidates = []
    for track_index, track in enumerate(tracks):
        for detection_index, detection in enumerate(detections):
            continuity = box_match_score(track['box'], detection, width, height)
            overlap = box_iou(track['box'], detection)
            association_score = continuity * 0.72 + overlap * 0.28
            if association_score >= 0.24:
                candidates.append((association_score, track_index, detection_index))
    candidates.sort(reverse=True)

    matched_tracks = set()
    matched_detections = set()
    for _, track_index, detection_index in candidates:
        if track_index in matched_tracks or detection_index in matched_detections:
            continue
        track = tracks[track_index]
        detection = detections[detection_index]
        measurement = np.array(detection, dtype=np.float32).reshape(4, 1)
        corrected = track['kalman'].correct(measurement).reshape(-1)
        track['box'] = clamp_track_box(tuple(float(value) for value in corrected[:4]), width, height)
        track['hits'] += 1
        track['missed'] = 0
        track['observed'] = True
        matched_tracks.add(track_index)
        matched_detections.add(detection_index)

    for track_index, track in enumerate(tracks):
        if track_index not in matched_tracks:
            track['missed'] += 1

    for detection_index, detection in enumerate(detections):
        if detection_index in matched_detections:
            continue
        tracks.append(create_face_track(cv2, np, next_track_id, detection))
        next_track_id += 1

    tracks = [track for track in tracks if track['missed'] <= 4]
    visible_tracks = [track for track in tracks if track['hits'] >= 2 or track['observed']]
    visible_tracks.sort(key=lambda track: track['box'][2] * track['box'][3], reverse=True)
    return tracks, visible_tracks, next_track_id


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


def person_box_from_face(face, source_w: float, source_h: float):
    """Estimate a stable head-and-shoulders/person anchor from a face box."""
    x, y, w, h = face
    person_w = min(source_w, w * 2.8)
    person_h = min(source_h, h * 4.4)
    person_x = clamp(x + w * 0.5 - person_w * 0.5, 0.0, max(0.0, source_w - person_w))
    person_y = clamp(y - h * 0.28, 0.0, max(0.0, source_h - person_h))
    return (float(person_x), float(person_y), float(person_w), float(person_h))


def portrait_crop_for_face(face, source_w: float, source_h: float):
    crop_h = source_h
    crop_w = min(source_w, crop_h * 9.0 / 16.0)
    if crop_w >= source_w:
        crop_w = source_w
        crop_h = min(source_h, crop_w * 16.0 / 9.0)
    face_cx, _ = center(face)
    # Keep a little look-room while maintaining a 10% horizontal face margin.
    crop_x = clamp(face_cx - crop_w * 0.5, 0.0, max(0.0, source_w - crop_w))
    crop_y = clamp(face[1] - crop_h * 0.08, 0.0, max(0.0, source_h - crop_h))
    return {
        'x': round(float(crop_x), 3),
        'y': round(float(crop_y), 3),
        'w': round(float(crop_w), 3),
        'h': round(float(crop_h), 3),
        'cx': round(float(crop_x + crop_w / 2.0), 3),
        'cy': round(float(crop_y + crop_h / 2.0), 3),
        'zoom': round(float(source_h / max(crop_h, 1.0)), 4),
    }


def portrait_crop_for_subject(subject, source_w: float, source_h: float, subject_kind='person', face_box=None, velocity_x=0.0):
    """Create a semantic 9:16 crop in source coordinates.

    Faces target an eye line near 38% of the output. Bodies/actions keep more
    vertical context and receive a small amount of lead room in the direction
    of travel. The crop is always clamped to the source and never assumes that
    the source midpoint is meaningful.
    """
    x, y, w, h = (float(value) for value in subject)
    crop_h = float(source_h)
    crop_w = min(float(source_w), crop_h * 9.0 / 16.0)
    if crop_w >= source_w:
        crop_w = float(source_w)
        crop_h = min(float(source_h), crop_w * 16.0 / 9.0)

    subject_cx = x + w * 0.5
    lead = clamp(float(velocity_x) * 0.16, -crop_w * 0.12, crop_w * 0.12)
    target_cx = subject_cx + lead

    if face_box is not None:
        fx, fy, fw, fh = (float(value) for value in face_box)
        eye_y = fy + fh * 0.38
        crop_y = eye_y - crop_h * 0.38
    elif subject_kind in ('body', 'person'):
        # Keep the top of the body comfortably below the canvas edge while
        # preserving hands and lower-body action whenever the source permits.
        crop_y = y - crop_h * 0.07
    else:
        crop_y = y + h * 0.5 - crop_h * 0.5

    crop_x = clamp(target_cx - crop_w * 0.5, 0.0, max(0.0, source_w - crop_w))
    crop_y = clamp(crop_y, 0.0, max(0.0, source_h - crop_h))
    return {
        'x': round(float(crop_x), 3),
        'y': round(float(crop_y), 3),
        'w': round(float(crop_w), 3),
        'h': round(float(crop_h), 3),
        'cx': round(float(crop_x + crop_w / 2.0), 3),
        'cy': round(float(crop_y + crop_h / 2.0), 3),
        'zoom': round(float(source_h / max(crop_h, 1.0)), 4),
    }


def saliency_region(cv2, np, gray, width: float, height: float):
    """Return a conservative visual focal region without optional CV modules."""
    if gray is None or gray.size == 0:
        return None, 0.0
    reduced_w = min(640, gray.shape[1])
    scale = reduced_w / max(1.0, float(gray.shape[1]))
    reduced = gray if scale >= 0.999 else cv2.resize(
        gray,
        (reduced_w, max(2, int(round(gray.shape[0] * scale)))),
        interpolation=cv2.INTER_AREA,
    )
    blurred = cv2.GaussianBlur(reduced, (0, 0), 4.0)
    detail = cv2.absdiff(reduced, blurred)
    gx = cv2.Sobel(reduced, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(reduced, cv2.CV_32F, 0, 1, ksize=3)
    energy = detail.astype('float32') + cv2.magnitude(gx, gy) * 0.35
    threshold = float(np.percentile(energy, 88.0))
    if threshold <= 1.0:
        return None, 0.0
    mask = (energy >= threshold).astype('uint8') * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), dtype='uint8'))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, 0.0
    contour = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(contour)
    area_ratio = (w * h) / max(1.0, reduced.shape[0] * reduced.shape[1])
    if area_ratio < 0.008:
        return None, 0.0
    inverse = 1.0 / max(scale, 1e-6)
    box = (float(x * inverse), float(y * inverse), float(w * inverse), float(h * inverse))
    confidence = clamp(area_ratio * 3.2, 0.12, 0.72)
    return box, float(confidence)


def screen_context_score(cv2, np, gray):
    """Estimate whether a shot is text/UI-heavy and unsafe to crop tightly."""
    if gray is None or gray.size == 0:
        return 0.0
    reduced = cv2.resize(gray, (min(640, gray.shape[1]), max(2, int(gray.shape[0] * min(640, gray.shape[1]) / gray.shape[1]))), interpolation=cv2.INTER_AREA)
    edges = cv2.Canny(reduced, 70, 170)
    edge_density = float(np.count_nonzero(edges)) / max(1.0, float(edges.size))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180.0, threshold=45, minLineLength=max(20, reduced.shape[1] // 12), maxLineGap=8)
    line_density = min(1.0, (0 if lines is None else len(lines)) / 45.0)
    return clamp(edge_density * 3.6 + line_density * 0.42, 0.0, 1.0)


def semantic_subject_choice(face_box=None, body_box=None, motion_box=None, saliency_box=None,
                            speaker_confidence=0.0, saliency_confidence=0.0,
                            screen_score=0.0, prior=None, scene_cut=False):
    """Choose the ROI using the production semantic priority hierarchy."""
    if screen_score >= 0.58 and face_box is None and body_box is None:
        return {'kind': 'context', 'box': None, 'confidence': screen_score, 'reason': 'screen_or_text_context', 'predicted': False}
    if face_box is not None:
        confidence = max(0.62, float(speaker_confidence))
        reason = 'confident_active_speaker' if speaker_confidence >= 0.42 else 'main_visible_face'
        return {'kind': 'face', 'box': face_box, 'face_box': face_box, 'confidence': confidence, 'reason': reason, 'predicted': False}
    if body_box is not None:
        return {'kind': 'body', 'box': body_box, 'confidence': 0.58, 'reason': 'main_visible_person', 'predicted': False}
    if motion_box is not None:
        return {'kind': 'action', 'box': motion_box, 'confidence': 0.48, 'reason': 'primary_motion_or_action', 'predicted': False}
    if saliency_box is not None and saliency_confidence >= 0.18:
        return {'kind': 'saliency', 'box': saliency_box, 'confidence': saliency_confidence, 'reason': 'visual_saliency', 'predicted': False}
    if prior is not None and not scene_cut and prior.get('box') is not None:
        return {**prior, 'confidence': max(0.12, float(prior.get('confidence', 0.0)) * 0.82), 'reason': 'short_detection_hold', 'predicted': True}
    return {'kind': 'context', 'box': None, 'confidence': 0.0, 'reason': 'no_reliable_visual_subject', 'predicted': False}


def portrait_crop_for_face_in_panel(face, source_w: float, source_h: float, panel_left: float, panel_right: float):
    """Build a source-coordinate crop that can never cross a fixed panel boundary."""
    panel_left = clamp(float(panel_left), 0.0, source_w)
    panel_right = clamp(float(panel_right), panel_left + 2.0, source_w)
    panel_width = panel_right - panel_left
    crop_h = source_h
    crop_w = min(panel_width, crop_h * 9.0 / 16.0)
    if crop_w >= panel_width:
        crop_w = panel_width
        crop_h = min(source_h, crop_w * 16.0 / 9.0)
    face_cx, _ = center(face)
    crop_x = clamp(face_cx - crop_w * 0.5, panel_left, max(panel_left, panel_right - crop_w))
    crop_y = clamp(face[1] - crop_h * 0.08, 0.0, max(0.0, source_h - crop_h))
    return {
        'x': round(float(crop_x), 3),
        'y': round(float(crop_y), 3),
        'w': round(float(crop_w), 3),
        'h': round(float(crop_h), 3),
        'cx': round(float(crop_x + crop_w / 2.0), 3),
        'cy': round(float(crop_y + crop_h / 2.0), 3),
        'zoom': round(float(source_h / max(crop_h, 1.0)), 4),
    }


def vertical_divider_candidate(cv2, np, gray):
    """Return the strongest central, full-height vertical divider candidate."""
    if gray is None or gray.size == 0:
        return None, 0.0
    reduced_h = min(360, gray.shape[0])
    scale = reduced_h / max(1.0, float(gray.shape[0]))
    reduced = cv2.resize(gray, (max(2, int(round(gray.shape[1] * scale))), reduced_h), interpolation=cv2.INTER_AREA)
    gradient = np.abs(cv2.Sobel(reduced, cv2.CV_32F, 1, 0, ksize=3))
    profile = np.mean(gradient, axis=0)
    lo = int(round(reduced.shape[1] * 0.30))
    hi = int(round(reduced.shape[1] * 0.70))
    if hi - lo < 4:
        return None, 0.0
    central = profile[lo:hi]
    peak_offset = int(np.argmax(central))
    peak = float(central[peak_offset])
    baseline = float(np.median(central))
    spread = float(np.std(central))
    confidence = max(0.0, (peak - baseline) / max(1.0, spread))
    return float((lo + peak_offset) / max(scale, 1e-6)), confidence


def detect_fixed_two_panel_layout(frames, source_w: float, source_h: float):
    """Detect a persistent split interview without treating any two faces as panels."""
    divider_samples = [
        (float(frame.get('divider_x')), float(frame.get('divider_confidence', 0.0)))
        for frame in frames
        if frame.get('divider_x') is not None and float(frame.get('divider_confidence', 0.0)) >= 2.0
    ]
    divider_x = None
    divider_mad = None
    detection_method = 'divider'
    if len(divider_samples) >= max(3, int(len(frames) * 0.35)):
        candidate = float(statistics.median(sample[0] for sample in divider_samples))
        candidate_mad = float(statistics.median(abs(sample[0] - candidate) for sample in divider_samples))
        if source_w * 0.30 <= candidate <= source_w * 0.70 and candidate_mad <= source_w * 0.018:
            divider_x = candidate
            divider_mad = candidate_mad

    # Some interview sources have no visible gutter. Persistent, well-separated
    # tracks still define two stable source regions; this is classification,
    # never permission to crop their combined midpoint.
    if divider_x is None:
        track_samples = {}
        for frame in frames:
            for face in frame.get('faces', []):
                if face.get('track_id') is None or bool(face.get('predicted')):
                    continue
                if float(face.get('h', 0.0)) < source_h * 0.13:
                    continue
                track_samples.setdefault(int(face['track_id']), []).append(float(face.get('cx', 0.0)))
        persistent = [
            (track_id, statistics.median(samples), len(samples))
            for track_id, samples in track_samples.items()
            if len(samples) >= max(3, int(len(frames) * 0.45))
        ]
        separated = [
            (left, right) for left in persistent for right in persistent
            if left[0] != right[0] and left[1] < right[1] and right[1] - left[1] >= source_w * 0.30
        ]
        if not separated:
            return None
        left_track, right_track = max(separated, key=lambda pair: pair[0][2] + pair[1][2])
        divider_x = (float(left_track[1]) + float(right_track[1])) / 2.0
        divider_mad = 0.0
        detection_method = 'persistent_tracks'

    both_sides = 0
    eligible = 0
    left_ids = set()
    right_ids = set()
    for frame in frames:
        faces = [
            face for face in frame.get('faces', [])
            if not face.get('predicted') and float(face.get('h', 0.0)) >= source_h * 0.13
        ]
        if not faces:
            continue
        eligible += 1
        left = [face for face in faces if float(face.get('cx', 0.0)) < divider_x - source_w * 0.025]
        right = [face for face in faces if float(face.get('cx', 0.0)) > divider_x + source_w * 0.025]
        if left and right:
            both_sides += 1
            left_ids.update(int(face['track_id']) for face in left if face.get('track_id') is not None)
            right_ids.update(int(face['track_id']) for face in right if face.get('track_id') is not None)
    persistence = both_sides / max(1, eligible)
    if persistence < 0.45 or not left_ids or not right_ids:
        return None

    gutter = max(4.0, source_w * 0.012)
    return {
        'mode': FIXED_LAYOUT_MODE,
        'divider_x': round(divider_x, 3),
        'divider_mad': round(divider_mad, 3),
        'left_region': [0.0, round(max(2.0, divider_x - gutter), 3)],
        'right_region': [round(min(source_w - 2.0, divider_x + gutter), 3), round(source_w, 3)],
        'dual_face_persistence': round(persistence, 4),
        'left_track_ids': sorted(left_ids),
        'right_track_ids': sorted(right_ids),
        'track_region_map': {
            **{str(track_id): 'left' for track_id in sorted(left_ids)},
            **{str(track_id): 'right' for track_id in sorted(right_ids)},
        },
        'detection_method': detection_method,
    }


def dict_box(box):
    if box is None:
        return None
    return {
        'x': round(float(box[0]), 3),
        'y': round(float(box[1]), 3),
        'w': round(float(box[2]), 3),
        'h': round(float(box[3]), 3),
        'cx': round(float(center(box)[0]), 3),
        'cy': round(float(center(box)[1]), 3),
    }


def strongest_face_pair(faces, source_w: float):
    best = None
    best_score = -1.0
    for first_index in range(len(faces)):
        for second_index in range(first_index + 1, len(faces)):
            first = faces[first_index]
            second = faces[second_index]
            first_area = max(1.0, float(first.get('w', 0)) * float(first.get('h', 0)))
            second_area = max(1.0, float(second.get('w', 0)) * float(second.get('h', 0)))
            separation = abs(float(first.get('cx', 0)) - float(second.get('cx', 0))) / max(source_w, 1.0)
            size_ratio = min(first_area, second_area) / max(first_area, second_area)
            if separation < 0.14 or size_ratio < 0.22:
                continue
            score = (first_area + second_area) * (0.7 + min(0.3, separation)) * (0.72 + size_ratio * 0.28)
            if score > best_score:
                best_score = score
                best = (first, second)
    if best is None:
        return None
    return tuple(sorted(best, key=lambda item: float(item.get('cx', 0))))


def build_reframe_timeline(points, frames, source_w: float, source_h: float, duration: float):
    """Convert 4 Hz observations into a hysteretic, timed layout state machine."""
    if not points or not frames:
        return []

    portrait_source = source_h > source_w * 1.18
    decisions = []
    current_mode = 'source_vertical' if portrait_source else 'single'
    current_grid_template = None
    current_key = None
    current_pair = None
    pending_mode = None
    pending_count = 0
    held_samples = LAYOUT_MIN_HOLD_SAMPLES
    pair_streak = 0
    last_pair_ids = None
    recent_active_ids = []
    participation_history = []
    reaction_history = []
    contextual_shot_latched = False
    talking_head_release_streak = 0
    wide_pair_hold_ids = None
    wide_pair_hold_faces = None
    wide_pair_miss_streak = 0
    fixed_last_confident_track = None
    fixed_last_confident_panel = None
    fixed_last_confident_time = -1e9
    conversation_last_track = None
    silence_started_at = None
    previous_silence_elapsed = 0.0

    for index, (point, frame) in enumerate(zip(points, frames)):
        faces = frame.get('faces', [])
        complete_faces = [
            face for face in faces
            if face_is_complete_in_source(
                (
                    float(face.get('x', 0.0)), float(face.get('y', 0.0)),
                    float(face.get('w', 0.0)), float(face.get('h', 0.0)),
                ),
                source_w,
                source_h,
            )
        ]
        active_id = frame.get('active_track_id')
        speaker_confidence = float(point.get('speaker_confidence', 0.0))
        audio_activity = float(point.get('audio_activity', 0.0))
        scene_cut = bool(frame.get('scene_cut'))
        semantic_subject = frame.get('semantic_subject') or {}
        selected = semantic_subject.get('box') or frame.get('selected_box')
        subject_kind = str(
            point.get('subject_kind')
            or semantic_subject.get('kind')
            or ('face' if selected is not None else 'context')
        )
        subject_confidence = float(
            point.get('subject_confidence', semantic_subject.get('confidence', speaker_confidence))
        )
        selection_reason = str(
            point.get('selection_reason')
            or semantic_subject.get('reason')
            or ('active_face' if subject_kind == 'face' else 'safe_full_frame')
        )
        subject_predicted = bool(
            point.get('subject_predicted', semantic_subject.get('predicted', False))
        )
        subject_velocity_x = float(
            point.get('subject_velocity_x', semantic_subject.get('velocity_x', 0.0))
        )
        subject_stable_id = str(
            point.get('subject_stable_id')
            or semantic_subject.get('stable_id')
            or (f'face:{active_id}' if active_id is not None else subject_kind)
        )
        fixed_two_panel = frame.get('fixed_two_panel')
        complete_face_by_id = {
            int(face.get('track_id')): face
            for face in complete_faces
            if face.get('track_id') is not None
        }
        if subject_kind == 'face' and active_id is not None and int(active_id) not in complete_face_by_id:
            # Prefer camera movement to another complete person over holding a
            # source-edge half face. If nobody complete is visible, fail closed
            # to context; metadata below marks sustained cases for rejection.
            replacement = max(
                complete_faces,
                key=lambda face: (
                    float(face.get('active_speaker_confidence', 0.0)),
                    float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
                ),
                default=None,
            )
            if replacement is not None:
                active_id = int(replacement.get('track_id'))
                selected = replacement
                subject_stable_id = f'face:{active_id}'
                selection_reason = 'complete_face_replacement'
                subject_confidence = max(0.32, float(replacement.get('active_speaker_confidence', 0.0)))
            else:
                active_id = None
                selected = None
                subject_kind = 'context'
                subject_stable_id = 'context'
                subject_confidence = 0.0
                selection_reason = 'only_partial_faces_visible'
        face_by_id = complete_face_by_id
        speaker_score_margin = float(point.get('speaker_score_margin', frame.get('speaker_score_margin', 0.0)))
        pair = strongest_face_pair(complete_faces, source_w)
        pair_ids = None if pair is None else tuple(int(face.get('track_id')) for face in pair)

        # A conversation composition is a visual decision, not an editorial
        # stacked-layout decision. Ignore predicted and tiny incidental faces,
        # then keep the two dominant faces only when they occupy distinct
        # horizontal regions of the source frame. This handles pre-composed
        # podcast panels without letting logos/audience faces force the mode.
        visible_faces = [
            face for face in complete_faces
            if not bool(face.get('predicted')) and face.get('track_id') is not None
        ]
        layout_faces = sorted(
            (
                face for face in visible_faces
                if float(face.get('h', 0.0)) >= source_h * 0.085
            ),
            key=lambda face: (
                1 if active_id is not None and int(face.get('track_id')) == int(active_id) else 0,
                float(face.get('active_speaker_confidence', 0.0)),
                float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
            ),
            reverse=True,
        )[:4]
        dominant_faces = sorted(
            (face for face in layout_faces if float(face.get('h', 0.0)) >= source_h * 0.15),
            key=lambda face: float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
            reverse=True,
        )[:2]
        visual_pair = None
        # A third or fourth visible participant must not automatically create a
        # two-column layout. In group shots the active-speaker crop remains the
        # default; safe-wide is reserved for genuinely tiny/uncertain faces.
        if len(dominant_faces) == 2 and len(layout_faces) == 2:
            dominant_faces = sorted(dominant_faces, key=lambda face: float(face.get('cx', 0.0)))
            horizontal_separation = abs(
                float(dominant_faces[1].get('cx', 0.0)) - float(dominant_faces[0].get('cx', 0.0))
            )
            if horizontal_separation >= source_w * 0.24:
                visual_pair = tuple(dominant_faces)

        # Podcast/interview footage must never fall back to a portrait crop
        # centered between two people. When speaker evidence is uncertain,
        # keep the last framed participant; on first acquisition choose the
        # strongest complete visible face. Confirmed active-speaker changes
        # still create an intentional hard cut later in the state machine.
        conversation_speaker_changed = False
        if visual_pair is not None:
            visual_pair_by_id = {
                int(face.get('track_id')): face
                for face in visual_pair
                if face.get('track_id') is not None
            }
            reliable_active = bool(
                active_id is not None
                and int(active_id) in visual_pair_by_id
                and not point.get('fallback_used')
                and speaker_confidence >= 0.18
            )
            if reliable_active:
                conversation_speaker_changed = bool(
                    conversation_last_track is not None
                    and int(conversation_last_track) != int(active_id)
                )
                conversation_last_track = int(active_id)
            elif conversation_last_track not in visual_pair_by_id:
                if active_id is not None and int(active_id) in visual_pair_by_id:
                    conversation_last_track = int(active_id)
                else:
                    fallback_face = max(
                        visual_pair,
                        key=lambda face: (
                            float(face.get('active_speaker_confidence', 0.0)),
                            float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
                            -abs(float(face.get('cx', 0.0)) - source_w / 2.0),
                        ),
                    )
                    conversation_last_track = int(fallback_face.get('track_id'))

            framed_face = visual_pair_by_id.get(conversation_last_track)
            if framed_face is not None and not reliable_active:
                active_id = conversation_last_track
                selected = framed_face
                semantic_subject = {
                    'kind': 'face',
                    'box': framed_face,
                    'face_box': framed_face,
                    'confidence': max(0.32, float(framed_face.get('active_speaker_confidence', 0.0))),
                    'reason': 'conversation_face_hold',
                    'predicted': False,
                    'stable_id': f'face:{conversation_last_track}',
                    'velocity_x': 0.0,
                }
                subject_kind = 'face'
                subject_confidence = float(semantic_subject['confidence'])
                selection_reason = 'conversation_face_hold'
                subject_predicted = False
                subject_stable_id = f'face:{conversation_last_track}'

        if scene_cut:
            wide_pair_hold_ids = None
            wide_pair_hold_faces = None
            wide_pair_miss_streak = 0
        if visual_pair is not None:
            wide_pair_hold_ids = tuple(int(face.get('track_id')) for face in visual_pair)
            wide_pair_hold_faces = visual_pair
            wide_pair_miss_streak = 0
        elif wide_pair_hold_ids is not None:
            wide_pair_miss_streak += 1
            if wide_pair_miss_streak > 2:
                wide_pair_hold_ids = None
                wide_pair_hold_faces = None
                wide_pair_miss_streak = 0

        if pair_ids is not None and pair_ids == last_pair_ids:
            pair_streak += 1
        elif pair_ids is not None:
            pair_streak = 1
            last_pair_ids = pair_ids
        else:
            pair_streak = 0
            last_pair_ids = None

        if active_id is not None:
            recent_active_ids.append((float(point.get('t', 0.0)), int(active_id)))
        now = float(point.get('t', 0.0))
        is_silent = audio_activity < SILENCE_AUDIO_THRESHOLD
        speech_resumed_after_long_pause = bool(
            not is_silent and previous_silence_elapsed >= SILENCE_HOLD_SEC
        )
        if is_silent:
            if silence_started_at is None:
                silence_started_at = now
            silence_elapsed = max(0.0, now - silence_started_at)
        else:
            silence_elapsed = 0.0
            silence_started_at = None
        if not is_silent:
            previous_silence_elapsed = 0.0
        else:
            previous_silence_elapsed = silence_elapsed

        if not is_silent:
            silence_state = 'speech'
        elif silence_elapsed <= SILENCE_HOLD_SEC:
            silence_state = 'hold'
        elif silence_elapsed <= SILENCE_HOLD_SEC + SILENCE_WIDEN_SEC:
            silence_state = 'widen'
        else:
            silence_state = 'lock'
        recent_active_ids = [item for item in recent_active_ids if now - item[0] <= 2.5]

        if active_id is not None:
            participation_history.append({
                't': now,
                'track_id': int(active_id),
                'confidence': speaker_confidence,
                'audio_activity': audio_activity,
            })
        participation_history = [
            item for item in participation_history
            if now - float(item['t']) <= STACK_PARTICIPATION_WINDOW_SEC
        ]

        # A non-active participant's visible mouth response is a conservative
        # proxy for a reaction/interruption that would be lost in a tight crop.
        # Merely being visible never counts as an editorial reason to stack.
        if pair_ids is not None and active_id is not None:
            for face in faces:
                track_id = int(face.get('track_id'))
                if track_id == int(active_id) or track_id not in pair_ids:
                    continue
                mouth_motion = float(face.get('mouth_motion', 0.0))
                face_confidence = float(face.get('active_speaker_confidence', 0.0))
                if mouth_motion >= 0.065 and face_confidence >= 0.12:
                    reaction_history.append({
                        't': now,
                        'track_id': track_id,
                        'strength': mouth_motion * max(audio_activity, 0.35),
                    })
        reaction_history = [
            item for item in reaction_history
            if now - float(item['t']) <= STACK_REACTION_WINDOW_SEC
        ]

        recent_turns = [
            item for item in participation_history
            if now - float(item['t']) <= STACK_TURN_WINDOW_SEC
            and (pair_ids is None or int(item['track_id']) in pair_ids)
        ]
        recent_switches = sum(
            1 for item_index in range(1, len(recent_turns))
            if recent_turns[item_index]['track_id'] != recent_turns[item_index - 1]['track_id']
        )

        participant_counts = {}
        participant_confidences = {}
        if pair_ids is not None:
            for item in participation_history:
                track_id = int(item['track_id'])
                if track_id not in pair_ids:
                    continue
                participant_counts[track_id] = participant_counts.get(track_id, 0) + 1
                participant_confidences.setdefault(track_id, []).append(float(item['confidence']))

        pair_counts = [participant_counts.get(track_id, 0) for track_id in pair_ids] if pair_ids else []
        pair_mean_confidence = [
            statistics.mean(participant_confidences.get(track_id, [0.0]))
            for track_id in pair_ids
        ] if pair_ids else []
        total_participation = sum(pair_counts)
        participation_balance = (
            min(pair_counts) / max(pair_counts)
            if len(pair_counts) == 2 and max(pair_counts) > 0
            else 0.0
        )
        dominant_share = (
            max(pair_counts) / max(total_participation, 1)
            if pair_counts
            else 1.0
        )
        reaction_samples = [
            item for item in reaction_history
            if pair_ids is not None and int(item['track_id']) in pair_ids
        ]

        two_stable_speakers = pair_ids is not None and pair_streak >= STACK_PAIR_CONFIRM_SAMPLES
        both_actively_participating = len(pair_counts) == 2 and min(pair_counts) >= 2
        both_meaningful = (
            both_actively_participating
            and min(pair_mean_confidence) >= 0.12
            and participation_balance >= 0.35
        )
        rapid_alternation = recent_switches >= STACK_MIN_RAPID_SWITCHES
        reaction_matters = len(reaction_samples) >= 2
        loses_context_in_single = rapid_alternation and participation_balance >= 0.45 and reaction_matters

        turn_score = clamp(recent_switches / 3.0, 0.0, 1.0)
        reaction_score = clamp(len(reaction_samples) / 3.0, 0.0, 1.0)
        stability_score = clamp(pair_streak / 8.0, 0.0, 1.0)
        single_score = 1.0 + dominant_share * 0.45 + speaker_confidence * 0.25
        stacked_score = (
            0.15
            + turn_score * 0.70
            + participation_balance * 0.40
            + reaction_score * 0.35
            + stability_score * 0.15
        )
        stack_eligible = STACK_LAYOUT_ENABLED and (
            two_stable_speakers
            and both_actively_participating
            and both_meaningful
            and reaction_matters
            and rapid_alternation
            and loses_context_in_single
            and stacked_score >= single_score + STACK_SCORE_MARGIN
        )

        subject_height_ratio = (
            float(selected.get('h', 0)) / max(source_h, 1.0)
            if selected is not None
            else 0.0
        )
        wide_context_trigger = (
            selected is None
            or subject_kind in ('context', 'screen')
            or (subject_predicted and subject_confidence < 0.08)
        )
        strong_talking_head = (
            subject_kind == 'face'
            and selected is not None
            and not point.get('fallback_used')
            and subject_height_ratio > WIDE_FACE_HEIGHT_RATIO * 0.72
            and speaker_confidence >= 0.42
        )

        if scene_cut or index == 0:
            contextual_shot_latched = bool(wide_context_trigger and not portrait_source)
            talking_head_release_streak = 0
        elif contextual_shot_latched:
            talking_head_release_streak = talking_head_release_streak + 1 if strong_talking_head else 0
            if talking_head_release_streak >= 6:
                contextual_shot_latched = False
                talking_head_release_streak = 0

        active_speaker_mapped = bool(
            subject_kind == 'face'
            and selected is not None
            and active_id is not None
            and not point.get('fallback_used')
            and speaker_confidence >= 0.18
        )
        participant_count = len(layout_faces)
        desired_grid_template = None
        fixed_render_branch = None
        fixed_hard_cut = False
        fixed_track_region_map = {} if not fixed_two_panel else fixed_two_panel.get('track_region_map', {})
        fixed_active_panel = None
        if fixed_two_panel and active_id is not None:
            fixed_active_panel = fixed_track_region_map.get(str(int(active_id)))
            if fixed_active_panel is None and int(active_id) in face_by_id:
                fixed_active_panel = (
                    'left' if float(face_by_id[int(active_id)].get('cx', 0.0)) < float(fixed_two_panel['divider_x'])
                    else 'right'
                )
        fixed_confident = bool(
            fixed_two_panel
            and active_id is not None
            and int(active_id) in face_by_id
            and fixed_active_panel in ('left', 'right')
            and not point.get('fallback_used')
            and speaker_confidence >= FIXED_SPEAKER_CONFIDENCE
            and speaker_score_margin >= FIXED_SPEAKER_MARGIN
        )
        fixed_hold = bool(
            fixed_two_panel
            and not fixed_confident
            and fixed_last_confident_track is not None
            and now - fixed_last_confident_time <= FIXED_UNCERTAINTY_HOLD_SEC
            and int(fixed_last_confident_track) in face_by_id
        )

        if portrait_source:
            desired_mode = 'source_vertical'
            fixed_render_branch = 'source_vertical'
        elif silence_state == 'hold' and fixed_two_panel and fixed_last_confident_track is not None and int(fixed_last_confident_track) in face_by_id:
            # A short pause is editorially continuous with the preceding turn.
            # Keep the last confirmed panel instead of chasing incidental motion.
            desired_mode = 'single'
            fixed_render_branch = f'active_speaker_{fixed_last_confident_panel}'
            active_id = int(fixed_last_confident_track)
            fixed_hold = True
        elif silence_state in ('widen', 'lock') and fixed_two_panel and visual_pair is not None:
            # During a long break, use two complete portrait panes rather than
            # a midpoint crop. Speech immediately returns to one face.
            desired_mode = 'stacked'
            fixed_render_branch = f'silence_{silence_state}_stacked'
        elif silence_state in ('widen', 'lock') and fixed_two_panel:
            desired_mode = 'wide_context'
            fixed_render_branch = f'silence_{silence_state}_safe_full_frame'
        elif silence_state in ('widen', 'lock') and visual_pair is not None:
            desired_mode = 'stacked'
            fixed_render_branch = f'silence_{silence_state}_stacked'
        elif silence_state in ('widen', 'lock'):
            desired_mode = 'wide_context'
            fixed_render_branch = f'silence_{silence_state}_safe_full_frame'
        elif fixed_confident:
            desired_mode = 'single'
            fixed_render_branch = f'active_speaker_{fixed_active_panel}'
            fixed_hard_cut = (
                fixed_last_confident_track is not None
                and int(fixed_last_confident_track) != int(active_id)
            ) or speech_resumed_after_long_pause
            fixed_last_confident_track = int(active_id)
            fixed_last_confident_panel = fixed_active_panel
            fixed_last_confident_time = now
            contextual_shot_latched = False
        elif fixed_hold:
            desired_mode = 'single'
            fixed_render_branch = f'active_speaker_{fixed_last_confident_panel}'
        elif fixed_two_panel and selected is not None:
            # During speech, an uncertain voice-to-face association must not
            # strand the crop on the divider between two people. Hold the
            # best tracked face until stronger mouth/diarization evidence
            # confirms a speaker switch.
            desired_mode = 'single'
            fixed_render_branch = 'single_subject_uncertain'
        elif fixed_two_panel and visual_pair is not None and (stack_eligible or recent_switches >= STACK_MIN_RAPID_SWITCHES):
            desired_mode = 'stacked'
            fixed_render_branch = 'stacked_uncertain'
        elif fixed_two_panel:
            desired_mode = 'wide_context'
            fixed_render_branch = 'safe_full_frame'
        elif participant_count >= 2 and active_speaker_mapped:
            desired_mode = 'single'
            fixed_render_branch = 'single_subject'
        elif participant_count >= 2 and selected is not None:
            # Prefer one complete person over a center crop between two
            # or more people. Identity continuity keeps this face stable until
            # active-speaker evidence is strong enough to cut to another
            # person. Multi-person layouts are reserved for sustained silence.
            desired_mode = 'single'
            fixed_render_branch = 'single_subject_uncertain'
        elif participant_count >= 4:
            desired_mode = 'grid'
            fixed_render_branch = 'grid'
            desired_grid_template = 'grid_4'
        elif participant_count == 3:
            desired_mode = 'grid'
            fixed_render_branch = 'grid'
            desired_grid_template = 'grid_3'
        elif participant_count == 2:
            # The conversation fallback above normally supplies a face. If a
            # detector sample is incomplete, hold a single composition rather
            # than displaying a midpoint or two cropped participants.
            desired_mode = 'single'
            fixed_render_branch = 'single_subject_uncertain'
        elif subject_kind in ('context', 'screen'):
            desired_mode = 'wide_context'
            fixed_render_branch = 'safe_full_frame'
        elif selected is not None and subject_confidence >= 0.10:
            # People, bodies, moving objects, and salient action all use the
            # same semantic ROI timeline. Face detection is not required.
            desired_mode = 'single'
            fixed_render_branch = 'single_subject'
        elif contextual_shot_latched:
            desired_mode = 'wide_context'
            fixed_render_branch = 'safe_full_frame'
        elif wide_context_trigger:
            desired_mode = 'wide_context'
            fixed_render_branch = 'safe_full_frame'
        elif stack_eligible:
            desired_mode = 'stacked'
            fixed_render_branch = 'stacked_uncertain'
        else:
            desired_mode = 'single'
            fixed_render_branch = 'single_subject'

        # Returning from a deliberate group composition to a trustworthy
        # speaker is an editorial cut, not a camera pan across the room.
        if (speech_resumed_after_long_pause or conversation_speaker_changed) and active_speaker_mapped:
            fixed_hard_cut = True

        two_person_context = wide_pair_hold_ids is not None
        grid_like_context = (
            len(visible_faces) >= 2
            and max(float(face.get('h', 0.0)) for face in visible_faces) < source_h * 0.15
            and (
                max(float(face.get('cy', 0.0)) for face in visible_faces)
                - min(float(face.get('cy', 0.0)) for face in visible_faces)
            ) >= source_h * 0.25
        )
        if grid_like_context:
            wide_kind = 'safe_wide'
        elif contextual_shot_latched or subject_kind in ('context', 'screen'):
            wide_kind = 'broll'
        else:
            wide_kind = 'safe_wide'

        if fixed_two_panel:
            # Fixed-region routing is authoritative. Generic hysteresis must
            # not delay a confirmed speaker cut or mutate it into a midpoint.
            current_mode = desired_mode
            current_grid_template = None
            current_pair = pair_ids if desired_mode == 'stacked' else None
            pending_mode = None
            pending_count = 0
            held_samples = 0
        elif scene_cut:
            current_mode = desired_mode
            current_grid_template = desired_grid_template if desired_mode == 'grid' else None
            current_pair = pair_ids if desired_mode == 'stacked' else None
            pending_mode = None
            pending_count = 0
            held_samples = 0
        elif desired_mode == current_mode:
            if desired_mode == 'grid' and desired_grid_template:
                current_grid_template = desired_grid_template
            pending_mode = None
            pending_count = 0
            held_samples += 1
            if current_mode == 'stacked' and pair_ids is not None:
                current_pair = current_pair if current_pair == pair_ids else pair_ids
        else:
            if desired_mode == pending_mode:
                pending_count += 1
            else:
                pending_mode = desired_mode
                pending_count = 1
            required_confirmation = STACK_ENTER_CONFIRM_SAMPLES if desired_mode in ('stacked', 'grid') else LAYOUT_CONFIRM_SAMPLES
            if held_samples >= LAYOUT_MIN_HOLD_SAMPLES and pending_count >= required_confirmation:
                current_mode = desired_mode
                current_grid_template = desired_grid_template if desired_mode == 'grid' else None
                current_pair = pair_ids if desired_mode == 'stacked' else None
                pending_mode = None
                pending_count = 0
                held_samples = 0
            else:
                held_samples += 1

        layout_face_by_id = {
            int(face.get('track_id')): face for face in layout_faces if face.get('track_id') is not None
        }
        layout_pair_ids = tuple(
            int(face.get('track_id')) for face in sorted(
                layout_faces[:2], key=lambda face: (
                    0 if active_id is not None and int(face.get('track_id')) == int(active_id) else 1,
                    float(face.get('cx', 0.0)),
                )
            )
        ) if len(layout_faces) == 2 else None
        primary_face = (
            face_by_id.get(int(active_id))
            if subject_kind == 'face' and active_id is not None
            else None
        )
        if fixed_hold:
            active_id = int(fixed_last_confident_track)
            primary_face = face_by_id.get(active_id)
            subject_stable_id = f'face:{active_id}'
            subject_kind = 'face'
        elif fixed_confident:
            primary_face = face_by_id.get(int(active_id))
        primary_subject = None
        if selected is not None:
            primary_subject = {
                **selected,
                'cx': float(selected.get('x', 0)) + float(selected.get('w', 0)) / 2.0,
                'cy': float(selected.get('y', 0)) + float(selected.get('h', 0)) / 2.0,
            }
            if primary_face is None and subject_kind == 'face':
                primary_face = primary_subject

        top_face = bottom_face = None
        wide_pair_ids = None
        if current_mode == 'stacked':
            active_pair = layout_pair_ids or (
                current_pair if current_pair and all(track_id in face_by_id for track_id in current_pair) else pair_ids
            )
            if active_pair and all(track_id in face_by_id for track_id in active_pair):
                top_face = face_by_id[active_pair[0]]
                bottom_face = face_by_id[active_pair[1]]
                current_pair = active_pair
            else:
                # Hold the layout through a short detection gap; the segment
                # aggregator will use the last observed boxes for both tracks.
                active_pair = current_pair
        elif current_mode == 'wide_context' and wide_kind == 'two_person':
            active_pair = wide_pair_hold_ids
            held_faces_by_id = {
                int(face.get('track_id')): face for face in (wide_pair_hold_faces or ())
                if face.get('track_id') is not None
            }
            if active_pair:
                ordered_people = []
                for track_id in active_pair:
                    face = face_by_id.get(track_id) or held_faces_by_id.get(track_id)
                    if face is not None:
                        ordered_people.append((track_id, face))
                if len(ordered_people) == 2:
                    ordered_people.sort(key=lambda item: float(item[1].get('cx', 0)))
                    wide_pair_ids = (ordered_people[0][0], ordered_people[1][0])
                    top_face, bottom_face = ordered_people[0][1], ordered_people[1][1]

        primary_panel = None
        primary_tuple = None if primary_subject is None else (
            float(primary_subject.get('x', 0)), float(primary_subject.get('y', 0)),
            float(primary_subject.get('w', 1)), float(primary_subject.get('h', 1)),
        )
        face_tuple = None if primary_face is None else (
            float(primary_face.get('x', 0)), float(primary_face.get('y', 0)),
            float(primary_face.get('w', 1)), float(primary_face.get('h', 1)),
        )
        if fixed_two_panel and face_tuple is not None:
            divider_x = float(fixed_two_panel['divider_x'])
            mapped_panel = (
                (fixed_two_panel.get('track_region_map') or {}).get(str(int(active_id)))
                if active_id is not None
                else None
            )
            primary_panel = (
                mapped_panel if mapped_panel in ('left', 'right')
                else ('left' if center(face_tuple)[0] < divider_x else 'right')
            )
            region = fixed_two_panel['left_region'] if primary_panel == 'left' else fixed_two_panel['right_region']
            crop = portrait_crop_for_face_in_panel(face_tuple, source_w, source_h, float(region[0]), float(region[1]))
        elif primary_tuple is not None:
            crop = portrait_crop_for_subject(
                primary_tuple,
                source_w,
                source_h,
                subject_kind=subject_kind,
                face_box=face_tuple,
                velocity_x=subject_velocity_x,
            )
        elif fixed_two_panel:
            # Uncertainty is represented explicitly as stacked/safe context.
            # Never invent a left/right choice and never use the divider as a
            # portrait subject center.
            crop = {
                'x': 0.0, 'y': 0.0,
                'w': round(source_w, 3), 'h': round(source_h, 3),
                'cx': round(source_w / 2.0, 3),
                'cy': round(source_h / 2.0, 3), 'zoom': 1.0,
            }
        else:
            # With no reliable subject, do not invent a portrait crop around
            # the source midpoint. Preserve the source as safe context and let
            # the renderer scale it into the vertical canvas.
            current_mode = 'wide_context'
            wide_kind = 'safe_wide'
            current_grid_template = None
            crop = {
                'x': 0.0,
                'y': 0.0,
                'w': round(source_w, 3),
                'h': round(source_h, 3),
                'cx': round(source_w / 2.0, 3),
                'cy': round(source_h / 2.0, 3),
                'zoom': 1.0,
            }

        if (
            current_mode == 'single'
            and active_id is not None
            and decisions
            and decisions[-1].get('primary_track_id') is not None
            and int(decisions[-1]['primary_track_id']) != int(active_id)
            and speaker_confidence >= 0.18
        ):
            fixed_hard_cut = True

        subject_faces = []
        if current_mode == 'grid':
            ordered_layout_faces = sorted(
                layout_face_by_id.values(),
                key=lambda face: (
                    0 if active_id is not None and int(face.get('track_id')) == int(active_id) else 1,
                    -float(face.get('active_speaker_confidence', 0.0)),
                    float(face.get('cy', 0.0)),
                    float(face.get('cx', 0.0)),
                ),
            )
            subject_faces = ordered_layout_faces[:4]

        decision = {
            'timestamp': round(now, 3),
            'mode': current_mode,
            'primary_track_id': active_id,
            'subject_stable_id': subject_stable_id,
            'subject_kind': subject_kind,
            'subject_confidence': round(subject_confidence, 4),
            'selection_reason': selection_reason,
            'subject_predicted': subject_predicted,
            'top_track_id': wide_pair_ids[0] if wide_pair_ids else (None if current_pair is None else current_pair[0]),
            'bottom_track_id': wide_pair_ids[1] if wide_pair_ids else (None if current_pair is None else current_pair[1]),
            'speaker_confidence': round(speaker_confidence, 4),
            'speaker_score_margin': round(speaker_score_margin, 4),
            'audio_activity': round(audio_activity, 4),
            'scene_cut': scene_cut,
            'single_score': round(single_score, 4),
            'stacked_score': round(stacked_score, 4),
            'stack_eligible': stack_eligible,
            'wide_kind': wide_kind if current_mode == 'wide_context' else None,
            'grid_template': current_grid_template if current_mode == 'grid' else None,
            'subjects': [
                {
                    'trackId': int(face.get('track_id')),
                    'box': {
                        key: round(float(face.get(key, 0.0)), 3)
                        for key in ('x', 'y', 'w', 'h', 'cx', 'cy')
                    },
                    'score': round(
                        float(face.get('active_speaker_confidence', 0.0))
                        + (1.0 if active_id is not None and int(face.get('track_id')) == int(active_id) else 0.0),
                        4,
                    ),
                }
                for face in subject_faces
            ],
            'source_layout': None if not fixed_two_panel else fixed_two_panel['mode'],
            'panel_boundary_x': None if not fixed_two_panel else fixed_two_panel['divider_x'],
            'panel_regions': None if not fixed_two_panel else {
                'left': fixed_two_panel['left_region'],
                'right': fixed_two_panel['right_region'],
            },
            'primary_panel': primary_panel,
            'render_branch': fixed_render_branch,
            'hard_cut': fixed_hard_cut,
            'silence_state': silence_state,
            'silence_elapsed': round(silence_elapsed, 3),
            'track_region_map': None if not fixed_two_panel else fixed_two_panel.get('track_region_map'),
            'visible_count': len(visible_faces),
            'editorial_signals': {
                'two_stable_speakers': two_stable_speakers,
                'both_actively_participating': both_actively_participating,
                'both_meaningful': both_meaningful,
                'reaction_matters': reaction_matters,
                'rapid_alternation': rapid_alternation,
                'loses_context_in_single': loses_context_in_single,
                'recent_switches': recent_switches,
                'participation_balance': round(participation_balance, 4),
                'dominant_share': round(dominant_share, 4),
            },
            'crop': crop,
            'primary_subject': primary_subject,
            'primary_face': primary_face,
            'top_face': top_face,
            'bottom_face': bottom_face,
        }
        decisions.append(decision)
        frame['layout_mode'] = current_mode
        frame['layout_top_track_id'] = decision['top_track_id']
        frame['layout_bottom_track_id'] = decision['bottom_track_id']
        frame['layout_wide_kind'] = decision['wide_kind']
        frame['layout_grid_template'] = decision['grid_template']
        frame['speaker_confidence'] = decision['speaker_confidence']
        point['framing'] = current_mode

    # The state machine already applies confidence, hysteresis, and cooldown.
    # Keep coherent stacked runs intact instead of truncating them to a few
    # seconds and exposing a divider-centered or incorrect single crop.

    segments = []
    for index, decision in enumerate(decisions):
        grid_subject_ids = tuple(
            int(subject['trackId']) for subject in decision.get('subjects', [])
            if subject.get('trackId') is not None
        )
        identity_key = (
            decision['mode'],
            decision.get('render_branch'),
            decision.get('primary_panel'),
            decision.get('primary_track_id') if decision.get('source_layout') else None,
            decision['subject_stable_id'] if decision['mode'] == 'single' else None,
            decision['wide_kind'] if decision['mode'] == 'wide_context' else None,
            decision['top_track_id'] if decision['mode'] in ('stacked', 'wide_context') else None,
            decision['bottom_track_id'] if decision['mode'] in ('stacked', 'wide_context') else None,
            decision.get('grid_template') if decision['mode'] == 'grid' else None,
            grid_subject_ids if decision['mode'] == 'grid' else None,
        )
        identity_switch = bool(
            segments
            and decision['mode'] == 'single'
            and segments[-1].get('mode') == 'single'
            and decision.get('primary_track_id') is not None
            and segments[-1].get('primaryTrackId') is not None
            and int(decision['primary_track_id']) != int(segments[-1]['primaryTrackId'])
            and float(decision.get('speaker_confidence', 0.0)) >= 0.18
        )
        force_boundary = bool(decision.get('scene_cut') or decision.get('hard_cut') or identity_switch)
        if not segments or identity_key != segments[-1]['_key'] or force_boundary:
            segments.append({
                '_key': identity_key,
                'start': 0.0 if not segments else float(decision['timestamp']),
                'end': duration,
                'mode': decision['mode'],
                'primaryTrackId': decision['primary_track_id'],
                'subjectStableId': decision['subject_stable_id'],
                'subjectKind': decision['subject_kind'],
                'selectionReason': decision['selection_reason'],
                'fallbackReason': (
                    decision['selection_reason']
                    if decision['subject_kind'] in ('context', 'screen')
                    else None
                ),
                'topTrackId': decision['top_track_id'],
                'bottomTrackId': decision['bottom_track_id'],
                'wideKind': decision['wide_kind'],
                'gridTemplate': decision.get('grid_template'),
                'sourceLayout': decision.get('source_layout'),
                'panelBoundaryX': decision.get('panel_boundary_x'),
                'panelRegions': decision.get('panel_regions'),
                'primaryPanel': decision.get('primary_panel'),
                'renderBranch': decision.get('render_branch'),
                'speakerScoreMargin': decision.get('speaker_score_margin'),
                'trackRegionMap': decision.get('track_region_map'),
                'hardCutStart': bool(decision.get('hard_cut') or identity_switch),
                'silenceState': decision.get('silence_state'),
                'sceneCutStart': bool(decision.get('scene_cut')),
                'points': [],
                '_top_boxes': [],
                '_bottom_boxes': [],
                '_single_scores': [],
                '_stacked_scores': [],
                '_visible_counts': [],
                '_subject_order': list(grid_subject_ids),
                '_subject_boxes': {},
                '_subject_scores': {},
            })
            if len(segments) > 1:
                segments[-2]['end'] = float(decision['timestamp'])
        segment = segments[-1]
        segment['points'].append({
            't': decision['timestamp'],
            'primaryTrackId': decision['primary_track_id'],
            'cropX': decision['crop']['x'],
            'cropY': decision['crop']['y'],
            'cropW': decision['crop']['w'],
            'cropH': decision['crop']['h'],
            'cropCenterX': decision['crop']['cx'],
            'cropCenterY': decision['crop']['cy'],
            'zoom': decision['crop']['zoom'],
            'speakerConfidence': decision['speaker_confidence'],
            'subjectKind': decision['subject_kind'],
            'subjectConfidence': decision['subject_confidence'],
            'selectionReason': decision['selection_reason'],
            'predicted': decision['subject_predicted'],
            'subjectStableId': decision['subject_stable_id'],
        })
        if decision.get('top_face'):
            segment['_top_boxes'].append(decision['top_face'])
        if decision.get('bottom_face'):
            segment['_bottom_boxes'].append(decision['bottom_face'])
        for subject in decision.get('subjects', []):
            track_id = int(subject['trackId'])
            segment['_subject_boxes'].setdefault(track_id, []).append(subject.get('box') or {})
            segment['_subject_scores'].setdefault(track_id, []).append(float(subject.get('score', 0.0)))
        segment['_single_scores'].append(float(decision.get('single_score', 0.0)))
        segment['_stacked_scores'].append(float(decision.get('stacked_score', 0.0)))
        segment['_visible_counts'].append(int(decision.get('visible_count', 0)))

    def median_dict_box(items):
        if not items:
            return None
        return {
            key: round(float(statistics.median(float(item.get(key, 0)) for item in items)), 3)
            for key in ('x', 'y', 'w', 'h', 'cx', 'cy')
        }

    clean_segments = []
    for segment in segments:
        if segment['end'] - segment['start'] < 0.05:
            continue
        segment['topBox'] = median_dict_box(segment.pop('_top_boxes'))
        segment['bottomBox'] = median_dict_box(segment.pop('_bottom_boxes'))
        segment['singleScore'] = round(statistics.mean(segment.pop('_single_scores')), 4)
        segment['stackedScore'] = round(statistics.mean(segment.pop('_stacked_scores')), 4)
        visible_counts = segment.pop('_visible_counts')
        segment['visibleCount'] = int(round(statistics.median(visible_counts))) if visible_counts else 0
        segment['visibleCountMax'] = max(visible_counts, default=0)
        subject_order = segment.pop('_subject_order')
        subject_boxes = segment.pop('_subject_boxes')
        subject_scores = segment.pop('_subject_scores')
        segment['subjects'] = [
            {
                'trackId': track_id,
                'box': median_dict_box(subject_boxes.get(track_id, [])),
                'score': round(statistics.mean(subject_scores.get(track_id, [0.0])), 4),
            }
            for track_id in subject_order
            if median_dict_box(subject_boxes.get(track_id, [])) is not None
        ]
        segment.pop('_key', None)
        segment['start'] = round(float(segment['start']), 3)
        segment['end'] = round(float(segment['end']), 3)
        clean_segments.append(segment)

    # Remove transitional flashes shorter than the layout hold requirement.
    # Prefer extending the following stable decision so a 250 ms detector blip
    # never appears as a visible layout flicker in the exported reel.
    index = 0
    while index < len(clean_segments) and len(clean_segments) > 1:
        segment = clean_segments[index]
        segment_duration = float(segment['end']) - float(segment['start'])
        is_confirmed_fixed_turn = (
            segment.get('sourceLayout') in (FIXED_LAYOUT_MODE, LEGACY_FIXED_LAYOUT_MODE)
            and segment.get('mode') == 'single'
            and segment.get('renderBranch') in ('active_speaker_left', 'active_speaker_right')
            and segment_duration >= FIXED_MIN_CONFIRMED_TURN_SEC
        )
        # A speaker/identity change is an intentional jump frame even when the
        # incoming turn begins near the end of a short clip. Never merge that
        # boundary back into the outgoing speaker and accidentally animate a
        # slow pan across both faces.
        if segment_duration >= 0.9 or is_confirmed_fixed_turn or segment.get('hardCutStart'):
            index += 1
            continue
        previous = clean_segments[index - 1] if index > 0 else None
        following = clean_segments[index + 1] if index + 1 < len(clean_segments) else None
        segment_is_multi = segment['mode'] in ('stacked', 'grid')
        following_is_multi = following is not None and following['mode'] in ('stacked', 'grid')
        previous_is_multi = previous is not None and previous['mode'] in ('stacked', 'grid')
        if not segment_is_multi and following_is_multi and previous is not None:
            previous['end'] = segment['end']
            previous['points'].extend(segment['points'])
            clean_segments.pop(index)
            index = max(0, index - 1)
        elif not segment_is_multi and previous_is_multi and following is not None:
            following['start'] = segment['start']
            following['points'] = segment['points'] + following['points']
            clean_segments.pop(index)
        elif segment.get('sceneCutStart') and following is not None:
            following['start'] = segment['start']
            following['sceneCutStart'] = True
            following['points'] = segment['points'] + following['points']
            clean_segments.pop(index)
        elif following is not None and following.get('sceneCutStart') and previous is not None:
            previous['end'] = segment['end']
            previous['points'].extend(segment['points'])
            clean_segments.pop(index)
            index = max(0, index - 1)
        elif previous is not None and following is not None and previous['mode'] == following['mode'] and not following.get('sceneCutStart'):
            previous['end'] = following['end']
            previous['points'].extend(segment['points'])
            previous['points'].extend(following['points'])
            clean_segments.pop(index + 1)
            clean_segments.pop(index)
            index = max(0, index - 1)
        elif following is not None:
            following['start'] = segment['start']
            following['points'] = segment['points'] + following['points']
            clean_segments.pop(index)
        elif previous is not None:
            previous['end'] = segment['end']
            previous['points'].extend(segment['points'])
            clean_segments.pop(index)
            index = max(0, index - 1)
        else:
            index += 1

    # Scene analysis is sampled every 250 ms. Pull hard-cut boundaries forward
    # by one sample so the incoming composition appears on the first visible
    # frame instead of holding the outgoing B-roll layout for another sample.
    for segment_index in range(1, len(clean_segments)):
        segment = clean_segments[segment_index]
        previous = clean_segments[segment_index - 1]
        if not segment.get('sceneCutStart') or segment.get('hardCutStart') or not segment.get('points'):
            continue
        original_start = float(segment['start'])
        boundary = max(float(previous['start']), original_start - SCENE_CUT_LOOKAHEAD_SEC)
        if original_start - boundary < 0.05:
            continue
        previous['end'] = round(boundary, 3)
        segment['start'] = round(boundary, 3)
        leading_point = dict(segment['points'][0])
        leading_point['t'] = round(boundary, 3)
        segment['points'].insert(0, leading_point)

    # Smooth the semantic virtual camera inside each uninterrupted subject
    # segment. Hold the current composition through small detector changes and
    # require sustained movement before choosing a new target. Velocity and
    # acceleration limits then make the intentional move feel like an operator
    # following the subject instead of a camera correcting every sample.
    # Scene and identity changes remain hard cuts and therefore never slide
    # from the previous shot.
    for segment in clean_segments:
        if segment['mode'] != 'single' or len(segment['points']) < 2:
            continue
        smoothed_x = float(segment['points'][0]['cropX'])
        smoothed_y = float(segment['points'][0]['cropY'])
        target_x = smoothed_x
        target_y = smoothed_y
        pending_x = target_x
        pending_y = target_y
        pending_x_samples = 0
        pending_y_samples = 0
        velocity_x = 0.0
        velocity_y = 0.0
        previous_t = float(segment['points'][0]['t'])
        for point in segment['points'][1:]:
            current_t = float(point['t'])
            delta_t = max(0.05, current_t - previous_t)
            crop_w = float(point['cropW'])
            crop_h = float(point['cropH'])
            raw_x = float(point['cropX'])
            raw_y = float(point['cropY'])
            dead_zone_x = crop_w * 0.06
            dead_zone_y = crop_h * 0.04

            if abs(raw_x - target_x) <= dead_zone_x:
                pending_x_samples = 0
            else:
                same_direction = (raw_x - target_x) * (pending_x - target_x) > 0
                pending_x_samples = pending_x_samples + 1 if same_direction else 1
                pending_x = raw_x
                if pending_x_samples >= 3 or abs(raw_x - target_x) >= crop_w * 0.20:
                    target_x = raw_x
                    pending_x_samples = 0

            if abs(raw_y - target_y) <= dead_zone_y:
                pending_y_samples = 0
            else:
                same_direction = (raw_y - target_y) * (pending_y - target_y) > 0
                pending_y_samples = pending_y_samples + 1 if same_direction else 1
                pending_y = raw_y
                if pending_y_samples >= 3 or abs(raw_y - target_y) >= crop_h * 0.16:
                    target_y = raw_y
                    pending_y_samples = 0

            delta_x = target_x - smoothed_x
            delta_y = target_y - smoothed_y
            if abs(delta_x) <= crop_w * 0.012:
                delta_x = 0.0
                velocity_x *= 0.30
            if abs(delta_y) <= crop_h * 0.010:
                delta_y = 0.0
                velocity_y *= 0.30

            desired_velocity_x = clamp(delta_x / delta_t, -crop_w * 0.24, crop_w * 0.24)
            desired_velocity_y = clamp(delta_y / delta_t, -crop_h * 0.14, crop_h * 0.14)
            acceleration_x = crop_w * 0.62 * delta_t
            acceleration_y = crop_h * 0.38 * delta_t
            velocity_x += clamp(desired_velocity_x - velocity_x, -acceleration_x, acceleration_x)
            velocity_y += clamp(desired_velocity_y - velocity_y, -acceleration_y, acceleration_y)

            step_x = velocity_x * delta_t
            step_y = velocity_y * delta_t
            if abs(step_x) > abs(delta_x):
                step_x = delta_x
                velocity_x = 0.0
            if abs(step_y) > abs(delta_y):
                step_y = delta_y
                velocity_y = 0.0
            smoothed_x += step_x
            smoothed_y += step_y
            point['cropX'] = round(smoothed_x, 3)
            point['cropY'] = round(smoothed_y, 3)
            point['cropCenterX'] = round(smoothed_x + float(point['cropW']) / 2.0, 3)
            point['cropCenterY'] = round(smoothed_y + float(point['cropH']) / 2.0, 3)
            previous_t = current_t
    return clean_segments


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


def save_debug_video(cv2, input_path: str, out_path: Path, start_sec: float,
                     source_w: float, source_h: float, frames, timeline, analysis_fps: float):
    """Write a sampled planner overlay. This is never used as customer output."""
    debug_cap = cv2.VideoCapture(input_path)
    if not debug_cap.isOpened():
        return None
    scale = min(1.0, 960.0 / max(source_w, 1.0))
    out_w = max(2, int(round(source_w * scale)) // 2 * 2)
    out_h = max(2, int(round(source_h * scale)) // 2 * 2)
    writer = cv2.VideoWriter(
        str(out_path),
        cv2.VideoWriter_fourcc(*'mp4v'),
        max(1.0, float(analysis_fps)),
        (out_w, out_h),
    )
    if not writer.isOpened():
        debug_cap.release()
        return None

    center_path = []
    palette = [(0, 255, 0), (255, 180, 0), (255, 0, 255), (0, 220, 255)]

    def scaled_box(box):
        if not box:
            return None
        return tuple(int(round(float(box.get(key, 0.0)) * scale)) for key in ('x', 'y', 'w', 'h'))

    for frame_meta in frames:
        rel_t = float(frame_meta.get('timestamp', 0.0))
        debug_cap.set(cv2.CAP_PROP_POS_MSEC, (start_sec + rel_t) * 1000.0)
        ok, image = debug_cap.read()
        if not ok:
            continue
        image = cv2.resize(image, (out_w, out_h), interpolation=cv2.INTER_AREA)
        active_id = frame_meta.get('active_track_id')
        for face_index, face in enumerate(frame_meta.get('faces', [])):
            box = scaled_box(face)
            if box is None:
                continue
            x, y, w, h = box
            track_id = face.get('track_id')
            color = (0, 255, 255) if face.get('predicted') else palette[face_index % len(palette)]
            thickness = 4 if track_id == active_id else 2
            cv2.rectangle(image, (x, y), (x + w, y + h), color, thickness)
            label = f"ID {track_id}{' ACTIVE' if track_id == active_id else ''}"
            cv2.putText(image, label, (x, max(20, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

        segment = next(
            (item for item in timeline if float(item.get('start', 0.0)) - 1e-3 <= rel_t < float(item.get('end', 0.0)) + 1e-3),
            None,
        )
        if segment:
            mode_label = str(segment.get('mode', 'unknown'))
            if segment.get('gridTemplate'):
                mode_label += f" / {segment['gridTemplate']}"
            cv2.putText(image, mode_label, (18, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
            points = segment.get('points') or []
            if points:
                point = min(points, key=lambda item: abs(float(item.get('t', 0.0)) - rel_t))
                crop = {
                    'x': point.get('cropX', 0.0), 'y': point.get('cropY', 0.0),
                    'w': point.get('cropW', source_w), 'h': point.get('cropH', source_h),
                }
                crop_box = scaled_box(crop)
                if crop_box:
                    x, y, w, h = crop_box
                    cv2.rectangle(image, (x, y), (x + w, y + h), (255, 80, 40), 3)
                    center_path.append((x + w // 2, y + h // 2))
            for subject_index, subject in enumerate(segment.get('subjects') or []):
                subject_box = scaled_box(subject.get('box'))
                if subject_box:
                    x, y, w, h = subject_box
                    cv2.rectangle(image, (x, y), (x + w, y + h), palette[subject_index % len(palette)], 3)
        for path_index in range(1, len(center_path)):
            cv2.line(image, center_path[path_index - 1], center_path[path_index], (255, 80, 40), 2)
        cv2.putText(image, f"t={rel_t:.2f}s", (18, out_h - 18), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
        writer.write(image)

    writer.release()
    debug_cap.release()
    return str(out_path) if out_path.exists() else None


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
    editorial_plan = None
    diarized_turns = []
    if len(sys.argv) >= 6 and sys.argv[5]:
        try:
            editorial_plan = json.loads(Path(sys.argv[5]).read_text(encoding='utf-8'))
        except Exception as exc:
            fail(2, f'editorial_plan_invalid:{exc}')
    if len(sys.argv) >= 7 and sys.argv[6]:
        try:
            raw_turns = json.loads(Path(sys.argv[6]).read_text(encoding='utf-8'))
            diarized_turns = raw_turns if isinstance(raw_turns, list) else []
        except Exception as exc:
            fail(2, f'speaker_turns_invalid:{exc}')

    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
        import numpy as np  # type: ignore
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
    source_frame_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
    source_duration = source_frame_count / fps if source_frame_count > 0.0 and fps > 0.0 else 0.0
    try:
        requested_preroll = float(os.environ.get('SMART_REFRAME_ANALYSIS_PREROLL_SEC', '0.85'))
    except (TypeError, ValueError):
        requested_preroll = 0.85
    try:
        requested_postroll = float(os.environ.get('SMART_REFRAME_ANALYSIS_POSTROLL_SEC', '0.50'))
    except (TypeError, ValueError):
        requested_postroll = 0.50
    analysis_preroll = clamp(requested_preroll, 0.75, 1.0)
    analysis_postroll = clamp(requested_postroll, 0.4, 0.6)
    analysis_start_sec = max(0.0, start_sec - analysis_preroll)
    requested_analysis_end = end_sec + analysis_postroll
    analysis_end_sec = min(source_duration, requested_analysis_end) if source_duration > 0.0 else requested_analysis_end
    analysis_end_sec = max(end_sec, analysis_end_sec)
    analysis_duration = max(0.01, analysis_end_sec - analysis_start_sec)
    # Four observations per second is frequent enough to associate speech with
    # mouth motion and still bounded for long clips.
    try:
        requested_analysis_fps = float(sys.argv[4]) if len(sys.argv) > 4 else float(
            os.environ.get('SMART_REFRAME_ANALYSIS_FPS', '4')
        )
    except (TypeError, ValueError):
        requested_analysis_fps = 4.0
    analysis_fps = clamp(requested_analysis_fps, 1.0, 8.0)
    sample_interval = 1.0 / analysis_fps
    sample_count = max(2, int(math.ceil(analysis_duration * analysis_fps)) + 1)
    sample_times = [
        min(analysis_end_sec, analysis_start_sec + sample_interval * i)
        for i in range(sample_count)
    ]
    audio_activity, audio_available = extract_audio_activity(
        input_path,
        analysis_start_sec,
        analysis_duration,
        sample_times,
    )

    mp_face = mp.solutions.face_detection
    detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.45)
    body_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_upperbody.xml')
    frontal_face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    profile_face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')

    centers_x = []
    points = []
    detected_faces = []
    selected_subject_boxes = []
    first_debug_frame = None
    first_box = None
    first_motion_box = None
    prev_gray = None
    active_box = None
    active_track_id = None
    pending_box = None
    pending_count = 0
    active_framing = 'single'
    pending_framing = None
    pending_framing_count = 0
    shot_id = 0
    speaker_switches = 0
    confident_speaker_samples = 0
    wide_context_samples = 0
    partial_face_only_samples = 0
    complete_face_samples = 0
    face_tracks = []
    next_face_track_id = 1
    previous_track_boxes = {}
    speaker_evidence_history = {}
    last_semantic_subject = None
    last_semantic_center_x = None
    semantic_hold_samples = 0

    for sample_index, sample_t in enumerate(sample_times):
        cap.set(cv2.CAP_PROP_POS_MSEC, sample_t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            continue

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        result = detector.process(rgb)
        scene_change = scene_change_score(cv2, prev_gray, gray)
        divider_x, divider_confidence = vertical_divider_candidate(cv2, np, gray)

        selected_box: Optional[Tuple[float, float, float, float]] = None
        body_box: Optional[Tuple[float, float, float, float]] = None
        motion_box: Optional[Tuple[float, float, float, float]] = None
        saliency_box: Optional[Tuple[float, float, float, float]] = None
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

        mediapipe_face_count = len(faces)
        multi_person_checked = mediapipe_face_count >= 2

        # BlazeFace can miss edge-on or partially cropped podcast guests. When
        # fewer than two people are found, supplement it with frontal and both
        # profile directions from OpenCV, then merge duplicate detections.
        # One supplemental scan per second is enough to prove a sustained
        # conversation layout without tripling analysis time on single speakers.
        if len(faces) < 2 and sample_index % 4 == 0:
            multi_person_checked = True
            haar_faces = []
            haar_scale = min(1.0, 720.0 / max(source_w, 1.0))
            haar_gray = gray if haar_scale >= 0.999 else cv2.resize(
                gray,
                (max(1, int(round(source_w * haar_scale))), max(1, int(round(source_h * haar_scale)))),
                interpolation=cv2.INTER_AREA,
            )
            min_haar_face = max(28, int(round(42 * haar_scale)))
            if not frontal_face_cascade.empty():
                haar_faces.extend(frontal_face_cascade.detectMultiScale(haar_gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_haar_face, min_haar_face)))
            if not profile_face_cascade.empty():
                haar_faces.extend(profile_face_cascade.detectMultiScale(haar_gray, scaleFactor=1.1, minNeighbors=4, minSize=(min_haar_face, min_haar_face)))
                flipped_gray = cv2.flip(haar_gray, 1)
                flipped_profiles = profile_face_cascade.detectMultiScale(flipped_gray, scaleFactor=1.1, minNeighbors=4, minSize=(min_haar_face, min_haar_face))
                haar_faces.extend([(haar_gray.shape[1] - x - w, y, w, h) for (x, y, w, h) in flipped_profiles])
            inverse_haar_scale = 1.0 / max(haar_scale, 1e-6)
            faces.extend(
                (float(x) * inverse_haar_scale, float(y) * inverse_haar_scale, float(w) * inverse_haar_scale, float(h) * inverse_haar_scale)
                for (x, y, w, h) in haar_faces
            )

        faces = dedupe_boxes(faces)
        faces.sort(key=lambda b: b[2] * b[3], reverse=True)

        if scene_change >= 0.72:
            face_tracks = []
            previous_track_boxes = {}

        face_tracks, visible_face_tracks, next_face_track_id = update_face_tracks(
            cv2,
            np,
            face_tracks,
            faces,
            next_face_track_id,
            source_w,
            source_h,
        )
        faces = [track['box'] for track in visible_face_tracks]
        face_track_ids = [track['id'] for track in visible_face_tracks]
        face_observed = [track['observed'] for track in visible_face_tracks]
        if len(visible_face_tracks) >= 2:
            multi_person_checked = True

        if not faces:
            bodies = [] if body_cascade.empty() else list(body_cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(80, 80)))
            if bodies:
                x, y, w, h = max(bodies, key=lambda b: b[2] * b[3])
                body_box = (float(x), float(y), float(w), float(h))

        current_audio = audio_activity[sample_index] if sample_index < len(audio_activity) else 0.0
        mouth_scores = []
        for face, track_id, observed in zip(faces, face_track_ids, face_observed):
            previous_match = previous_track_boxes.get(track_id)
            mouth_scores.append(mouth_motion_score(cv2, prev_gray, gray, face, previous_match) if observed else 0.0)

        selected_mouth_score = 0.0
        selected_speaker_confidence = 0.0
        speaker_score_margin = 0.0
        speaker_scores_by_track = {}

        complete_face_indexes = [
            index for index, face in enumerate(faces)
            if face_is_complete_in_source(face, source_w, source_h)
        ]
        if faces and not complete_face_indexes:
            partial_face_only_samples += 1
        if complete_face_indexes:
            complete_face_samples += 1

        if complete_face_indexes:
            complete_track_ids = [face_track_ids[index] for index in complete_face_indexes]
            scored_faces = []
            for face_index in complete_face_indexes:
                face = faces[face_index]
                mouth_score = mouth_scores[face_index]
                track_id = face_track_ids[face_index]
                observed = face_observed[face_index]
                area_quality = clamp((face[2] * face[3]) / max(1.0, source_w * source_h * 0.08), 0.0, 1.0)
                continuity = 1.0 if track_id == active_track_id else box_match_score(face, active_box, source_w, source_h)
                prior_evidence = float(speaker_evidence_history.get(track_id, 0.0))
                instant_evidence = mouth_score * current_audio
                accumulated_evidence = clamp(prior_evidence * 0.72 + instant_evidence * 0.28, 0.0, 1.0)
                speaker_evidence_history[track_id] = accumulated_evidence
                # Audio gates the mouth evidence. During silence continuity wins,
                # so the crop stays fixed instead of chasing incidental motion.
                continuity_weight = 0.44 - current_audio * 0.22
                observation_bonus = 0.04 if observed else 0.0
                score = clamp(
                    area_quality * 0.12
                    + continuity * continuity_weight
                    + instant_evidence * 0.78
                    + accumulated_evidence * 0.28
                    + observation_bonus,
                    0.0,
                    1.0,
                )
                speaker_scores_by_track[track_id] = score
                scored_faces.append((score, mouth_score, face, track_id))
            scored_faces.sort(key=lambda item: item[0], reverse=True)
            candidate_score, candidate_mouth, candidate_box, candidate_track_id = scored_faces[0]
            active_match = box_match_score(candidate_box, active_box, source_w, source_h)
            should_switch = active_track_id is not None and candidate_track_id != active_track_id
            active_face_index = face_track_ids.index(active_track_id) if active_track_id in face_track_ids else -1
            active_mouth = mouth_scores[active_face_index] if active_face_index >= 0 else 0.0
            strong_speaker_evidence = (
                current_audio >= 0.28
                and candidate_mouth >= 0.12
                and (active_box is None or active_match >= 0.48 or candidate_mouth >= active_mouth + 0.045)
            )

            if active_box is None or active_track_id not in complete_track_ids or scene_change >= 0.72:
                if active_box is not None:
                    shot_id += 1
                    speaker_switches += 1
                active_box = candidate_box
                active_track_id = candidate_track_id
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
                    active_track_id = candidate_track_id
                    pending_box = None
                    pending_count = 0
                    shot_id += 1
                    speaker_switches += 1
            else:
                # Refresh from the same persistent track, including Kalman
                # predictions while a face is briefly turned or occluded.
                if active_track_id in complete_track_ids:
                    active_box = faces[face_track_ids.index(active_track_id)]
                else:
                    best_continuation_index = max(complete_face_indexes, key=lambda idx: box_match_score(faces[idx], active_box, source_w, source_h))
                    if box_match_score(faces[best_continuation_index], active_box, source_w, source_h) >= 0.32:
                        active_box = faces[best_continuation_index]
                        active_track_id = face_track_ids[best_continuation_index]
                pending_box = None
                pending_count = 0

            selected_box = active_box
            selected_index = face_track_ids.index(active_track_id) if active_track_id in face_track_ids else max(complete_face_indexes, key=lambda idx: box_match_score(faces[idx], selected_box, source_w, source_h))
            selected_mouth_score = mouth_scores[selected_index]
            selected_speaker_confidence = float(speaker_scores_by_track.get(active_track_id, candidate_score))
            runner_up_score = max(
                (float(score) for track_id, score in speaker_scores_by_track.items() if track_id != active_track_id),
                default=0.0,
            )
            speaker_score_margin = max(0.0, selected_speaker_confidence - runner_up_score)
            if strong_speaker_evidence:
                confident_speaker_samples += 1

        elif faces:
            # Do not let stale tracking keep a half face selected. Motion and
            # saliency can still preserve non-interview action, but a partial
            # face alone is never a valid camera target.
            active_box = None
            active_track_id = None

        motion_boxes = motion_regions(cv2, prev_gray, gray, source_w, source_h)
        if motion_boxes:
            motion_box = motion_boxes[0]

        saliency_box, saliency_confidence = saliency_region(cv2, np, gray, source_w, source_h)
        screen_score = screen_context_score(cv2, np, gray)
        scene_cut = scene_change >= 0.72
        max_semantic_hold_samples = max(2, int(round(analysis_fps * 0.75)))
        prior_semantic_subject = (
            last_semantic_subject
            if semantic_hold_samples < max_semantic_hold_samples
            else None
        )
        semantic_subject = semantic_subject_choice(
            face_box=selected_box,
            body_box=body_box,
            motion_box=motion_box,
            saliency_box=saliency_box,
            speaker_confidence=selected_speaker_confidence,
            saliency_confidence=saliency_confidence,
            screen_score=screen_score,
            prior=prior_semantic_subject,
            scene_cut=scene_cut,
        )
        semantic_box = semantic_subject.get('box')
        semantic_center_x = center(semantic_box)[0] if semantic_box is not None else source_w / 2.0
        semantic_velocity_x = (
            0.0
            if last_semantic_center_x is None or scene_cut
            else (semantic_center_x - last_semantic_center_x) * analysis_fps
        )
        semantic_subject['velocity_x'] = round(float(semantic_velocity_x), 4)
        if semantic_subject.get('kind') == 'face' and active_track_id is not None:
            semantic_subject['stable_id'] = f'face:{active_track_id}'
        else:
            semantic_subject['stable_id'] = str(semantic_subject.get('kind', 'context'))
        if semantic_subject.get('predicted'):
            semantic_hold_samples += 1
        else:
            semantic_hold_samples = 0
        last_semantic_subject = dict(semantic_subject)
        last_semantic_center_x = semantic_center_x
        fallback_used = bool(semantic_subject.get('predicted')) or semantic_subject.get('kind') == 'context'

        detected_faces.append({
            'timestamp': round(sample_t - start_sec, 3),
            'multi_person_checked': multi_person_checked,
            'divider_x': None if divider_x is None else round(divider_x, 3),
            'divider_confidence': round(float(divider_confidence), 4),
            'faces': [
                {
                    'x': face[0],
                    'y': face[1],
                    'w': face[2],
                    'h': face[3],
                    'cx': center(face)[0],
                    'cy': center(face)[1],
                    'track_id': track_id,
                    'predicted': not observed,
                    'mouth_motion': round(float(mouth_score), 4),
                    'active_speaker_confidence': round(float(speaker_scores_by_track.get(track_id, 0.0)), 4),
                    'person_box': dict_box(person_box_from_face(face, source_w, source_h)),
                    'source_complete': face_is_complete_in_source(face, source_w, source_h),
                    'source_completeness': round(face_source_completeness(face, source_w, source_h), 4),
                }
                for face, track_id, observed, mouth_score in list(zip(faces, face_track_ids, face_observed, mouth_scores))[:4]
            ],
        })

        chosen_center_x = semantic_center_x
        chosen_center_x = clamp(chosen_center_x, source_w * SAFE_EDGE_MARGIN_X, source_w * (1.0 - SAFE_EDGE_MARGIN_X))

        if semantic_box is not None:
            selected_subject_boxes.append(semantic_box)
            _, cy = center(semantic_box)
            chosen_center_y = cy
        else:
            chosen_center_y = source_h / 2.0

        semantic_kind = str(semantic_subject.get('kind', 'context'))
        if semantic_box is not None:
            subject_w = semantic_box[2]
            subject_h = semantic_box[3]
            mode = semantic_kind
            face_height_ratio = semantic_box[3] / max(source_h, 1.0)
            face_width_ratio = semantic_box[2] / max(source_w, 1.0)
            desired_framing = 'wide_context' if (
                semantic_kind in {'context', 'screen'}
                or (
                    semantic_kind == 'face'
                    and (
                        face_height_ratio <= WIDE_FACE_HEIGHT_RATIO
                        or face_width_ratio <= WIDE_FACE_WIDTH_RATIO
                    )
                )
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
            if semantic_kind == 'face':
                normalized_y = semantic_box[1] / max(source_h, 1.0) + 0.08
            else:
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
            'active_track_id': active_track_id,
            'semantic_subject': {
                'kind': semantic_kind,
                'box': dict_box(semantic_box),
                'confidence': round(float(semantic_subject.get('confidence', 0.0)), 4),
                'reason': semantic_subject.get('reason'),
                'predicted': bool(semantic_subject.get('predicted')),
                'stable_id': semantic_subject.get('stable_id'),
                'velocity_x': semantic_subject.get('velocity_x', 0.0),
                'face_box': dict_box(semantic_subject.get('face_box')),
            },
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
            'speaker_confidence': round(max(selected_mouth_score * current_audio, selected_speaker_confidence), 4),
            'speaker_score_margin': round(speaker_score_margin, 4),
            'scene_change': round(scene_change, 4),
            'active_track_id': active_track_id,
            'fallback_used': fallback_used,
            'subject_kind': semantic_kind,
            'subject_confidence': round(float(semantic_subject.get('confidence', 0.0)), 4),
            'selection_reason': semantic_subject.get('reason'),
            'subject_predicted': bool(semantic_subject.get('predicted')),
            'subject_stable_id': semantic_subject.get('stable_id'),
            'subject_velocity_x': semantic_subject.get('velocity_x', 0.0),
        })
        detected_faces[-1].update({
            'active_track_id': active_track_id,
            'selected_box': None if selected_box is None else {
                'x': selected_box[0], 'y': selected_box[1], 'w': selected_box[2], 'h': selected_box[3],
            },
            'chosen_center_x': chosen_center_x,
            'chosen_center_y': chosen_center_y,
            'layout_mode': framing,
            'fallback_used': fallback_used,
            'scene_cut': scene_change >= 0.72,
            'audio_activity': round(current_audio, 4),
            'speaker_confidence': round(max(selected_mouth_score * current_audio, selected_speaker_confidence), 4),
            'speaker_score_margin': round(speaker_score_margin, 4),
            'body_box': dict_box(body_box),
            'motion_box': dict_box(motion_box),
            'saliency_box': dict_box(saliency_box),
            'saliency_confidence': round(float(saliency_confidence), 4),
            'screen_context_score': round(float(screen_score), 4),
            'semantic_subject': {
                'kind': semantic_kind,
                'box': dict_box(semantic_box),
                'confidence': round(float(semantic_subject.get('confidence', 0.0)), 4),
                'reason': semantic_subject.get('reason'),
                'predicted': bool(semantic_subject.get('predicted')),
                'stable_id': semantic_subject.get('stable_id'),
                'velocity_x': semantic_subject.get('velocity_x', 0.0),
                'face_box': dict_box(semantic_subject.get('face_box')),
            },
        })

        prev_gray = gray
        previous_track_boxes = {track_id: face for face, track_id in zip(faces, face_track_ids)}

        if first_debug_frame is None and 0.0 <= rel_t <= duration:
            first_debug_frame = frame.copy()
            first_box = selected_box
            first_motion_box = motion_box

    cap.release()

    # Preroll warms tracking, speaker association, and hysteresis before the
    # requested clip begins. Postroll provides bounded trailing evidence for
    # diagnostics. Neither may leak timestamps outside the exported clip.
    centers_x = [item for item in centers_x if 0.0 <= float(item.get('timestamp', -1.0)) <= duration]
    points = [item for item in points if 0.0 <= float(item.get('t', -1.0)) <= duration]
    detected_faces = [
        item for item in detected_faces
        if 0.0 <= float(item.get('timestamp', -1.0)) <= duration
    ]

    # Audio diarization names speakers but cannot identify a face by itself.
    # Associate each diarized voice with the face track showing the strongest
    # mouth motion during that speaker's turns, then use that evidence to
    # correct ambiguous visual-only selections. This deliberately keeps mouth
    # motion as the identity bridge instead of trusting an unverified model.
    diarization_track_scores = {}
    for frame in detected_faces:
        absolute_t = start_sec + float(frame.get('timestamp', 0.0))
        audio_activity = max(0.15, float(frame.get('audio_activity', 0.0)))
        matching_turns = [
            turn for turn in diarized_turns
            if turn.get('speaker_key')
            and float(turn.get('start_sec', 0.0)) <= absolute_t <= float(turn.get('end_sec', 0.0))
        ]
        for turn in matching_turns:
            speaker_key = str(turn.get('speaker_key'))
            confidence = clamp(float(turn.get('confidence') or 0.65), 0.2, 1.0)
            speaker_scores = diarization_track_scores.setdefault(speaker_key, {})
            for face in frame.get('faces', []):
                track_id = face.get('track_id')
                if track_id is None:
                    continue
                visual_score = float(face.get('mouth_motion', 0.0)) * audio_activity
                visual_score += 0.35 * float(face.get('active_speaker_confidence', 0.0))
                speaker_scores[int(track_id)] = speaker_scores.get(int(track_id), 0.0) + visual_score * confidence

    diarization_track_map = {}
    for speaker_key, scores in diarization_track_scores.items():
        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        if ranked and ranked[0][1] > 0.01:
            runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
            if ranked[0][1] >= runner_up * 1.12:
                diarization_track_map[speaker_key] = ranked[0][0]

    for frame in detected_faces:
        absolute_t = start_sec + float(frame.get('timestamp', 0.0))
        active_turn = next((
            turn for turn in diarized_turns
            if turn.get('speaker_key') in diarization_track_map
            and float(turn.get('start_sec', 0.0)) <= absolute_t <= float(turn.get('end_sec', 0.0))
            and float(turn.get('confidence') or 0.65) >= 0.45
        ), None)
        if not active_turn:
            continue
        track_id = diarization_track_map[str(active_turn.get('speaker_key'))]
        active_face = next((face for face in frame.get('faces', []) if face.get('track_id') == track_id), None)
        if active_face is None:
            continue
        frame['active_track_id'] = track_id
        frame['diarized_speaker_key'] = active_turn.get('speaker_key')
        frame['diarization_fused'] = True
        selected_box = {key: float(active_face[key]) for key in ('x', 'y', 'w', 'h')}
        frame['selected_box'] = selected_box
        frame['chosen_center_x'] = float(active_face.get('cx', selected_box['x'] + selected_box['w'] / 2.0))
        frame['chosen_center_y'] = float(active_face.get('cy', selected_box['y'] + selected_box['h'] / 2.0))
        nearest_point = min(points, key=lambda point: abs(float(point.get('t', 0.0)) - float(frame.get('timestamp', 0.0))), default=None)
        if nearest_point is not None:
            nearest_point['active_track_id'] = track_id
            nearest_point['cx'] = frame['chosen_center_x']
            nearest_point['cy'] = frame['chosen_center_y']
            nearest_point['nx'] = clamp(frame['chosen_center_x'] / max(source_w, 1.0), 0.0, 1.0)
            nearest_point['ny'] = clamp(frame['chosen_center_y'] / max(source_h, 1.0), 0.0, 1.0)
            nearest_point['selection_reason'] = 'diarization_mouth_motion_fusion'
    selected_subject_boxes = [
        (
            float(box['x']),
            float(box['y']),
            float(box['w']),
            float(box['h']),
        )
        for item in detected_faces
        for box in [item.get('selected_box')]
        if isinstance(box, dict)
    ]
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
    dual_observation_opportunities = 0
    for frame in detected_faces:
        if frame.get('multi_person_checked'):
            dual_observation_opportunities += 1
        faces = frame.get('faces', [])
        if len(faces) >= 2:
            faces = sorted(faces[:2], key=lambda f: f['cx'])
            separation = abs(faces[1]['cx'] - faces[0]['cx']) / max(source_w, 1.0)
            size_ratio = min(faces[0]['w'] * faces[0]['h'], faces[1]['w'] * faces[1]['h']) / max(1.0, max(faces[0]['w'] * faces[0]['h'], faces[1]['w'] * faces[1]['h']))
            if separation >= 0.18 and size_ratio >= 0.38:
                dual_frames += 1

    dual_frame_ratio = dual_frames / max(1, dual_observation_opportunities)
    fixed_two_panel = detect_fixed_two_panel_layout(detected_faces, source_w, source_h)
    if fixed_two_panel is not None:
        divider_x = float(fixed_two_panel['divider_x'])
        for frame in detected_faces:
            frame['fixed_two_panel'] = fixed_two_panel
            active_id = frame.get('active_track_id')
            active_face = next(
                (face for face in frame.get('faces', []) if face.get('track_id') == active_id),
                None,
            )
            if active_face is not None:
                frame['active_panel'] = 'left' if float(active_face.get('cx', 0.0)) < divider_x else 'right'
    # Produce timed layout decisions after tracking/speaker evidence is known.
    # Never collapse a multi-person reel into one whole-clip layout.
    reframe_timeline = build_reframe_timeline(points, detected_faces, source_w, source_h, duration)
    reframe_timeline, editorial_summary = plan_editorial_timeline(reframe_timeline, editorial_plan)
    reframe_timeline, layout_qa_summary = validate_layout_timeline(
        reframe_timeline, detected_faces, source_w, source_h
    )
    debug_overlay_path = None
    if debug_enabled:
        debug_overlay_path = save_debug_video(
            cv2,
            input_path,
            debug_dir / f'{clip_id}-reframe-debug.mp4',
            start_sec,
            source_w,
            source_h,
            detected_faces,
            reframe_timeline,
            analysis_fps,
        )

    unique_track_ids = sorted({
        int(face['track_id'])
        for frame in detected_faces
        for face in frame.get('faces', [])
        if face.get('track_id') is not None
    })
    detection_count = sum(
        1 for frame in detected_faces for face in frame.get('faces', []) if not face.get('predicted', False)
    )
    predicted_samples = sum(
        1 for frame in detected_faces if any(face.get('predicted', False) for face in frame.get('faces', []))
    )
    fallback_count = sum(1 for item in centers_x if item.get('fallback_used'))
    scene_cut_count = sum(1 for frame in detected_faces if frame.get('scene_cut'))
    layout_changes = max(0, len(reframe_timeline) - 1)
    layout_modes = sorted({str(segment.get('mode')) for segment in reframe_timeline})
    partial_face_only_ratio = partial_face_only_samples / max(1, len(points))
    reject_for_partial_faces = bool(
        partial_face_only_ratio >= UNSAFE_FACE_REJECT_RATIO
        and complete_face_samples == 0
    )

    result = {
        'ok': True,
        'mode': 'dynamic_timeline',
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
            'sample_count': len(points),
            'analysis_sample_count': sample_count,
            'frames_with_detection_pct': len(selected_subject_boxes) / max(1, len(points)),
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
            'track_switches': speaker_switches,
            'detection_count': detection_count,
            'track_count': len(unique_track_ids),
            'track_ids': unique_track_ids,
            'scene_cuts': scene_cut_count,
            'layout_mode_changes': layout_changes,
            'detection_fallback_count': fallback_count,
            'samples_using_prediction': predicted_samples,
            'confident_speaker_samples': confident_speaker_samples,
            'wide_context_samples': wide_context_samples,
            'analysis_rate_fps': sample_count / analysis_duration,
            'analysis_window': {
                'start_sec': round(analysis_start_sec, 3),
                'end_sec': round(analysis_end_sec, 3),
                'preroll_sec': round(start_sec - analysis_start_sec, 3),
                'postroll_sec': round(analysis_end_sec - end_sec, 3),
            },
            'dual_frames': dual_frames,
            'dual_observation_opportunities': dual_observation_opportunities,
            'dual_frame_ratio': round(dual_frame_ratio, 4),
            'source_layout': None if fixed_two_panel is None else fixed_two_panel['mode'],
            'fixed_two_panel': fixed_two_panel,
            'timeline_segments': len(reframe_timeline),
            'layout_modes': layout_modes,
            'editorial_planner': editorial_summary,
            'layout_qa': layout_qa_summary,
            'partial_face_only_samples': partial_face_only_samples,
            'partial_face_only_ratio': round(partial_face_only_ratio, 4),
            'complete_face_samples': complete_face_samples,
            'visual_clip_usable': not reject_for_partial_faces,
            'visual_reject_reason': 'sustained_partial_faces_only' if reject_for_partial_faces else None,
            'debug_overlay_path': debug_overlay_path,
        },
        'reframe_timeline': reframe_timeline,
        'detected_faces': detected_faces,
        'ffmpeg_crop': f'crop={int(round(crop_w))}:{int(round(crop_h))}:{int(round(crop_x))}:{int(round(crop_y))},scale=1080:1920',
    }
    metadata_path = os.environ.get('SMART_REFRAME_METADATA_PATH', '').strip()
    if metadata_path:
        metadata_output = Path(metadata_path)
        metadata_output.parent.mkdir(parents=True, exist_ok=True)
        metadata_output.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
