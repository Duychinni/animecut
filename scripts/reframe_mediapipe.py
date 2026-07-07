#!/usr/bin/env python3
import json
import math
import os
import sys
from pathlib import Path
from typing import Optional, Tuple

TARGET_FACE_TOP = 0.40
SAFE_EDGE_MARGIN_X = 0.10
DEBUG_FRAME_COUNT = 10


def fail(code: int, error: str):
    print(json.dumps({"ok": False, "error": error}))
    sys.exit(code)


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def iou(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1 = max(ax, bx)
    y1 = max(ay, by)
    x2 = min(ax + aw, bx + bw)
    y2 = min(ay + ah, by + bh)
    iw = max(0.0, x2 - x1)
    ih = max(0.0, y2 - y1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    ua = aw * ah + bw * bh - inter
    return inter / ua if ua > 0 else 0.0


def center(b: Tuple[float, float, float, float]) -> Tuple[float, float]:
    x, y, w, h = b
    return x + w / 2.0, y + h / 2.0


def face_score(face: Tuple[float, float, float, float], width: float, height: float) -> float:
    _, _, w, h = face
    cx, cy = center(face)
    area = w * h
    frame_area = max(width * height, 1.0)
    area_ratio = area / frame_area
    center_bias = 1.0 - min(1.0, abs((cx / max(width, 1.0)) - 0.5) * 1.4)
    upper_bias = 1.0 - min(1.0, abs((cy / max(height, 1.0)) - 0.40) * 1.2)
    return area_ratio * 5.5 + center_bias * 1.0 + upper_bias * 0.9


def body_score(box: Tuple[float, float, float, float], width: float, height: float) -> float:
    _, _, w, h = box
    cx, cy = center(box)
    area_ratio = (w * h) / max(width * height, 1.0)
    center_bias = 1.0 - min(1.0, abs((cx / max(width, 1.0)) - 0.5) * 1.2)
    upper_bias = 1.0 - min(1.0, abs((cy / max(height, 1.0)) - 0.50) * 1.1)
    return area_ratio * 3.8 + center_bias * 0.8 + upper_bias * 0.65


def track_score(candidate: Tuple[float, float, float, float], active_bbox: Optional[Tuple[float, float, float, float]], width: float, height: float) -> float:
    base = face_score(candidate, width, height)
    if active_bbox is None:
        return base
    overlap = iou(active_bbox, candidate)
    acx, acy = center(active_bbox)
    ccx, ccy = center(candidate)
    dist = math.hypot((ccx - acx) / max(width, 1.0), (ccy - acy) / max(height, 1.0))
    continuity = max(0.0, 1.0 - dist * 2.8)
    size_bonus = min(1.0, ((candidate[2] * candidate[3]) / max(width * height, 1.0)) * 10.0)
    return base + overlap * 2.6 + continuity * 1.8 + size_bonus * 0.6


def motion_regions(cv2, prev_gray, gray, width: float, height: float):
    diff = cv2.absdiff(prev_gray, gray)
    diff = cv2.GaussianBlur(diff, (7, 7), 0)
    _, thresh = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
    thresh = cv2.dilate(thresh, None, iterations=2)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = float(w * h)
        if area < max(1200.0, width * height * 0.0035):
            continue
        boxes.append((float(x), float(y), float(w), float(h)))
    boxes.sort(key=lambda b: b[2] * b[3], reverse=True)
    return boxes[:5]


def save_debug_frame(cv2, frame, out_path: Path, selected_box, crop_box, center_pt):
    img = frame.copy()
    if selected_box is not None:
        x, y, w, h = [int(round(v)) for v in selected_box]
        cv2.rectangle(img, (x, y), (x + w, y + h), (0, 255, 0), 3)
    if crop_box is not None:
        x, y, w, h = [int(round(v)) for v in crop_box]
        cv2.rectangle(img, (x, y), (x + w, y + h), (255, 0, 0), 3)
    if center_pt is not None:
        cx, cy = [int(round(v)) for v in center_pt]
        cv2.circle(img, (cx, cy), 8, (0, 255, 255), -1)
    cv2.line(img, (img.shape[1] // 2, 0), (img.shape[1] // 2, img.shape[0]), (0, 0, 255), 2)
    cv2.imwrite(str(out_path), img)


def main():
    if len(sys.argv) < 4:
        fail(2, "usage: reframe_mediapipe.py <input_path> <start_sec> <end_sec> [sample_fps]")

    input_path = sys.argv[1]
    start_sec = float(sys.argv[2])
    end_sec = float(sys.argv[3])

    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
    except Exception as exc:
        fail(0, f"dependency_unavailable:{exc}")

    clip_id = os.environ.get("SMART_REFRAME_DEBUG_CLIP_ID", "unknown")
    debug_enabled = os.environ.get("SMART_REFRAME_DEBUG_EXPORT", "false").lower() == "true"
    debug_dir = Path(os.environ.get("SMART_REFRAME_DEBUG_DIR", f"{Path.cwd()}/tmp/reframe-debug"))
    debug_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        fail(1, "video_open_failed")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920.0
    height = cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080.0
    sample_interval_sec = 0.5
    step = max(1, int(round(fps * sample_interval_sec)))

    crop_width = 860.0
    crop_height = 1529.0

    body_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_upperbody.xml")
    mp_face = mp.solutions.face_detection
    detector = mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.45)

    points = []
    detected_faces = []
    chosen_subject = []
    debug_frames = []
    frames_with_detection = 0
    saved_debug_frames = 0

    frame_idx = 0
    active_bbox: Optional[Tuple[float, float, float, float]] = None
    active_mode = "face"
    pending_switch_count = 0
    prev_gray = None
    active_track_age = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx % step != 0:
            frame_idx += 1
            continue

        t_abs = frame_idx / fps
        if t_abs < start_sec:
            frame_idx += 1
            continue
        if t_abs > end_sec:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = detector.process(rgb)
        faces = []
        if result.detections:
            for det in result.detections:
                bbox = det.location_data.relative_bounding_box
                x = max(0.0, bbox.xmin * width)
                y = max(0.0, bbox.ymin * height)
                w = max(1.0, bbox.width * width)
                h = max(1.0, bbox.height * height)
                faces.append((float(x), float(y), float(w), float(h)))

        bodies_raw = [] if body_cascade.empty() else list(body_cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(80, 80)))
        bodies = [(float(x), float(y), float(w), float(h)) for (x, y, w, h) in bodies_raw]
        faces.sort(key=lambda f: face_score(f, width, height), reverse=True)
        bodies.sort(key=lambda b: body_score(b, width, height), reverse=True)

        rel_t = round(float(t_abs - start_sec), 3)
        motion_boxes = motion_regions(cv2, prev_gray, gray, width, height) if prev_gray is not None else []
        prev_gray = gray

        selected = None
        selected_mode = "motion"
        fallback_used = False

        if faces:
            ranked_faces = sorted(faces, key=lambda f: ((f[2] * f[3]), track_score(f, active_bbox if active_mode == "face" else None, width, height)), reverse=True)
            best_face = ranked_faces[0]
            if active_bbox is not None and active_mode == "face":
                best_iou = max(iou(active_bbox, f) for f in ranked_faces)
                current_face = ranked_faces[0]
                current_score = track_score(current_face, active_bbox, width, height)
                locked_score = track_score(active_bbox, active_bbox, width, height)
                if best_iou >= 0.18 or current_score >= locked_score * 0.95:
                    selected = current_face
                    pending_switch_count = 0
                    active_track_age += 1
                else:
                    pending_switch_count += 1
                    if pending_switch_count >= 8:
                        selected = best_face
                        pending_switch_count = 0
                        active_track_age = 0
                    else:
                        selected = active_bbox
                        fallback_used = True
            else:
                selected = best_face
                pending_switch_count = 0
                active_track_age = 0
            selected_mode = "face"
        elif bodies:
            selected = bodies[0] if active_bbox is None or active_mode != "body" else max(bodies, key=lambda b: iou(active_bbox, b) * 1.8 + body_score(b, width, height))
            selected_mode = "body"
            pending_switch_count = 0
            active_track_age = 0
        elif motion_boxes:
            selected = motion_boxes[0] if active_bbox is None or active_mode != "motion" else max(motion_boxes, key=lambda b: iou(active_bbox, b) * 1.5 + (b[2] * b[3]))
            selected_mode = "motion"
            pending_switch_count = 0
            active_track_age = 0
        elif active_bbox is not None:
            selected = active_bbox
            selected_mode = "previous"
            fallback_used = True

        if selected is None:
            frame_idx += 1
            continue

        cx, cy = center(selected)
        nx = clamp01(cx / width)
        ny_raw = clamp01(cy / height)

        if selected_mode == "face":
            face_cx = clamp01(cx / width)
            nx = clamp01(max(SAFE_EDGE_MARGIN_X, min(1.0 - SAFE_EDGE_MARGIN_X, face_cx)))
            face_top = clamp01(selected[1] / max(height, 1.0))
            face_h_norm = clamp01(selected[3] / max(height, 1.0))
            ny = clamp01(face_top + face_h_norm * TARGET_FACE_TOP)
        elif selected_mode == "body":
            body_cx = clamp01(cx / width)
            nx = clamp01(max(SAFE_EDGE_MARGIN_X, min(1.0 - SAFE_EDGE_MARGIN_X, body_cx)))
            body_top = clamp01(selected[1] / max(height, 1.0))
            body_h_norm = clamp01(selected[3] / max(height, 1.0))
            ny = clamp01(body_top + body_h_norm * 0.32)
        else:
            ny = ny_raw

        crop_x = max(0.0, min(width - crop_width, cx - crop_width / 2.0))
        crop_y = max(0.0, min(height - crop_height, cy - crop_height * 0.40))
        crop_box = (crop_x, crop_y, crop_width, crop_height)

        framing = "single_stable" if selected_mode == "face" and active_track_age >= 2 else "single"
        points.append({"t": rel_t, "cx": cx, "cy": cy, "nx": nx, "ny": ny, "w": selected[2], "h": selected[3], "framing": framing, "mode": selected_mode})
        active_bbox = selected
        active_mode = selected_mode
        frames_with_detection += 1 if selected_mode != "previous" else 0

        frame_record = {
            "timestamp": rel_t,
            "detected_face": {"x": selected[0], "y": selected[1], "w": selected[2], "h": selected[3]} if selected_mode == "face" else None,
            "chosen_center_x": cx,
            "chosen_center_y": cy,
            "crop_x": crop_x,
            "crop_y": crop_y,
            "crop_w": crop_width,
            "crop_h": crop_height,
            "fallback_used": fallback_used,
            "mode": selected_mode,
        }
        debug_frames.append(frame_record)
        chosen_subject.append({"t": rel_t, "mode": selected_mode, "primary": {"cx": cx, "cy": cy, "w": selected[2], "h": selected[3]}})
        detected_faces.append({"t": rel_t, "faces": [{"x": f[0], "y": f[1], "w": f[2], "h": f[3]} for f in faces[:4]]})

        if debug_enabled and saved_debug_frames < DEBUG_FRAME_COUNT:
            save_debug_frame(cv2, frame, debug_dir / f"{clip_id}-{saved_debug_frames:02d}.jpg", selected, crop_box, (cx, cy))
            saved_debug_frames += 1

        frame_idx += 1

    cap.release()
    detector.close()

    avg_nx = sum(p["nx"] for p in points) / len(points) if points else 0.5
    avg_ny = sum(p["ny"] for p in points) / len(points) if points else 0.42
    detection_pct = (frames_with_detection / len(points)) if points else 0.0

    print(json.dumps({
        "ok": True,
        "meta": {
            "fps": fps,
            "width": width,
            "height": height,
            "sample_fps": 2.0,
            "points": len(points),
            "frames_with_detection_pct": detection_pct,
            "average_face_center": {"x": avg_nx, "y": avg_ny},
            "fallback_used": detection_pct < 0.99,
            "saved_debug_frames": saved_debug_frames,
        },
        "detected_faces": detected_faces,
        "chosen_subject": chosen_subject,
        "debug_frames": debug_frames,
        "points": points,
        "debug_overlay": {"target_face_top": TARGET_FACE_TOP, "safe_zone": {"center_x": 0.5, "face_top_min": 0.35, "face_top_max": 0.45}},
    }))


if __name__ == "__main__":
    main()
