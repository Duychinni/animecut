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
UNSAFE_OPENING_SEC = 1.25
UNSAFE_SPEECH_CONTEXT_SEC = 1.50
MIN_OUTPUT_FACE_HEIGHT_RATIO = 0.135
MOTION_MIN_AREA_RATIO = 0.0035
AUDIO_SAMPLE_RATE = 16000
AUDIO_WINDOW_SEC = 0.18
SPEAKER_SWITCH_CONFIRM_SAMPLES = 2
FRAMING_SWITCH_CONFIRM_SAMPLES = 2
LAYOUT_MIN_HOLD_SAMPLES = 4
LAYOUT_CONFIRM_SAMPLES = 2
STACK_PAIR_CONFIRM_SAMPLES = 3
STACK_ENTER_CONFIRM_SAMPLES = 2
STACK_PARTICIPATION_WINDOW_SEC = 6.0
STACK_TURN_WINDOW_SEC = 4.5
STACK_REACTION_WINDOW_SEC = 3.0
STACK_MIN_RAPID_SWITCHES = 2
STACK_SCORE_MARGIN = 0.15
STACK_LAYOUT_ENABLED = True
SCENE_CUT_LOOKAHEAD_SEC = 0.125
WIDE_FACE_HEIGHT_RATIO = 0.22
WIDE_FACE_WIDTH_RATIO = 0.105
FIXED_PANEL_FACE_HEIGHT_RATIO = 0.13
STREAMER_PANEL_FACE_HEIGHT_RATIO = 0.075
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


def visual_usability(points, timeline):
    """Reject shorts that open on, or sustain, unusable context during speech.

    A full-source fallback can avoid cutting a face while still producing a
    terrible vertical reel: tiny people around an empty set, furniture, or a
    divider. Those frames are acceptable only for a deliberate long silence.
    """
    if not points:
        return False, 'no_visual_samples'

    def point_is_speaking(point):
        return float(point.get('audio_activity', 0.0)) >= SILENCE_AUDIO_THRESHOLD

    def segment_at(timestamp):
        return next(
            (
                segment for segment in timeline
                if float(segment.get('start', 0.0)) - 0.001
                <= timestamp
                <= float(segment.get('end', 0.0)) + 0.001
            ),
            None,
        )

    speaking_points = [point for point in points if point_is_speaking(point)]
    non_face_context_points = [
        point for point in speaking_points
        if str(point.get('subject_kind', '')).lower()
        in ('screen', 'body', 'person', 'action', 'saliency')
        and float(point.get('subject_confidence', 0.0)) >= 0.40
    ]
    # In gameplay, demonstrations, workouts, and cooking footage, a detector
    # may briefly promote a tiny or partial face even though the clip is
    # overwhelmingly driven by screen/action context. Do not reject the whole
    # reel because of those short face-classification islands.
    non_face_context_dominant = bool(
        speaking_points
        and len(non_face_context_points) / len(speaking_points) >= 0.55
    )

    unsafe_speech_times = []
    unsafe_opening_times = []
    undersized_speech_times = []
    for point in points:
        timestamp = float(point.get('t', 0.0))
        segment = segment_at(timestamp)
        # The layout name alone is not proof that a person is actually in the
        # portrait crop. A "single" fallback can still land on a desk, stage,
        # or a source-edge sliver of somebody. During speech, require a
        # detector-verified complete face target; otherwise reject the
        # candidate after a very short tolerance window and let the pipeline
        # choose another reel.
        verified_person = bool(
            (
                point.get('subject_kind') == 'face'
                and point.get('face_source_complete') is True
                and point.get('face_box')
            )
            or (
                segment
                and segment.get('mode') == 'stacked'
                and segment.get('topBox')
                and segment.get('bottomBox')
            )
        )
        subject_kind = str(point.get('subject_kind', '')).lower()
        subject_confidence = float(point.get('subject_confidence', 0.0))
        verified_non_face_context = bool(
            (
                subject_kind == 'screen'
                and subject_confidence >= 0.58
                and segment
                and segment.get('mode') == 'wide_context'
            )
            or (
                subject_kind in ('body', 'person', 'action', 'saliency')
                and subject_confidence >= 0.40
                and segment
                and segment.get('mode') == 'single'
            )
            or (
                segment
                and segment.get('mode') == 'wide_context'
                and segment.get('wideKind') == 'broll'
            )
        )
        unsafe_context = not (
            verified_person
            or verified_non_face_context
            or non_face_context_dominant
        )
        if not unsafe_context or not point_is_speaking(point):
            face_box = point.get('face_box') or {}
            face_height = float(face_box.get('h', 0.0))
            segment_points = (segment or {}).get('points') or []
            nearest = min(
                segment_points,
                key=lambda item: abs(float(item.get('t', timestamp)) - timestamp),
                default={},
            )
            crop_height = float(nearest.get('cropH', 0.0))
            if (
                point_is_speaking(point)
                and segment
                and segment.get('mode') == 'single'
                and face_height > 0
                and crop_height > 0
                and face_height / crop_height < MIN_OUTPUT_FACE_HEIGHT_RATIO
            ):
                undersized_speech_times.append(timestamp)
            continue
        unsafe_speech_times.append(timestamp)
        if timestamp <= UNSAFE_OPENING_SEC:
            unsafe_opening_times.append(timestamp)

    analysis_rate = max(
        1.0,
        len(points) / max(0.25, float(points[-1].get('t', 0.0)) - float(points[0].get('t', 0.0)) + 0.25),
    )
    if len(unsafe_opening_times) >= max(2, math.ceil(analysis_rate * 0.50)):
        return False, 'unframed_speaking_subject_at_open'

    longest_run = 0
    current_run = 0
    previous_time = None
    max_gap = 1.5 / analysis_rate
    for timestamp in unsafe_speech_times:
        if previous_time is not None and timestamp - previous_time <= max_gap:
            current_run += 1
        else:
            current_run = 1
        longest_run = max(longest_run, current_run)
        previous_time = timestamp
    # A speaking reel must remain people-led throughout, not merely at its
    # opening. Tracking already predicts through a brief missed detection, so
    # two consecutive unverified samples indicate a real framing loss. Reject
    # at that point instead of publishing an empty stage, divider, or partial
    # person.
    max_unframed_speech_sec = min(0.25, UNSAFE_SPEECH_CONTEXT_SEC)
    if longest_run >= max(2, math.ceil(analysis_rate * max_unframed_speech_sec)):
        return False, 'sustained_unframed_speaking_subject'

    longest_small_run = 0
    current_small_run = 0
    previous_time = None
    for timestamp in undersized_speech_times:
        if previous_time is not None and timestamp - previous_time <= max_gap:
            current_small_run += 1
        else:
            current_small_run = 1
        longest_small_run = max(longest_small_run, current_small_run)
        previous_time = timestamp
    if longest_small_run >= max(2, math.ceil(analysis_rate * UNSAFE_SPEECH_CONTEXT_SEC)):
        return False, 'speaking_subject_too_small'

    return True, None


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
    if face_box is not None:
        # A small but confidently detected speaking face must not leave the
        # entire stage shrunk inside a vertical reel. Compose an intentional
        # head-and-torso crop, while bounding enlargement to retain usable
        # source detail.
        face_height = max(1.0, float(face_box[3]))
        crop_h = min(
            float(source_h),
            max(float(source_h) * 0.38, face_height * 4.8),
        )
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
                            screen_score=0.0, face_area_ratio=1.0,
                            body_area_ratio=0.0, motion_area_ratio=0.0,
                            prior=None, scene_cut=False):
    """Choose the ROI using the production semantic priority hierarchy."""
    # Gameplay, reaction, tutorial, and webinar sources commonly contain a
    # small facecam over a visually essential screen. A face detector alone
    # must not turn that overlay into a full-frame crop and discard the actual
    # content. Preserve the composite when the screen evidence is strong and
    # the detected face occupies only a small overlay-sized region.
    tiny_face_over_screen = (
        face_box is not None
        and float(face_area_ratio) <= 0.035
        and screen_score >= 0.58
    )
    stable_screen_context = float(motion_area_ratio) <= 0.08
    if (
        screen_score >= 0.58
        and (face_box is None or tiny_face_over_screen)
        and body_box is None
        and (stable_screen_context or tiny_face_over_screen)
    ):
        return {'kind': 'screen', 'box': None, 'confidence': screen_score, 'reason': 'screen_or_text_context', 'predicted': False}
    # Fitness, stage demonstrations, cooking, and product tutorials may include
    # a detectable face while the meaningful visual is the person's body and
    # hands. When the face is small but a substantial body region is present,
    # frame the action instead of producing a talking-head crop.
    full_body_context = (
        face_box is not None
        and body_box is not None
        and float(face_area_ratio) <= 0.030
        and float(body_area_ratio) >= 0.14
    )
    if full_body_context:
        return {'kind': 'body', 'box': body_box, 'confidence': 0.64, 'reason': 'full_body_action_context', 'predicted': False}
    if face_box is not None:
        confidence = max(0.62, float(speaker_confidence))
        reason = 'confident_active_speaker' if speaker_confidence >= 0.42 else 'main_visible_face'
        return {'kind': 'face', 'box': face_box, 'face_box': face_box, 'confidence': confidence, 'reason': reason, 'predicted': False}
    # A face is the authoritative camera target for dialogue footage. Face
    # detectors commonly miss a few samples when someone turns, laughs, covers
    # their mouth, or gestures. During that brief gap, keep the established
    # face composition instead of allowing a hand, body edge, or background
    # motion region to pull the virtual camera away. A real shot cut clears
    # this hold immediately.
    if (
        prior is not None
        and prior.get('kind') == 'face'
        and prior.get('box') is not None
        and not scene_cut
    ):
        return {
            **prior,
            'confidence': max(0.24, float(prior.get('confidence', 0.0)) * 0.90),
            'reason': 'face_lock_detection_gap',
            'predicted': True,
        }
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
    # A fixed split-screen source often places each participant in only half
    # of a 16:9 canvas. Using the full source height can leave that otherwise
    # complete face tiny in the 9:16 result. Zoom within the person's own
    # panel until the face has intentional portrait presence; this is a crop,
    # not a reason to reject an otherwise usable speaking moment.
    face_h = max(1.0, float(face[3]))
    crop_h = min(source_h, max(face_h / 0.24, face_h * 3.6))
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
    """Detect a persistent interview/streamer split without chasing its speakers.

    Side-by-side streamer sources commonly devote only a small part of each
    panel to a webcam. Those faces are materially smaller than studio interview
    faces, but a stable visual divider plus persistent people on both sides is
    stronger layout evidence than face size alone. Once classified, rendering
    keeps both regions locked instead of cutting on every speaker estimate.
    """
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
    has_stable_divider = divider_x is not None

    # Some interview sources have no visible gutter. Persistent, well-separated
    # tracks still define two stable source regions; this is classification,
    # never permission to crop their combined midpoint.
    if divider_x is None:
        track_samples = {}
        for frame in frames:
            for face in frame.get('faces', []):
                if face.get('track_id') is None or bool(face.get('predicted')):
                    continue
                if float(face.get('h', 0.0)) < source_h * FIXED_PANEL_FACE_HEIGHT_RATIO:
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
    panel_face_height_ratio = (
        STREAMER_PANEL_FACE_HEIGHT_RATIO
        if has_stable_divider
        else FIXED_PANEL_FACE_HEIGHT_RATIO
    )
    for frame in frames:
        faces = [
            face for face in frame.get('faces', [])
            if (
                not face.get('predicted')
                and float(face.get('h', 0.0)) >= source_h * panel_face_height_ratio
            )
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
        'panel_face_height_ratio': round(panel_face_height_ratio, 4),
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
            first_track = first.get('track_id')
            second_track = second.get('track_id')
            if (
                first_track is not None
                and second_track is not None
                and int(first_track) == int(second_track)
            ):
                continue
            first_area = max(1.0, float(first.get('w', 0)) * float(first.get('h', 0)))
            second_area = max(1.0, float(second.get('w', 0)) * float(second.get('h', 0)))
            separation = abs(float(first.get('cx', 0)) - float(second.get('cx', 0))) / max(source_w, 1.0)
            size_ratio = min(first_area, second_area) / max(first_area, second_area)
            first_tuple = (
                float(first.get('x', 0)), float(first.get('y', 0)),
                float(first.get('w', 0)), float(first.get('h', 0)),
            )
            second_tuple = (
                float(second.get('x', 0)), float(second.get('y', 0)),
                float(second.get('w', 0)), float(second.get('h', 0)),
            )
            # Face detectors can emit two offset boxes for one large close-up.
            # Track ids alone do not prove that two different people exist.
            if separation < 0.14 or size_ratio < 0.22 or box_iou(first_tuple, second_tuple) > 0.18:
                continue
            score = (first_area + second_area) * (0.7 + min(0.3, separation)) * (0.72 + size_ratio * 0.28)
            if score > best_score:
                best_score = score
                best = (first, second)
    if best is None:
        return None
    return tuple(sorted(best, key=lambda item: float(item.get('cx', 0))))


def distinct_face_detections(faces):
    """Collapse offset duplicate boxes emitted for one large close-up face."""
    distinct = []
    ranked = sorted(
        faces,
        key=lambda face: (
            float(face.get('active_speaker_confidence', 0.0)),
            float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
        ),
        reverse=True,
    )
    for face in ranked:
        candidate = (
            float(face.get('x', 0)), float(face.get('y', 0)),
            float(face.get('w', 0)), float(face.get('h', 0)),
        )
        if any(
            box_iou(
                candidate,
                (
                    float(existing.get('x', 0)), float(existing.get('y', 0)),
                    float(existing.get('w', 0)), float(existing.get('h', 0)),
                ),
            ) > 0.18
            for existing in distinct
        ):
            continue
        distinct.append(face)
    return distinct


def apply_shot_entry_lookahead(points, frames, source_w: float, source_h: float, max_samples=10):
    """Backfill an incoming shot's first unconfirmed samples from that shot.

    Detection is intentionally sampled sparsely, so the first observation after
    an edit can contain no face even though the next observation clearly does.
    Rendering that gap as full-frame creates a visible layout flash between
    stacked and solo compositions. Because this is an offline render, use the
    first confirmed face(s) later in the same shot from the exact cut boundary.
    Never borrow geometry from before the cut or across a second cut.
    """
    prepared_points = [dict(point) for point in points]
    prepared_frames = [
        {
            **frame,
            'faces': [dict(face) for face in frame.get('faces', [])],
        }
        for frame in frames
    ]

    def complete_faces(frame):
        return [
            face for face in frame.get('faces', [])
            # A predicted box belongs to the preceding observation and is
            # specifically unsafe as proof of who appears after a cut.
            if not bool(face.get('predicted'))
            if face_is_complete_in_source(
                (
                    float(face.get('x', 0.0)), float(face.get('y', 0.0)),
                    float(face.get('w', 0.0)), float(face.get('h', 0.0)),
                ),
                source_w,
                source_h,
            )
        ]

    for cut_index, (point, frame) in enumerate(zip(prepared_points, prepared_frames)):
        scene_change = float(point.get('scene_change', 1.0 if frame.get('scene_cut') else 0.0))
        if cut_index == 0:
            continue
        explicit_cut = bool(frame.get('scene_cut') or scene_change >= 0.38)
        # Lookahead is a shot-entry repair, not a general face-tracking pass.
        # Running it on every ordinary sample lets normal detector-box drift
        # compare the current face with a later pose and invent a new shot.
        # Require at least a real visual discontinuity before geometry may
        # infer a subtle solo/solo or solo/pair edit.
        plausible_cut = bool(explicit_cut or scene_change >= 0.12)

        confirmed_index = None
        confirmed_faces = None
        confirmed_score = -1.0
        search_end = min(len(prepared_frames), cut_index + max_samples + 1)
        for future_index in range(cut_index, search_end):
            future_point = prepared_points[future_index]
            future_frame = prepared_frames[future_index]
            future_change = float(
                future_point.get('scene_change', 1.0 if future_frame.get('scene_cut') else 0.0)
            )
            if future_index > cut_index and (future_frame.get('scene_cut') or future_change >= 0.38):
                break
            complete = complete_faces(future_frame)
            if not complete:
                continue
            # Do not let a one-sample hand/edge false positive declare the
            # incoming shot ready. Require the same solo face or face pair in
            # the following sample before using it as the shot-wide anchor.
            next_index = future_index + 1
            if next_index >= search_end:
                continue
            next_frame = prepared_frames[next_index]
            next_point = prepared_points[next_index]
            next_change = float(
                next_point.get('scene_change', 1.0 if next_frame.get('scene_cut') else 0.0)
            )
            if next_frame.get('scene_cut') or next_change >= 0.38:
                continue
            next_complete = complete_faces(next_frame)
            current_pair = strongest_face_pair(complete, source_w)
            next_pair = strongest_face_pair(next_complete, source_w)
            if bool(current_pair) != bool(next_pair):
                continue
            current_candidates = list(current_pair) if current_pair is not None else complete
            next_candidates = list(next_pair) if next_pair is not None else next_complete
            stable_matches = sum(
                1 for candidate in current_candidates
                if any(
                    box_match_score(
                        (
                            float(candidate.get('x', 0.0)), float(candidate.get('y', 0.0)),
                            float(candidate.get('w', 0.0)), float(candidate.get('h', 0.0)),
                        ),
                        (
                            float(other.get('x', 0.0)), float(other.get('y', 0.0)),
                            float(other.get('w', 0.0)), float(other.get('h', 0.0)),
                        ),
                        source_w,
                        source_h,
                    ) >= 0.48
                    for other in next_candidates
                )
            )
            required_matches = 2 if current_pair is not None else 1
            if stable_matches >= required_matches:
                stable_faces = list(current_pair) if current_pair is not None else complete
                geometry_score = sum(
                    float(candidate.get('w', 0.0)) * float(candidate.get('h', 0.0))
                    for candidate in stable_faces
                ) / max(1.0, source_w * source_h)
                confidence_score = max(
                    float(candidate.get('active_speaker_confidence', 0.0))
                    for candidate in stable_faces
                )
                # Prefer the strongest stable composition anywhere in the
                # short incoming-shot window, rather than the first stable
                # blob. A hand can be detected twice; it should still lose to
                # the large, high-confidence face acquired 500 ms later.
                candidate_score = geometry_score * 2.4 + confidence_score
                if candidate_score > confirmed_score:
                    confirmed_index = future_index
                    confirmed_faces = complete
                    confirmed_score = candidate_score
                if candidate_score >= 0.72 and current_pair is None:
                    # The first clearly face-sized, confident composition is
                    # the editorial target. Do not scan farther and preframe a
                    # different participant who happens to appear later. A
                    # pair keeps scanning through the short window because one
                    # close-up face can briefly be emitted as two fragments.
                    break

        if confirmed_index is None or not confirmed_faces:
            continue

        confirmed_frame = prepared_frames[confirmed_index]
        confirmed_point = prepared_points[confirmed_index]
        pair = strongest_face_pair(confirmed_faces, source_w)
        previous_faces = complete_faces(prepared_frames[cut_index - 1])
        previous_pair = strongest_face_pair(previous_faces, source_w)
        confirmed_primary = max(
            list(pair) if pair is not None else confirmed_faces,
            key=lambda face: (
                float(face.get('active_speaker_confidence', 0.0)),
                float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
            ),
        )
        previous_primary_match = max(
            (
                box_match_score(
                    (
                        float(confirmed_primary.get('x', 0.0)), float(confirmed_primary.get('y', 0.0)),
                        float(confirmed_primary.get('w', 0.0)), float(confirmed_primary.get('h', 0.0)),
                    ),
                    (
                        float(previous.get('x', 0.0)), float(previous.get('y', 0.0)),
                        float(previous.get('w', 0.0)), float(previous.get('h', 0.0)),
                    ),
                    source_w,
                    source_h,
                )
                for previous in previous_faces
            ),
            default=0.0,
        )
        confirmed_primary_cx = float(
            confirmed_primary.get(
                'cx',
                float(confirmed_primary.get('x', 0.0)) + float(confirmed_primary.get('w', 0.0)) / 2.0,
            )
        )
        previous_primary_center_distance = min(
            (
                abs(
                    confirmed_primary_cx
                    - float(
                        previous.get(
                            'cx',
                            float(previous.get('x', 0.0)) + float(previous.get('w', 0.0)) / 2.0,
                        )
                    )
                ) / max(source_w, 1.0)
                for previous in previous_faces
            ),
            default=1.0,
        )
        inferred_layout_change = bool(
            (plausible_cut or not complete_faces(frame))
            and
            previous_faces
            and bool(previous_pair is not None) != bool(pair is not None)
        )
        inferred_solo_subject_change = bool(
            plausible_cut
            and
            previous_faces
            and previous_pair is None
            and pair is None
            and previous_primary_match < 0.40
        )
        # Gestures, exposure changes, and microphone movement can produce a
        # moderate frame-difference spike while the same face remains in the
        # same place. Treating each spike as a new shot creates a visible crop
        # jump even when the person barely moves. Only a hard cut or genuinely
        # different face geometry may break the established tripod lock.
        if (
            explicit_cut
            and scene_change < 0.72
            and not inferred_layout_change
            and not inferred_solo_subject_change
            and previous_primary_match >= 0.48
            and previous_primary_center_distance <= 0.10
        ):
            explicit_cut = False
            prepared_points[cut_index]['scene_change'] = 0.0
            prepared_frames[cut_index]['scene_cut'] = False
        # A detector gap alone is not a shot boundary. It becomes an atomic
        # layout transition only when the confirmed geometry changes between
        # one person and two people. This catches visually subtle talk-show
        # cuts that the histogram scene detector can miss.
        if (
            not explicit_cut
            and not inferred_layout_change
            and not inferred_solo_subject_change
        ):
            continue
        lookahead_faces = list(pair) if pair is not None else [
            max(
                confirmed_faces,
                key=lambda face: (
                    float(face.get('active_speaker_confidence', 0.0)),
                    float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
                ),
            )
        ]
        future_active_id = confirmed_frame.get('active_track_id')
        primary = next(
            (
                face for face in lookahead_faces
                if future_active_id is not None
                and face.get('track_id') is not None
                and int(face.get('track_id')) == int(future_active_id)
            ),
            max(
                lookahead_faces,
                key=lambda face: float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
            ),
        )
        primary_id = primary.get('track_id')
        confidence = max(
            0.32,
            float(
                confirmed_point.get(
                    'speaker_confidence',
                    primary.get('active_speaker_confidence', 0.0),
                )
            ),
        )

        entry_start_index = cut_index
        if (inferred_layout_change or inferred_solo_subject_change) and not explicit_cut:
            # The face/layout change can be confirmed one or two samples after
            # the actual edit. Look backward for the first visual discontinuity
            # in that short detector-latency window and replace from there.
            # Otherwise a close-up can be rendered briefly with the outgoing
            # stacked boxes, showing two pieces of the same person.
            backward_start = max(1, cut_index - 3)
            discontinuities = [
                (
                    previous_index,
                    float(prepared_points[previous_index].get('scene_change', 0.0)),
                )
                for previous_index in range(backward_start, cut_index + 1)
                if float(prepared_points[previous_index].get('scene_change', 0.0)) >= 0.12
            ]
            if discontinuities:
                entry_start_index = max(
                    discontinuities,
                    key=lambda item: (item[1], -item[0]),
                )[0]

        # Also replace an unstable detection on the cut sample itself. The old
        # implementation skipped lookahead whenever *any* complete box was
        # present, which is how a hand/edge false positive became a visible
        # one-second portrait crop before the real face was acquired.
        for entry_index in range(entry_start_index, confirmed_index + 1):
            entry_frame = prepared_frames[entry_index]
            entry_point = prepared_points[entry_index]
            entry_frame['faces'] = [dict(face) for face in lookahead_faces]
            entry_frame['active_track_id'] = primary_id
            entry_frame['selected_box'] = dict(primary)
            entry_frame['semantic_subject'] = {
                'kind': 'face',
                'box': dict(primary),
                'face_box': dict(primary),
                'confidence': confidence,
                'reason': 'incoming_shot_face_lookahead',
                'predicted': False,
                'stable_id': f'face:{primary_id}' if primary_id is not None else 'face:incoming-shot',
                'velocity_x': 0.0,
            }
            # A fixed-panel classification from the outgoing camera angle is
            # never authoritative for a solo incoming shot.
            if pair is None:
                entry_frame['fixed_two_panel'] = None
            entry_point['subject_kind'] = 'face'
            entry_point['subject_confidence'] = confidence
            entry_point['selection_reason'] = 'incoming_shot_face_lookahead'
            entry_point['subject_predicted'] = False
            entry_point['subject_stable_id'] = (
                f'face:{primary_id}' if primary_id is not None else 'face:incoming-shot'
            )
            entry_point['speaker_confidence'] = confidence
            entry_point['fallback_used'] = False
            if (inferred_layout_change or inferred_solo_subject_change) and not explicit_cut:
                # Create a hard timeline boundary at the first uncertain
                # sample without pretending the source detector found a hard
                # cut. The incoming confirmed composition is rendered from
                # this exact point, never through a safe-wide/searching frame.
                entry_point['scene_change'] = max(
                    0.72, float(entry_point.get('scene_change', 0.0))
                )
                entry_point['inferred_shot_boundary'] = True

    return prepared_points, prepared_frames


def lock_unstable_panel_composition(segments):
    """Keep repeatedly alternating panel/group footage in one composition."""
    if len(segments) < 7:
        return segments
    if any(segment.get('mode') in ('grid', 'source_vertical') for segment in segments):
        return segments

    contextual_segments = [
        segment for segment in segments
        if segment.get('mode') == 'wide_context'
    ]
    if len(contextual_segments) < 3:
        return segments

    transitions = sum(
        1 for index in range(1, len(segments))
        if segments[index].get('mode') != segments[index - 1].get('mode')
    )

    clip_start = float(segments[0].get('start', 0.0))
    clip_end = float(segments[-1].get('end', clip_start))
    clip_duration = max(0.001, clip_end - clip_start)
    wide_duration = sum(
        max(0.0, float(segment.get('end', 0.0)) - float(segment.get('start', 0.0)))
        for segment in contextual_segments
    )
    wide_ratio = wide_duration / clip_duration
    # Three transitions are already a visible wide -> close -> wide pulse.
    # Keep the stricter four-transition threshold for mixed timelines, but
    # catch this pattern when contextual framing clearly dominates the reel.
    if transitions < 3 or (transitions < 4 and wide_ratio < 0.60):
        return segments
    panel_layouts = {
        'TWO_PERSON_CONVERSATION',
        'THREE_PERSON_COMPOSITION',
        'PANEL_GRID',
    }
    panel_segments = [
        segment for segment in segments
        if str(segment.get('editorialLayout', '')).upper() in panel_layouts
    ]
    panel_duration = sum(
        max(0.0, float(segment.get('end', 0.0)) - float(segment.get('start', 0.0)))
        for segment in panel_segments
    )
    panel_ratio = panel_duration / clip_duration
    action_duration = sum(
        max(0.0, float(segment.get('end', 0.0)) - float(segment.get('start', 0.0)))
        for segment in segments
        if str(segment.get('editorialSceneType', '')).upper() in {
            'FULL_BODY_ACTION',
            'OBJECT_DEMO',
            'SCREEN_CONTENT',
        }
    )
    action_ratio = action_duration / clip_duration
    # Seeing two people for a moment is not panel evidence. Handheld vlogs,
    # store walk-throughs, sports, and demonstrations frequently include a
    # second person while the camera and primary subject keep moving. Locking
    # those clips into one panel composition destroys real shot boundaries and
    # turns the detector samples into a violently jumping virtual camera.
    verified_panel_layout = bool(
        len(panel_segments) >= 2
        and panel_ratio >= 0.30
        and action_ratio < 0.35
    )
    verified_split_layout = any(
        segment.get('mode') == 'stacked'
        and segment.get('topBox')
        and segment.get('bottomBox')
        for segment in segments
    )
    continuously_multi_person = all(
        int(segment.get('visibleCountMax', segment.get('visibleCount', 0)) or 0) >= 2
        for segment in segments
    )
    # A second face/body detection is supporting evidence only. Workout and
    # demonstration footage commonly contains a bystander, coach, reflection,
    # or partial body while one primary athlete should remain portrait-framed.
    # Require either an editorial panel classification or a verified two-pane
    # composition before locking the entire reel to a tiny safe-wide strip.
    panel_evidence = bool(
        verified_panel_layout
        or (verified_split_layout and continuously_multi_person)
    )
    if action_ratio >= 0.50:
        panel_evidence = False
    # A wide-dominant clip is the strongest reason to hold the established
    # contextual composition. The old upper bound returned the alternating
    # timeline unchanged once safe-wide occupied more than 60% of the reel,
    # allowing brief portrait crops to pulse in and out of an otherwise stable
    # full-panel shot.
    if not panel_evidence or wide_ratio < 0.08:
        return segments

    points = [point for segment in segments for point in segment.get('points', [])]
    locked = dict(segments[0])
    locked.update({
        'start': round(clip_start, 3),
        'end': round(clip_end, 3),
        'mode': 'wide_context',
        'wideKind': 'safe_wide',
        'primaryTrackId': None,
        'topTrackId': None,
        'bottomTrackId': None,
        'topBox': None,
        'bottomBox': None,
        'subjects': [],
        'points': points,
        'sceneCutStart': False,
        'moderateCutStart': False,
        'hardCutStart': False,
        'inferredCutStart': False,
        'renderBranch': 'stable_panel_composition',
        'editorialReason': 'Repeated panel-wide/close-up switching was locked to one readable composition.',
    })
    return [locked]


def lock_handheld_source_composition(segments):
    """Let an already-operated handheld camera follow the action naturally."""
    if len(segments) < 12:
        return segments
    if any(segment.get('mode') in ('grid', 'source_vertical') for segment in segments):
        return segments

    clip_start = float(segments[0].get('start', 0.0))
    clip_end = float(segments[-1].get('end', clip_start))
    clip_duration = max(0.001, clip_end - clip_start)
    source_led_layouts = {
        'TRACK_ACTION',
        'BROLL_FILL',
        'PRESERVE_SCREEN',
    }
    source_led_duration = sum(
        max(0.0, float(segment.get('end', 0.0)) - float(segment.get('start', 0.0)))
        for segment in segments
        if str(segment.get('editorialLayout', '')).upper() in source_led_layouts
    )
    conversation_duration = sum(
        max(0.0, float(segment.get('end', 0.0)) - float(segment.get('start', 0.0)))
        for segment in segments
        if str(segment.get('editorialLayout', '')).upper() in {
            'TWO_PERSON_CONVERSATION',
            'THREE_PERSON_COMPOSITION',
            'PANEL_GRID',
        }
    )
    source_led_ratio = source_led_duration / clip_duration
    conversation_ratio = conversation_duration / clip_duration
    if source_led_ratio < 0.45 or conversation_ratio >= 0.35:
        return segments

    # In vlogs, store walk-throughs, sports, demonstrations, and edited B-roll,
    # the source camera is already following the important subject. Replacing
    # its decisions with dozens of detector-driven portrait crops creates
    # artificial snap-pans whenever faces enter, leave, overlap, or blur.
    locked = dict(segments[0])
    locked.update({
        'start': round(clip_start, 3),
        'end': round(clip_end, 3),
        'mode': 'wide_context',
        'wideKind': 'safe_wide',
        'primaryTrackId': None,
        'topTrackId': None,
        'bottomTrackId': None,
        'topBox': None,
        'bottomBox': None,
        'subjects': [],
        'points': [],
        'sceneCutStart': False,
        'moderateCutStart': False,
        'hardCutStart': False,
        'inferredCutStart': False,
        'renderBranch': 'handheld_source_composition',
        'editorialReason': 'The operated source camera already follows the action; synthetic reframing was disabled.',
    })
    return [locked]


def stabilize_continuous_conversation_layout(segments, editorial_plan=None):
    """Keep a two-person layout stable inside a source shot, never across cuts.

    A conversation can contain wide two-person shots, solo close-ups, and
    unrelated B-roll.  Split geometry belongs to the shot where both people
    were actually visible.  Carrying one pair of boxes across a camera edit
    duplicates a solo close-up or turns ordinary B-roll into two copies.
    """
    if len(segments) < 2:
        return segments
    if any(segment.get('mode') in ('grid', 'source_vertical') for segment in segments):
        return segments

    def starts_new_source_shot(segment):
        return any(bool(segment.get(key)) for key in (
            'sceneCutStart',
            'moderateCutStart',
            'hardCutStart',
            'inferredCutStart',
        ))

    shot_runs = []
    for index, segment in enumerate(segments):
        if index > 0 and starts_new_source_shot(segment):
            shot_runs.append([])
        if not shot_runs:
            shot_runs.append([])
        shot_runs[-1].append(segment)

    # Apply the continuity repair independently to each actual source shot.
    # The recursive call is safe because a single shot has no internal cut
    # boundary.  Preserve the incoming cut marker on its first result so later
    # QA/debug passes can still explain the edit.
    if len(shot_runs) > 1:
        stabilized_shots = []
        for shot in shot_runs:
            shot_result = stabilize_continuous_conversation_layout(
                shot,
                editorial_plan,
            )
            if shot_result:
                first = dict(shot_result[0])
                for key in (
                    'sceneCutStart',
                    'moderateCutStart',
                    'hardCutStart',
                    'inferredCutStart',
                ):
                    if shot[0].get(key):
                        first[key] = shot[0].get(key)
                shot_result = [first, *shot_result[1:]]
            stabilized_shots.extend(shot_result)
        return stabilized_shots

    stacked_segments = [
        segment for segment in segments
        if (
            segment.get('mode') == 'stacked'
            and segment.get('topBox')
            and segment.get('bottomBox')
        )
    ]
    if not stacked_segments or len(stacked_segments) == len(segments):
        return segments

    clip_start = float(segments[0].get('start', 0.0))
    clip_end = float(segments[-1].get('end', clip_start))
    clip_duration = max(0.001, clip_end - clip_start)
    stacked_duration = sum(
        max(0.0, float(segment.get('end', 0.0)) - float(segment.get('start', 0.0)))
        for segment in stacked_segments
    )
    stacked_ratio = stacked_duration / clip_duration
    recommended_layout = str(
        (editorial_plan or {}).get('recommended_layout', '')
    ).strip().upper()
    conversation_evidence = bool(
        recommended_layout == 'TWO_PERSON_CONVERSATION'
        or any(
            str(segment.get('editorialLayout', '')).upper() == 'TWO_PERSON_CONVERSATION'
            or str(segment.get('visualIntent', '')).lower() == 'conversation_led'
            for segment in segments
        )
    )
    stacked_runs = []
    for segment in stacked_segments:
        if (
            stacked_runs
            and float(segment.get('start', 0.0))
            - float(stacked_runs[-1][-1].get('end', 0.0)) <= 0.35
        ):
            stacked_runs[-1].append(segment)
        else:
            stacked_runs.append([segment])
    longest_stacked_run = max(
        (
            float(run[-1].get('end', 0.0))
            - float(run[0].get('start', 0.0))
            for run in stacked_runs
        ),
        default=0.0,
    )
    recurring_pair = len(stacked_runs) >= 2 or longest_stacked_run >= 4.5
    # Side profiles and motion blur make handheld face detection intermittent.
    # Once a recurring/continuous pair is established, later face misses are
    # not editorial permission to flash between split-screen and close-ups.
    if (
        not conversation_evidence
        or stacked_ratio < 0.10
        or stacked_duration < 4.0
        or not recurring_pair
    ):
        return segments

    # Use one proven geometry throughout the scene. Selecting a new pair box
    # after every detector dropout still creates visible pane jumps.
    template = max(
        stacked_segments,
        key=lambda candidate: (
            float(candidate.get('end', 0.0))
            - float(candidate.get('start', 0.0))
        ),
    )

    stabilized = []
    for raw_segment in segments:
        segment = dict(raw_segment)
        segment.update({
            'mode': 'stacked',
            'wideKind': None,
            'topTrackId': template.get('topTrackId'),
            'bottomTrackId': template.get('bottomTrackId'),
            'topBox': template.get('topBox'),
            'bottomBox': template.get('bottomBox'),
            'renderBranch': 'stable_conversation_split',
            'editorialSceneType': 'TWO_PERSON',
            'editorialLayout': 'TWO_PERSON_CONVERSATION',
            'visualIntent': 'conversation_led',
            'editorialReason': (
                'Continuous two-person conversation keeps one split-screen '
                'layout instead of pulsing through full-frame and close-up views.'
            ),
        })
        stabilized.append(segment)

    # Merge adjacent sections that now use the exact same split geometry. Keep
    # real source-cut geometry changes, but remove renderer-only boundaries.
    merged = []
    for segment in stabilized:
        previous = merged[-1] if merged else None
        same_geometry = bool(
            previous
            and previous.get('mode') == segment.get('mode') == 'stacked'
            and previous.get('topBox') == segment.get('topBox')
            and previous.get('bottomBox') == segment.get('bottomBox')
        )
        if same_geometry:
            previous['end'] = segment.get('end')
            previous['points'] = (
                list(previous.get('points') or [])
                + list(segment.get('points') or [])
            )
            continue
        merged.append(segment)
    return merged


def build_reframe_timeline(points, frames, source_w: float, source_h: float, duration: float, editorial_plan=None):
    """Convert 4 Hz observations into a hysteretic, timed layout state machine."""
    if not points or not frames:
        return []

    points, frames = apply_shot_entry_lookahead(points, frames, source_w, source_h)
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
    visual_pair_streak = 0
    last_visual_pair_ids = None
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
    fixed_last_confident_face = None
    conversation_last_track = None
    silence_started_at = None
    previous_silence_elapsed = 0.0
    fixed_layout_suppressed = False
    layout_exit_pending = False
    awaiting_new_shot_face = False
    last_single_face = None
    last_single_face_track = None
    single_face_gap_samples = 0
    requested_layout = str((editorial_plan or {}).get('recommended_layout', '')).strip().upper()
    requested_scene_type = str((editorial_plan or {}).get('scene_type', '')).strip().upper()
    single_speaker_requested = bool(
        requested_layout == 'SINGLE_SPEAKER_CROP'
        or requested_scene_type == 'SINGLE_SPEAKER'
    )

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
        scene_change_strength = float(point.get('scene_change', 1.0 if scene_cut else 0.0))
        # The layout state machine already treats a moderate discontinuity as a
        # shot change. Carry the same fact into segment boundaries; otherwise
        # one stacked segment can span two camera angles and render its median
        # pane boxes over the wrong shot.
        shot_change = bool(scene_cut or scene_change_strength >= 0.38)
        moderate_shot_change = bool(not scene_cut and scene_change_strength >= 0.38)
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
        if single_speaker_requested:
            # Visual detection may find a speaker plus an incidental listener
            # in a press panel. The transcript-backed editorial plan is the
            # authority on whether both people belong in the story.
            fixed_two_panel = None
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
        if (
            audio_activity >= SILENCE_AUDIO_THRESHOLD
            and complete_faces
            and (
                selected is None
                or subject_kind == 'context'
                or selection_reason in ('safe_full_frame', 'no_reliable_visual_subject', 'only_partial_faces_visible')
            )
        ):
            # Speech with no useful cutaway/context should never publish an
            # empty-stage or divider-centered frame. Hold one complete visible
            # person—even an attentive listener—until a trustworthy active
            # speaker target appears.
            replacement = max(
                complete_faces,
                key=lambda face: (
                    float(face.get('active_speaker_confidence', 0.0)),
                    float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
                    -abs(float(face.get('cx', 0.0)) - source_w / 2.0),
                ),
            )
            active_id = int(replacement.get('track_id')) if replacement.get('track_id') is not None else active_id
            selected = replacement
            subject_kind = 'face'
            subject_stable_id = f'face:{active_id}' if active_id is not None else 'face:visible-person'
            subject_confidence = max(0.32, float(replacement.get('active_speaker_confidence', 0.0)))
            selection_reason = 'visible_person_during_unframed_speech'
            subject_predicted = False
        face_by_id = complete_face_by_id
        speaker_score_margin = float(point.get('speaker_score_margin', frame.get('speaker_score_margin', 0.0)))
        pair = strongest_face_pair(complete_faces, source_w)
        pair_ids = None if pair is None else tuple(int(face.get('track_id')) for face in pair)

        # A conversation composition is a visual decision, not an editorial
        # stacked-layout decision. Ignore predicted and tiny incidental faces,
        # then keep the two dominant faces only when they occupy distinct
        # horizontal regions of the source frame. This handles pre-composed
        # podcast panels without letting logos/audience faces force the mode.
        visible_faces = distinct_face_detections([
            face for face in complete_faces
            if not bool(face.get('predicted')) and face.get('track_id') is not None
        ])
        layout_face_height_ratio = (
            float(fixed_two_panel.get('panel_face_height_ratio', FIXED_PANEL_FACE_HEIGHT_RATIO))
            if fixed_two_panel
            else 0.085
        )
        layout_faces = sorted(
            (
                face for face in visible_faces
                if float(face.get('h', 0.0)) >= source_h * layout_face_height_ratio
            ),
            key=lambda face: (
                1 if active_id is not None and int(face.get('track_id')) == int(active_id) else 0,
                float(face.get('active_speaker_confidence', 0.0)),
                float(face.get('w', 0.0)) * float(face.get('h', 0.0)),
            ),
            reverse=True,
        )[:4]
        dominant_faces = sorted(
            # Wide talk-show and interview shots often frame one participant
            # slightly farther from camera. A 15% face-height floor discarded
            # Fallon (roughly 12-14%) in the real MrBeast source even though
            # both faces were stable and cleanly separated. The earlier 8.5%
            # visibility gate plus the exact-two-person check below still
            # excludes tiny audience/logo detections.
            (
                face for face in layout_faces
                if float(face.get('h', 0.0)) >= source_h * (
                    layout_face_height_ratio if fixed_two_panel else 0.10
                )
            ),
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
            portrait_crop_width = source_h * 9.0 / 16.0
            pair_left = min(float(face.get('x', 0.0)) for face in dominant_faces)
            pair_right = max(
                float(face.get('x', 0.0)) + float(face.get('w', 0.0))
                for face in dominant_faces
            )
            face_margin = max(
                float(face.get('w', 0.0)) for face in dominant_faces
            ) * 0.16
            pair_fits_one_portrait = (
                pair_right - pair_left + face_margin * 2.0
                <= portrait_crop_width * 0.96
            )
            if (
                horizontal_separation >= source_w * 0.24
                and not pair_fits_one_portrait
            ):
                visual_pair = tuple(dominant_faces)
        visual_pair_ids = (
            tuple(int(face.get('track_id')) for face in visual_pair)
            if visual_pair is not None
            else None
        )
        if visual_pair is not None:
            fixed_layout_suppressed = False
        elif fixed_layout_suppressed:
            fixed_two_panel = None
        if shot_change:
            visual_pair_streak = 1 if visual_pair_ids is not None else 0
            last_visual_pair_ids = visual_pair_ids
        elif visual_pair_ids is not None and visual_pair_ids == last_visual_pair_ids:
            visual_pair_streak += 1
        elif visual_pair_ids is not None:
            visual_pair_streak = 1
            last_visual_pair_ids = visual_pair_ids
        else:
            visual_pair_streak = 0
            last_visual_pair_ids = None

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

        if shot_change:
            wide_pair_hold_ids = None
            wide_pair_hold_faces = None
            wide_pair_miss_streak = 0
        if visual_pair is not None:
            wide_pair_hold_ids = tuple(int(face.get('track_id')) for face in visual_pair)
            wide_pair_hold_faces = visual_pair
            wide_pair_miss_streak = 0
        elif wide_pair_hold_ids is not None:
            wide_pair_miss_streak += 1
            if wide_pair_miss_streak > 2 and not fixed_two_panel:
                wide_pair_hold_ids = None
                wide_pair_hold_faces = None
                wide_pair_miss_streak = 0

        # A two-person classification describes a shot, not the whole clip.
        # Talk-show edits commonly cut from a wide host/guest composition to a
        # full-frame close-up. If that cut falls below the hard scene detector's
        # threshold, retaining the previous panel boxes duplicates the close-up
        # person into both panes. A newly dominant solo face or a moderate
        # visual discontinuity with no confirmed pair invalidates the old
        # two-panel geometry immediately.
        solo_closeup = bool(
            visual_pair is None
            and len(layout_faces) == 1
            and float(layout_faces[0].get('h', 0.0)) >= source_h * 0.20
        )
        stack_to_solo_handoff = bool(current_mode == 'stacked' and solo_closeup)
        soft_cut_without_pair = bool(
            visual_pair is None
            and scene_change_strength >= 0.38
        )
        # Panel coordinates belong to one camera shot only. Carrying them over
        # a cut can put the same close-up into both panes. Invalidate them on
        # the first moderate discontinuity; if the new face detector has not
        # locked yet, the new shot is shown as safe full-frame context.
        if fixed_two_panel and soft_cut_without_pair:
            awaiting_new_shot_face = not bool(complete_faces)
        new_shot_face_handoff = bool(awaiting_new_shot_face and complete_faces)
        if new_shot_face_handoff:
            awaiting_new_shot_face = False
        invalidated_fixed_layout = bool(
            fixed_two_panel
            and (
                solo_closeup
                or soft_cut_without_pair
                or (layout_exit_pending and bool(complete_faces))
            )
        ) or new_shot_face_handoff
        if invalidated_fixed_layout:
            fixed_layout_suppressed = True
            layout_exit_pending = False
            fixed_two_panel = None
            wide_pair_hold_ids = None
            wide_pair_hold_faces = None
            wide_pair_miss_streak = 0
            current_pair = None
            if not complete_faces:
                active_id = None
                selected = None
                subject_kind = 'context'
                subject_stable_id = 'context:new-shot'
                subject_confidence = 0.0
                selection_reason = 'new_shot_awaiting_face'
                subject_predicted = False
        if awaiting_new_shot_face and not complete_faces:
            active_id = None
            selected = None
            subject_kind = 'context'
            subject_stable_id = 'context:new-shot'
            subject_confidence = 0.0
            selection_reason = 'new_shot_awaiting_face'
            subject_predicted = False

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
        # Back-and-forth speech is enough reason to preserve both participants.
        # Requiring visible reaction-mouth motion made the stacked renderer
        # effectively unreachable for normal interviews where the listener is
        # attentive but still.
        loses_context_in_single = rapid_alternation and participation_balance >= 0.45

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
        editorial_stack_eligible = STACK_LAYOUT_ENABLED and (
            two_stable_speakers
            and both_actively_participating
            and both_meaningful
            and rapid_alternation
            and loses_context_in_single
            and stacked_score >= single_score + STACK_SCORE_MARGIN
        )
        # A wide shot containing exactly two stable, meaningfully sized faces
        # cannot preserve both people in one 9:16 portrait crop. Treat that as
        # a composition requirement independently of diarization or rapid turn
        # taking. Each source region is cropped once into a locked half-height
        # pane, matching the top/bottom interview layout used by leading clip
        # tools without continuously chasing either face.
        composition_stack_eligible = bool(
            STACK_LAYOUT_ENABLED
            and not single_speaker_requested
            and visual_pair is not None
            # The visual_pair gate already requires exactly two meaningful,
            # separated, non-predicted faces. Enter immediately so the opening
            # poster and first playback frame use the same top/bottom layout;
            # normal layout hysteresis still controls the exit if the shot cuts.
            and visual_pair_streak >= 1
        )
        stack_eligible = editorial_stack_eligible or composition_stack_eligible
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

        if shot_change or index == 0:
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
            and (
                int(fixed_last_confident_track) in face_by_id
                or fixed_last_confident_face is not None
            )
        )

        if portrait_source:
            desired_mode = 'source_vertical'
            fixed_render_branch = 'source_vertical'
        elif fixed_two_panel and (visual_pair is not None or wide_pair_hold_faces is not None):
            # Fixed left/right interview shots are the strongest signal for the
            # Opus-style composition: crop each participant independently and
            # stack the locked panes. Do this during speech too; the previous
            # active-speaker branch discarded the second participant and made
            # this layout effectively invisible on talk-show footage.
            desired_mode = 'stacked'
            fixed_render_branch = 'fixed_two_panel_stacked'
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
        elif (
            silence_state in ('widen', 'lock')
            and subject_kind == 'face'
            and selected is not None
        ):
            # Silence is not a visual reason to abandon a clean close-up.
            # The old branch widened every single-person shot after a long
            # pause, even when the detector continuously tracked a complete
            # face. When speech resumed, layout confirmation then produced a
            # brief safe-wide flash between two valid portrait crops. Keep the
            # verified person planted; only widen when there is genuinely no
            # trustworthy subject to frame.
            desired_mode = 'single'
            fixed_render_branch = f'silence_{silence_state}_single_subject'
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
            fixed_last_confident_face = face_by_id.get(int(active_id))
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
        elif fixed_two_panel:
            desired_mode = 'wide_context'
            fixed_render_branch = 'safe_full_frame'
        elif composition_stack_eligible:
            desired_mode = 'stacked'
            fixed_render_branch = 'two_person_stacked'
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
        else:
            desired_mode = 'single'
            fixed_render_branch = 'single_subject'

        # Returning from a deliberate group composition to a trustworthy
        # speaker is an editorial cut, not a camera pan across the room.
        if (
            desired_mode == 'single'
            and (speech_resumed_after_long_pause or conversation_speaker_changed)
            and active_speaker_mapped
        ):
            fixed_hard_cut = True

        # A complete, verified one-person/two-person composition is safe to
        # hard-cut immediately. Generic hysteresis used to add up to several
        # 125 ms samples after the detector had already established the new
        # layout, making otherwise atomic edits feel late.
        verified_atomic_layout_handoff = bool(
            (
                current_mode == 'single'
                and desired_mode == 'stacked'
                and visual_pair is not None
            )
            or (
                current_mode == 'stacked'
                and desired_mode == 'single'
                and visual_pair is None
                and len(layout_faces) == 1
                and not bool(layout_faces[0].get('predicted'))
            )
        )

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
            current_pair = (pair_ids or wide_pair_hold_ids) if desired_mode == 'stacked' else None
            pending_mode = None
            pending_count = 0
            held_samples = 0
        elif (
            shot_change
            or invalidated_fixed_layout
            or soft_cut_without_pair
            or stack_to_solo_handoff
            or verified_atomic_layout_handoff
        ):
            # A moderate shot change is enough to leave a stale stacked
            # composition immediately. Waiting for generic layout hysteresis
            # keeps the old two-person geometry on the first solo-shot samples.
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
                layout_faces[:2], key=lambda face: float(face.get('cx', 0.0))
            )
        ) if len(layout_faces) == 2 else None
        primary_face = (
            face_by_id.get(int(active_id))
            if subject_kind == 'face' and active_id is not None
            else None
        )
        if shot_change:
            last_single_face = None
            last_single_face_track = None
            single_face_gap_samples = 0
        if current_mode == 'single' and primary_face is not None:
            last_single_face = primary_face
            last_single_face_track = active_id
            single_face_gap_samples = 0
        elif (
            current_mode == 'single'
            and primary_face is None
            and last_single_face is not None
            and single_face_gap_samples < 4
            and not shot_change
        ):
            # A face detector can miss several samples when the speaker turns
            # or gestures. Keep the last verified face crop for at most one
            # second; never let a hand/body/motion target take over mid-shot.
            single_face_gap_samples += 1
            primary_face = last_single_face
            active_id = last_single_face_track
            selected = last_single_face
            subject_kind = 'face'
            subject_stable_id = (
                f'face:{active_id}' if active_id is not None else 'face:shot-hold'
            )
            subject_confidence = max(0.24, subject_confidence)
            selection_reason = 'timeline_face_detection_gap_hold'
            subject_predicted = True
        if fixed_hold:
            active_id = int(fixed_last_confident_track)
            primary_face = face_by_id.get(active_id) or fixed_last_confident_face
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
            held_faces_by_id = {
                int(face.get('track_id')): face for face in (wide_pair_hold_faces or ())
                if face.get('track_id') is not None
            }
            active_pair = layout_pair_ids or (
                current_pair if current_pair else pair_ids
            )
            if active_pair and all(
                track_id in face_by_id or track_id in held_faces_by_id
                for track_id in active_pair
            ):
                top_face = face_by_id.get(active_pair[0]) or held_faces_by_id[active_pair[0]]
                bottom_face = face_by_id.get(active_pair[1]) or held_faces_by_id[active_pair[1]]
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
            previous_face = decisions[-1].get('primary_face')
            same_visual_face = bool(
                previous_face is not None
                and primary_face is not None
                and box_match_score(
                    (
                        float(previous_face.get('x', 0.0)), float(previous_face.get('y', 0.0)),
                        float(previous_face.get('w', 0.0)), float(previous_face.get('h', 0.0)),
                    ),
                    (
                        float(primary_face.get('x', 0.0)), float(primary_face.get('y', 0.0)),
                        float(primary_face.get('w', 0.0)), float(primary_face.get('h', 0.0)),
                    ),
                    source_w,
                    source_h,
                ) >= 0.42
            )
            # Track IDs commonly fragment while the same person gestures or
            # turns their head. That is detector noise, not an editorial cut.
            fixed_hard_cut = not same_visual_face

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
            # Only a confirmed source edit may force an instantaneous renderer
            # boundary. Moderate histogram/motion changes are useful evidence
            # for reacquiring subjects, but treating each one as a cut made
            # energetic streamer footage alternate layouts every 1–3 frames.
            'scene_cut': bool(scene_cut or point.get('inferred_shot_boundary')),
            'moderate_shot_change': moderate_shot_change,
            'inferred_shot_boundary': bool(point.get('inferred_shot_boundary')),
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
        # Visual QA must judge the person and crop the timeline will actually
        # render. The source observation can briefly miss a face even though a
        # fixed-panel hold or complete-person replacement safely preserves it.
        # Keeping the original observation here caused good interview reels to
        # be rejected after the renderer had already solved the composition.
        point['subject_kind'] = subject_kind
        point['face_box'] = None if primary_face is None else dict_box((
            float(primary_face.get('x', 0.0)),
            float(primary_face.get('y', 0.0)),
            float(primary_face.get('w', 0.0)),
            float(primary_face.get('h', 0.0)),
        ))
        point['face_source_complete'] = bool(primary_face is not None)
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
        generic_single = bool(
            decision['mode'] == 'single'
            and not decision.get('source_layout')
        )
        identity_key = (
            decision['mode'],
            # Confidence can alternate between "single_subject" and
            # "single_subject_uncertain" while the same seated person keeps
            # talking. That is not a new camera composition. Fixed-panel
            # branches remain meaningful because they identify which physical
            # panel the renderer must use.
            None if generic_single else decision.get('render_branch'),
            decision.get('primary_panel') if decision['mode'] == 'single' else None,
            (
                decision.get('primary_track_id')
                if decision['mode'] == 'single' and decision.get('source_layout')
                else None
            ),
            # A detector may assign a new track id to the same face mid-shot.
            # Meaningful face changes are handled by the spatially-validated
            # hard-cut logic above; keying segments by raw detector identity
            # made every track fragment create a new crop anchor and visible
            # camera jump.
            None,
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
            and bool(decision.get('hard_cut'))
        )
        same_primary_continuity = bool(
            segments
            and generic_single
            and segments[-1].get('mode') == 'single'
            and decision.get('primary_track_id') is not None
            and segments[-1].get('primaryTrackId') is not None
            and int(decision['primary_track_id']) == int(segments[-1]['primaryTrackId'])
            and not decision.get('scene_cut')
        )
        # Audio confidence and mouth-motion noise can set a hard-cut flag even
        # though visual tracking still identifies the exact same person. Keep
        # that shot planted. A real visual scene cut remains authoritative.
        effective_hard_cut = bool(
            decision.get('hard_cut')
            and not same_primary_continuity
        )
        force_boundary = bool(decision.get('scene_cut') or effective_hard_cut or identity_switch)
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
                'hardCutStart': bool(effective_hard_cut or identity_switch),
                'silenceState': decision.get('silence_state'),
                'sceneCutStart': bool(decision.get('scene_cut')),
                'moderateCutStart': bool(decision.get('moderate_shot_change')),
                'inferredCutStart': bool(decision.get('inferred_shot_boundary')),
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
            'audioActivity': decision['audio_activity'],
            'subjectKind': decision['subject_kind'],
            'subjectConfidence': decision['subject_confidence'],
            'selectionReason': decision['selection_reason'],
            'predicted': decision['subject_predicted'],
            'subjectStableId': decision['subject_stable_id'],
            'face_box': decision['primary_face'],
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
        if (
            segment_duration >= 0.9
            or is_confirmed_fixed_turn
            or segment.get('hardCutStart')
            or (
                segment.get('sceneCutStart')
                and not segment.get('inferredCutStart')
            )
        ):
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
        if (
            not segment.get('sceneCutStart')
            or segment.get('moderateCutStart')
            or segment.get('hardCutStart')
            or not segment.get('points')
        ):
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
        # Once a complete face has been framed, treat the shot like a locked
        # virtual tripod. Detector-box changes, head movement, and posture
        # shifts must not make the camera drift. A confirmed identity or scene
        # change already creates a separate hard-cut segment above.
        if segment.get('subjectKind') == 'face':
            # Lock to the robust center of the verified shot, not its first
            # detector sample. The first sample after an edit is frequently
            # predicted, motion-blurred, or mid head-turn; anchoring to it can
            # leave the real speaker pinned to an edge for the whole shot.
            verified_points = [
                point for point in segment['points']
                if not bool(point.get('predicted'))
                and point.get('subjectKind') == 'face'
            ] or list(segment['points'])
            anchor_x = float(statistics.median(float(point['cropX']) for point in verified_points))
            anchor_y = float(statistics.median(float(point['cropY']) for point in verified_points))
            anchor_w = float(statistics.median(float(point['cropW']) for point in verified_points))
            anchor_h = float(statistics.median(float(point['cropH']) for point in verified_points))
            anchor_zoom = float(statistics.median(float(point.get('zoom', 1.0)) for point in verified_points))
            for point in segment['points']:
                point['cropX'] = round(anchor_x, 3)
                point['cropY'] = round(anchor_y, 3)
                point['cropW'] = round(anchor_w, 3)
                point['cropH'] = round(anchor_h, 3)
                point['cropCenterX'] = round(anchor_x + anchor_w / 2.0, 3)
                point['cropCenterY'] = round(anchor_y + anchor_h / 2.0, 3)
                point['zoom'] = round(anchor_zoom, 4)
            continue
        smoothed_x = float(segment['points'][0]['cropX'])
        smoothed_y = float(segment['points'][0]['cropY'])
        # Keep one lens/zoom for the entire uninterrupted shot. Subject and
        # motion boxes naturally breathe from sample to sample; using their
        # raw dimensions made the portrait crop pulse even when its center was
        # properly smoothed, which reads as camera shake.
        locked_crop_w = float(segment['points'][0]['cropW'])
        locked_crop_h = float(segment['points'][0]['cropH'])
        locked_zoom = float(segment['points'][0].get('zoom', 1.0))
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
            crop_w = locked_crop_w
            crop_h = locked_crop_h
            raw_x = float(point['cropX'])
            raw_y = float(point['cropY'])
            point['cropW'] = round(locked_crop_w, 3)
            point['cropH'] = round(locked_crop_h, 3)
            point['zoom'] = round(locked_zoom, 4)
            # Keep the virtual tripod planted through ordinary head sway,
            # posture changes, and detector noise. A subject should be able to
            # move comfortably inside the portrait before the camera follows.
            # This intentionally favors a planted composition over continuous
            # micro-corrections around a face.
            dead_zone_x = crop_w * 0.24
            dead_zone_y = crop_h * 0.18

            if abs(raw_x - target_x) <= dead_zone_x:
                pending_x_samples = 0
            else:
                same_direction = (raw_x - target_x) * (pending_x - target_x) > 0
                pending_x_samples = pending_x_samples + 1 if same_direction else 1
                pending_x = raw_x
                if pending_x_samples >= 12 or abs(raw_x - target_x) >= crop_w * 0.58:
                    target_x = raw_x
                    pending_x_samples = 0

            if abs(raw_y - target_y) <= dead_zone_y:
                pending_y_samples = 0
            else:
                same_direction = (raw_y - target_y) * (pending_y - target_y) > 0
                pending_y_samples = pending_y_samples + 1 if same_direction else 1
                pending_y = raw_y
                if pending_y_samples >= 12 or abs(raw_y - target_y) >= crop_h * 0.50:
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

            desired_velocity_x = clamp(delta_x / delta_t, -crop_w * 0.035, crop_w * 0.035)
            desired_velocity_y = clamp(delta_y / delta_t, -crop_h * 0.018, crop_h * 0.018)
            acceleration_x = crop_w * 0.055 * delta_t
            acceleration_y = crop_h * 0.032 * delta_t
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
    # Twelve observations per second keeps solo/stacked hard cuts within one
    # 83 ms sample. Offline lookahead then replaces every partial transition
    # observation with the next complete verified composition.
    try:
        requested_analysis_fps = float(sys.argv[4]) if len(sys.argv) > 4 else float(
            os.environ.get('SMART_REFRAME_ANALYSIS_FPS', '12')
        )
    except (TypeError, ValueError):
        requested_analysis_fps = 12.0
    analysis_fps = clamp(requested_analysis_fps, 1.0, 12.0)
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
    last_confirmed_scene_cut_t = -1e9

    # Decode the analysis window sequentially. Seeking the source independently
    # for every 83 ms observation forces the decoder back through nearby
    # keyframes hundreds of times and made short reels several times slower
    # than real time. We still evaluate the exact same 12 observations per
    # second; only the way those frames are retrieved changes.
    first_target_frame = max(0, int(round(sample_times[0] * fps)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, first_target_frame)
    next_decode_frame = max(0, int(round(cap.get(cv2.CAP_PROP_POS_FRAMES))))
    last_decoded_frame = None
    supplemental_scan_interval = max(1, int(round(analysis_fps)))

    for sample_index, sample_t in enumerate(sample_times):
        target_frame = max(first_target_frame, int(round(sample_t * fps)))
        grabbed_target = False
        while next_decode_frame <= target_frame:
            ok = cap.grab()
            if not ok:
                last_decoded_frame = None
                break
            next_decode_frame += 1
            grabbed_target = True
        if grabbed_target:
            ok, decoded_frame = cap.retrieve()
            last_decoded_frame = decoded_frame if ok else None
        if last_decoded_frame is None:
            continue
        frame = last_decoded_frame

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
        if len(faces) < 2 and sample_index % supplemental_scan_interval == 0:
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
        raw_scene_cut = scene_change >= 0.72
        # Shaky handheld footage can exceed the histogram threshold for
        # several adjacent samples during one whip-pan. Debounce that burst
        # into one edit boundary instead of generating a flash every frame.
        scene_cut = bool(
            raw_scene_cut
            and sample_t - last_confirmed_scene_cut_t >= 0.75
        )
        if scene_cut:
            last_confirmed_scene_cut_t = sample_t
        # Hold a confirmed face long enough to bridge ordinary occlusion from
        # laughter, hands, microphones, and head turns. Scene cuts bypass this
        # immediately, so the longer grace period cannot carry a face crop into
        # a different camera shot.
        max_semantic_hold_samples = max(4, int(round(analysis_fps * 1.5)))
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
            face_area_ratio=(
                1.0
                if selected_box is None
                else (float(selected_box[2]) * float(selected_box[3]))
                / max(1.0, float(source_w) * float(source_h))
            ),
            body_area_ratio=(
                0.0
                if body_box is None
                else (float(body_box[2]) * float(body_box[3]))
                / max(1.0, float(source_w) * float(source_h))
            ),
            motion_area_ratio=(
                0.0
                if motion_box is None
                else (float(motion_box[2]) * float(motion_box[3]))
                / max(1.0, float(source_w) * float(source_h))
            ),
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
            # Size is not permission to preserve an entire stage. A reliable
            # face remains a single-subject portrait target even when the
            # source camera is wide; portrait_crop_for_subject supplies the
            # bounded close composition.
            desired_framing = 'wide_context' if semantic_kind in {'context', 'screen'} else 'single'

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
            'face_box': dict_box(semantic_subject.get('face_box')),
            'face_source_complete': bool(
                semantic_subject.get('face_box')
                and face_is_complete_in_source(
                    semantic_subject.get('face_box'),
                    source_w,
                    source_h,
                )
            ),
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
            'scene_cut': scene_cut,
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
    reframe_timeline = build_reframe_timeline(points, detected_faces, source_w, source_h, duration, editorial_plan)
    reframe_timeline, editorial_summary = plan_editorial_timeline(reframe_timeline, editorial_plan)
    reframe_timeline, layout_qa_summary = validate_layout_timeline(
        reframe_timeline, detected_faces, source_w, source_h
    )
    # Editorial and QA passes can legitimately introduce split-screen repairs,
    # but they must not recreate a repeated wide/close/split pulse. Apply the
    # composition lock once more to the final renderer-facing timeline.
    reframe_timeline = stabilize_continuous_conversation_layout(
        reframe_timeline, editorial_plan
    )
    reframe_timeline = lock_unstable_panel_composition(reframe_timeline)
    reframe_timeline = lock_handheld_source_composition(reframe_timeline)
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
    context_usable, context_reject_reason = visual_usability(points, reframe_timeline)
    visual_clip_usable = not reject_for_partial_faces and context_usable
    visual_reject_reason = (
        'sustained_partial_faces_only'
        if reject_for_partial_faces
        else context_reject_reason
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
            'visual_clip_usable': visual_clip_usable,
            'visual_reject_reason': visual_reject_reason,
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
