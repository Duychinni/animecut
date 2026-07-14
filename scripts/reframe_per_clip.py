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
LAYOUT_MIN_HOLD_SAMPLES = 4
LAYOUT_CONFIRM_SAMPLES = 2
STACK_PAIR_CONFIRM_SAMPLES = 4
STACK_ENTER_CONFIRM_SAMPLES = 4
STACK_PARTICIPATION_WINDOW_SEC = 6.0
STACK_TURN_WINDOW_SEC = 4.5
STACK_REACTION_WINDOW_SEC = 3.0
STACK_MIN_RAPID_SWITCHES = 2
STACK_SCORE_MARGIN = 0.15
STACK_MAX_DURATION_RATIO = 0.18
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

    for index, (point, frame) in enumerate(zip(points, frames)):
        faces = frame.get('faces', [])
        active_id = frame.get('active_track_id')
        speaker_confidence = float(point.get('speaker_confidence', 0.0))
        audio_activity = float(point.get('audio_activity', 0.0))
        scene_cut = bool(frame.get('scene_cut'))
        selected = frame.get('selected_box')
        pair = strongest_face_pair(faces, source_w)
        pair_ids = None if pair is None else tuple(int(face.get('track_id')) for face in pair)

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
        stack_eligible = (
            two_stable_speakers
            and both_actively_participating
            and both_meaningful
            and reaction_matters
            and rapid_alternation
            and loses_context_in_single
            and stacked_score >= single_score + STACK_SCORE_MARGIN
        )

        face_height_ratio = (
            float(selected.get('h', 0)) / max(source_h, 1.0)
            if selected is not None
            else 0.0
        )
        wide_context_trigger = (
            len(faces) >= 3
            or selected is None
            or (point.get('fallback_used') and speaker_confidence < 0.08)
            or face_height_ratio <= WIDE_FACE_HEIGHT_RATIO * 0.72
        )
        strong_talking_head = (
            selected is not None
            and len(faces) <= 2
            and not point.get('fallback_used')
            and face_height_ratio > WIDE_FACE_HEIGHT_RATIO * 0.88
            and speaker_confidence >= 0.52
        )

        if scene_cut or index == 0:
            contextual_shot_latched = bool(wide_context_trigger and not portrait_source)
            talking_head_release_streak = 0
        elif contextual_shot_latched:
            talking_head_release_streak = talking_head_release_streak + 1 if strong_talking_head else 0
            if talking_head_release_streak >= 6:
                contextual_shot_latched = False
                talking_head_release_streak = 0

        if portrait_source:
            desired_mode = 'source_vertical'
        elif contextual_shot_latched:
            desired_mode = 'wide_context'
        elif wide_context_trigger:
            desired_mode = 'wide_context'
        elif stack_eligible:
            desired_mode = 'stacked'
        else:
            desired_mode = 'single'

        if scene_cut:
            current_mode = desired_mode
            current_pair = pair_ids if desired_mode == 'stacked' else None
            pending_mode = None
            pending_count = 0
            held_samples = 0
        elif desired_mode == current_mode:
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
            required_confirmation = STACK_ENTER_CONFIRM_SAMPLES if desired_mode == 'stacked' else LAYOUT_CONFIRM_SAMPLES
            if held_samples >= LAYOUT_MIN_HOLD_SAMPLES and pending_count >= required_confirmation:
                current_mode = desired_mode
                current_pair = pair_ids if desired_mode == 'stacked' else None
                pending_mode = None
                pending_count = 0
                held_samples = 0
            else:
                held_samples += 1

        face_by_id = {int(face.get('track_id')): face for face in faces if face.get('track_id') is not None}
        primary_face = face_by_id.get(int(active_id)) if active_id is not None else None
        if primary_face is None and selected is not None:
            primary_face = {
                **selected,
                'cx': float(selected.get('x', 0)) + float(selected.get('w', 0)) / 2.0,
                'cy': float(selected.get('y', 0)) + float(selected.get('h', 0)) / 2.0,
            }

        top_face = bottom_face = None
        if current_mode == 'stacked':
            active_pair = current_pair if current_pair and all(track_id in face_by_id for track_id in current_pair) else pair_ids
            if active_pair and all(track_id in face_by_id for track_id in active_pair):
                top_face = face_by_id[active_pair[0]]
                bottom_face = face_by_id[active_pair[1]]
                current_pair = active_pair
            else:
                # Hold the layout through a short detection gap; the segment
                # aggregator will use the last observed boxes for both tracks.
                active_pair = current_pair

        crop = portrait_crop_for_face(
            (
                float(primary_face.get('x', 0)), float(primary_face.get('y', 0)),
                float(primary_face.get('w', 1)), float(primary_face.get('h', 1)),
            ), source_w, source_h,
        ) if primary_face is not None else {
            'x': round(max(0.0, (source_w - source_h * 9.0 / 16.0) / 2.0), 3),
            'y': 0.0,
            'w': round(min(source_w, source_h * 9.0 / 16.0), 3),
            'h': round(source_h, 3),
            'cx': round(source_w / 2.0, 3),
            'cy': round(source_h / 2.0, 3),
            'zoom': 1.0,
        }

        decision = {
            'timestamp': round(now, 3),
            'mode': current_mode,
            'primary_track_id': active_id,
            'top_track_id': None if current_pair is None else current_pair[0],
            'bottom_track_id': None if current_pair is None else current_pair[1],
            'speaker_confidence': round(speaker_confidence, 4),
            'audio_activity': round(audio_activity, 4),
            'scene_cut': scene_cut,
            'single_score': round(single_score, 4),
            'stacked_score': round(stacked_score, 4),
            'stack_eligible': stack_eligible,
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
            'primary_face': primary_face,
            'top_face': top_face,
            'bottom_face': bottom_face,
        }
        decisions.append(decision)
        frame['layout_mode'] = current_mode
        frame['layout_top_track_id'] = decision['top_track_id']
        frame['layout_bottom_track_id'] = decision['bottom_track_id']
        frame['speaker_confidence'] = decision['speaker_confidence']
        point['framing'] = current_mode

    # Stacked composition is an editorial exception, never the default. Keep
    # only the strongest complete stacked runs that fit inside an 18% budget.
    # Dropping a run returns each sample to its active-speaker crop, so speaker
    # switches remain clean segment boundaries instead of a midpoint crop.
    stacked_runs = []
    run_start = None
    for decision_index, decision in enumerate(decisions + [{'mode': None}]):
        if decision.get('mode') == 'stacked' and run_start is None:
            run_start = decision_index
        elif decision.get('mode') != 'stacked' and run_start is not None:
            run_end = decision_index
            run_scores = [float(item.get('stacked_score', 0.0)) - float(item.get('single_score', 0.0)) for item in decisions[run_start:run_end]]
            stacked_runs.append({
                'start': run_start,
                'end': run_end,
                'samples': run_end - run_start,
                'score': statistics.mean(run_scores) if run_scores else 0.0,
            })
            run_start = None

    max_stacked_samples = int(math.floor(len(decisions) * STACK_MAX_DURATION_RATIO))
    retained_stacked_indexes = set()
    used_stacked_samples = 0
    for run in sorted(stacked_runs, key=lambda item: float(item['score']), reverse=True):
        run_samples = int(run['samples'])
        remaining_budget = max_stacked_samples - used_stacked_samples
        retained_samples = min(run_samples, remaining_budget, 16)  # at most four seconds per editorial beat
        if retained_samples < STACK_ENTER_CONFIRM_SAMPLES:
            continue
        run_start_index = int(run['start'])
        run_end_index = int(run['end'])
        margins = [
            float(item.get('stacked_score', 0.0)) - float(item.get('single_score', 0.0))
            for item in decisions[run_start_index:run_end_index]
        ]
        best_offset = max(
            range(0, run_samples - retained_samples + 1),
            key=lambda offset: sum(margins[offset:offset + retained_samples]),
        )
        retained_start = run_start_index + best_offset
        retained_stacked_indexes.update(range(retained_start, retained_start + retained_samples))
        used_stacked_samples += retained_samples

    for decision_index, decision in enumerate(decisions):
        if decision.get('mode') != 'stacked' or decision_index in retained_stacked_indexes:
            continue
        decision['mode'] = 'single'
        decision['top_track_id'] = None
        decision['bottom_track_id'] = None
        frames[decision_index]['layout_mode'] = 'single'
        frames[decision_index]['layout_top_track_id'] = None
        frames[decision_index]['layout_bottom_track_id'] = None
        points[decision_index]['framing'] = 'single'

    segments = []
    for index, decision in enumerate(decisions):
        identity_key = (
            decision['mode'],
            decision['primary_track_id'] if decision['mode'] == 'single' else None,
            decision['top_track_id'] if decision['mode'] == 'stacked' else None,
            decision['bottom_track_id'] if decision['mode'] == 'stacked' else None,
        )
        force_boundary = bool(decision.get('scene_cut'))
        if not segments or identity_key != segments[-1]['_key'] or force_boundary:
            segments.append({
                '_key': identity_key,
                'start': 0.0 if not segments else float(decision['timestamp']),
                'end': duration,
                'mode': decision['mode'],
                'primaryTrackId': decision['primary_track_id'],
                'topTrackId': decision['top_track_id'],
                'bottomTrackId': decision['bottom_track_id'],
                'sceneCutStart': force_boundary,
                'points': [],
                '_top_boxes': [],
                '_bottom_boxes': [],
                '_single_scores': [],
                '_stacked_scores': [],
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
        })
        if decision.get('top_face'):
            segment['_top_boxes'].append(decision['top_face'])
        if decision.get('bottom_face'):
            segment['_bottom_boxes'].append(decision['bottom_face'])
        segment['_single_scores'].append(float(decision.get('single_score', 0.0)))
        segment['_stacked_scores'].append(float(decision.get('stacked_score', 0.0)))

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
        if float(segment['end']) - float(segment['start']) >= 0.9:
            index += 1
            continue
        previous = clean_segments[index - 1] if index > 0 else None
        following = clean_segments[index + 1] if index + 1 < len(clean_segments) else None
        if segment['mode'] != 'stacked' and following is not None and following['mode'] == 'stacked' and previous is not None:
            previous['end'] = segment['end']
            previous['points'].extend(segment['points'])
            clean_segments.pop(index)
            index = max(0, index - 1)
        elif segment['mode'] != 'stacked' and previous is not None and previous['mode'] == 'stacked' and following is not None:
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

    # Final defensive budget check after short-segment coalescing. If an edge
    # transition still expanded stacked time past the budget, demote the least
    # valuable stacked beats back to their active-speaker crop.
    stacked_budget_seconds = duration * STACK_MAX_DURATION_RATIO
    stacked_duration = sum(
        float(segment['end']) - float(segment['start'])
        for segment in clean_segments
        if segment['mode'] == 'stacked'
    )
    if stacked_duration > stacked_budget_seconds:
        for segment in sorted(
            (item for item in clean_segments if item['mode'] == 'stacked'),
            key=lambda item: float(item.get('stackedScore', 0.0)) - float(item.get('singleScore', 0.0)),
        ):
            segment_duration = float(segment['end']) - float(segment['start'])
            segment['mode'] = 'single'
            segment['topTrackId'] = None
            segment['bottomTrackId'] = None
            segment['topBox'] = None
            segment['bottomBox'] = None
            stacked_duration -= segment_duration
            if stacked_duration <= stacked_budget_seconds:
                break

    # Smooth and velocity-limit the virtual camera inside each uninterrupted
    # single-speaker segment. Speaker/layout cuts remain hard boundaries.
    for segment in clean_segments:
        if segment['mode'] != 'single' or len(segment['points']) < 2:
            continue
        smoothed_x = float(segment['points'][0]['cropX'])
        smoothed_y = float(segment['points'][0]['cropY'])
        previous_t = float(segment['points'][0]['t'])
        for point in segment['points'][1:]:
            current_t = float(point['t'])
            delta_t = max(0.05, current_t - previous_t)
            max_delta_x = float(point['cropW']) * 0.42 * delta_t
            max_delta_y = float(point['cropH']) * 0.24 * delta_t
            target_x = smoothed_x * 0.62 + float(point['cropX']) * 0.38
            target_y = smoothed_y * 0.62 + float(point['cropY']) * 0.38
            smoothed_x += clamp(target_x - smoothed_x, -max_delta_x, max_delta_x)
            smoothed_y += clamp(target_y - smoothed_y, -max_delta_y, max_delta_y)
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
    # Four observations per second is frequent enough to associate speech with
    # mouth motion and still bounded for long clips.
    sample_count = max(2, int(math.ceil(duration / 0.25)) + 1)
    sample_times = [start_sec + (duration * i / max(1, sample_count - 1)) for i in range(sample_count)]
    audio_activity, audio_available = extract_audio_activity(input_path, start_sec, duration, sample_times)

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
    face_tracks = []
    next_face_track_id = 1
    previous_track_boxes = {}
    speaker_evidence_history = {}

    for sample_index, sample_t in enumerate(sample_times):
        cap.set(cv2.CAP_PROP_POS_MSEC, sample_t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            continue

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        result = detector.process(rgb)
        scene_change = scene_change_score(cv2, prev_gray, gray)

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
                selected_box = (float(x), float(y), float(w), float(h))
                fallback_used = True

        current_audio = audio_activity[sample_index] if sample_index < len(audio_activity) else 0.0
        mouth_scores = []
        for face, track_id, observed in zip(faces, face_track_ids, face_observed):
            previous_match = previous_track_boxes.get(track_id)
            mouth_scores.append(mouth_motion_score(cv2, prev_gray, gray, face, previous_match) if observed else 0.0)

        selected_mouth_score = 0.0
        selected_speaker_confidence = 0.0
        speaker_scores_by_track = {}

        if faces:
            scored_faces = []
            for face, mouth_score, track_id, observed in zip(faces, mouth_scores, face_track_ids, face_observed):
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

            if active_box is None or scene_change >= 0.72:
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
                if active_track_id in face_track_ids:
                    active_box = faces[face_track_ids.index(active_track_id)]
                else:
                    best_continuation_index = max(range(len(faces)), key=lambda idx: box_match_score(faces[idx], active_box, source_w, source_h))
                    if box_match_score(faces[best_continuation_index], active_box, source_w, source_h) >= 0.32:
                        active_box = faces[best_continuation_index]
                        active_track_id = face_track_ids[best_continuation_index]
                pending_box = None
                pending_count = 0

            selected_box = active_box
            selected_index = face_track_ids.index(active_track_id) if active_track_id in face_track_ids else max(range(len(faces)), key=lambda idx: box_match_score(faces[idx], selected_box, source_w, source_h))
            selected_mouth_score = mouth_scores[selected_index]
            selected_speaker_confidence = float(speaker_scores_by_track.get(active_track_id, candidate_score))
            if strong_speaker_evidence:
                confident_speaker_samples += 1

        motion_boxes = motion_regions(cv2, prev_gray, gray, source_w, source_h)
        if motion_boxes:
            motion_box = motion_boxes[0]

        detected_faces.append({
            'timestamp': round(sample_t - start_sec, 3),
            'multi_person_checked': multi_person_checked,
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
                }
                for face, track_id, observed, mouth_score in list(zip(faces, face_track_ids, face_observed, mouth_scores))[:4]
            ],
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
            'active_track_id': active_track_id,
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
            'scene_change': round(scene_change, 4),
            'active_track_id': active_track_id,
            'fallback_used': fallback_used,
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
        })

        prev_gray = gray
        previous_track_boxes = {track_id: face for face, track_id in zip(faces, face_track_ids)}

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
    # Produce timed layout decisions after tracking/speaker evidence is known.
    # Never collapse a multi-person reel into one whole-clip layout.
    reframe_timeline = build_reframe_timeline(points, detected_faces, source_w, source_h, duration)

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
            'analysis_rate_fps': sample_count / duration,
            'dual_frames': dual_frames,
            'dual_observation_opportunities': dual_observation_opportunities,
            'dual_frame_ratio': round(dual_frame_ratio, 4),
            'timeline_segments': len(reframe_timeline),
            'layout_modes': layout_modes,
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
