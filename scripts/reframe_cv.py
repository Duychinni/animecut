#!/usr/bin/env python3
import json
import math
import sys
from typing import List, Optional, Tuple

TARGET_FACE_TOP = 0.40


def fail(code: int, error: str):
    print(json.dumps({"ok": False, "error": error}))
    sys.exit(code)


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


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def face_score(face: Tuple[float, float, float, float], width: float, height: float) -> float:
    x, y, w, h = face
    cx, cy = center(face)
    area = w * h
    frame_area = max(width * height, 1.0)
    area_ratio = area / frame_area
    center_bias = 1.0 - min(1.0, abs((cx / max(width, 1.0)) - 0.5) * 1.5)
    upper_bias = 1.0 - min(1.0, abs((cy / max(height, 1.0)) - 0.42) * 1.35)
    portrait_bias = 1.0 - min(1.0, abs((cx / max(width, 1.0)) - 0.5) * 1.1)
    return area_ratio * 5.0 + center_bias * 0.9 + upper_bias * 0.85 + portrait_bias * 0.5


def track_score(candidate: Tuple[float, float, float, float], active_bbox: Optional[Tuple[float, float, float, float]], width: float, height: float) -> float:
    base = face_score(candidate, width, height)
    if active_bbox is None:
        return base

    overlap = iou(active_bbox, candidate)
    acx, acy = center(active_bbox)
    ccx, ccy = center(candidate)
    dist = math.hypot((ccx - acx) / max(width, 1.0), (ccy - acy) / max(height, 1.0))
    continuity = max(0.0, 1.0 - dist * 2.4)
    return base + overlap * 2.2 + continuity * 1.4


def body_score(box: Tuple[float, float, float, float], width: float, height: float) -> float:
    x, y, w, h = box
    cx, cy = center(box)
    area_ratio = (w * h) / max(width * height, 1.0)
    center_bias = 1.0 - min(1.0, abs((cx / max(width, 1.0)) - 0.5) * 1.25)
    upper_bias = 1.0 - min(1.0, abs((cy / max(height, 1.0)) - 0.50) * 1.15)
    tall_bias = min(1.0, (h / max(w, 1.0)) / 2.2)
    return area_ratio * 3.5 + center_bias * 0.7 + upper_bias * 0.6 + tall_bias * 0.8


def motion_regions(prev_gray, gray, width: float, height: float):
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


def main():
    if len(sys.argv) < 4:
        fail(2, "usage: reframe_cv.py <input_path> <start_sec> <end_sec> [sample_fps]")

    input_path = sys.argv[1]
    start_sec = float(sys.argv[2])
    end_sec = float(sys.argv[3])
    sample_fps = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0

    try:
        global cv2
        import cv2  # type: ignore
    except Exception:
        fail(0, "opencv_unavailable")

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        fail(1, "video_open_failed")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920.0
    height = cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080.0

    step = max(1, int(round(fps / max(sample_fps, 0.25))))

    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    profile_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    body_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_fullbody.xml")
    upper_body_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_upperbody.xml")
    if face_cascade.empty():
        fail(1, "haar_cascade_unavailable")

    points = []
    detected_faces = []
    chosen_subject = []
    debug_frames = []
    frames_with_detection = 0

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
        gray = cv2.equalizeHist(gray)

        faces_raw = list(face_cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=5, minSize=(52, 52)))
        profiles_raw = [] if profile_cascade.empty() else list(profile_cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(52, 52)))
        bodies_raw = [] if body_cascade.empty() else list(body_cascade.detectMultiScale(gray, scaleFactor=1.04, minNeighbors=3, minSize=(80, 160)))
        upper_bodies_raw = [] if upper_body_cascade.empty() else list(upper_body_cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(80, 80)))

        faces = [(float(x), float(y), float(w), float(h)) for (x, y, w, h) in faces_raw + profiles_raw]
        bodies = [(float(x), float(y), float(w), float(h)) for (x, y, w, h) in bodies_raw + upper_bodies_raw]
        faces.sort(key=lambda f: face_score(f, width, height), reverse=True)
        bodies.sort(key=lambda b: body_score(b, width, height), reverse=True)

        rel_t = round(float(t_abs - start_sec), 3)
        detected_faces.append(
            {
                "t": rel_t,
                "faces": [
                    {
                        "x": f[0],
                        "y": f[1],
                        "w": f[2],
                        "h": f[3],
                        "cx": center(f)[0],
                        "cy": center(f)[1],
                        "area": f[2] * f[3],
                    }
                    for f in faces[:4]
                ],
                "bodies": [
                    {
                        "x": b[0],
                        "y": b[1],
                        "w": b[2],
                        "h": b[3],
                        "cx": center(b)[0],
                        "cy": center(b)[1],
                        "area": b[2] * b[3],
                    }
                    for b in bodies[:3]
                ],
            }
        )

        motion_boxes = motion_regions(prev_gray, gray, width, height) if prev_gray is not None else []
        prev_gray = gray

        selected = None
        selected_mode = "motion"

        if faces:
            ranked_faces = sorted(faces, key=lambda f: track_score(f, active_bbox if active_mode == "face" else None, width, height), reverse=True)
            best_face = ranked_faces[0]
            if active_bbox is not None and active_mode == "face":
                best_iou = max(iou(active_bbox, f) for f in ranked_faces)
                if best_iou >= 0.10:
                    selected = ranked_faces[0]
                    pending_switch_count = 0
                    active_track_age += 1
                else:
                    pending_switch_count += 1
                    if pending_switch_count >= 3:
                        selected = best_face
                        pending_switch_count = 0
                        active_track_age = 0
                    else:
                        selected = active_bbox
            else:
                selected = best_face
                pending_switch_count = 0
                active_track_age = 0

            selected_mode = "face"

            if len(ranked_faces) >= 2:
                f1, f2 = ranked_faces[0], ranked_faces[1]
                a1, a2 = f1[2] * f1[3], f2[2] * f2[3]
                ratio = (a1 / a2) if a2 > 0 else 999.0
                c1x, c1y = center(f1)
                c2x, c2y = center(f2)
                dx = abs(c1x - c2x) / max(width, 1.0)
                dy = abs(c1y - c2y) / max(height, 1.0)
                if ratio < 1.8 and 0.08 < dx < 0.68 and dy < 0.28:
                    mx = (c1x + c2x) / 2.0
                    my = (c1y + c2y) / 2.0
                    span_w = abs(c1x - c2x) + max(f1[2], f2[2])
                    span_h = max(f1[3], f2[3])
                    points.append(
                        {
                            "t": rel_t,
                            "cx": mx,
                            "cy": my,
                            "nx": clamp01(mx / width),
                            "ny": clamp01(my / height),
                            "w": span_w,
                            "h": span_h,
                            "framing": "wide_pair",
                            "mode": "face_pair",
                        }
                    )
                    chosen_subject.append({"t": rel_t, "mode": "face_pair"})
                    active_bbox = None
                    active_mode = "face"
                    active_track_age = 0
                    frame_idx += 1
                    continue

        elif bodies:
            if active_bbox is not None and active_mode == "body":
                selected = max(bodies, key=lambda b: iou(active_bbox, b) * 1.8 + body_score(b, width, height))
            else:
                selected = bodies[0]
            selected_mode = "body"
            pending_switch_count = 0
            active_track_age = 0

        elif motion_boxes:
            best_motion = motion_boxes[0]
            if active_bbox is not None and active_mode == "motion":
                best_motion = max(motion_boxes, key=lambda b: iou(active_bbox, b) * 1.5 + (b[2] * b[3]))
            selected = best_motion
            selected_mode = "motion"
            pending_switch_count = 0
            active_track_age = 0

        if selected is None:
            if active_bbox is not None:
                selected = active_bbox
                selected_mode = "previous"
            else:
                frame_idx += 1
                continue

        cx, cy = center(selected)
        nx = clamp01(cx / width)
        ny_raw = clamp01(cy / height)

        if selected_mode == "face":
            face_top = clamp01((selected[1]) / max(height, 1.0))
            ny = clamp01(face_top + TARGET_FACE_TOP * 0.18)
        elif selected_mode == "body":
            body_top = clamp01((selected[1]) / max(height, 1.0))
            ny = clamp01(body_top + 0.32)
        else:
            ny = ny_raw

        framing = "single_stable" if selected_mode == "face" and active_track_age >= 2 else "single"
        points.append(
            {
                "t": rel_t,
                "cx": cx,
                "cy": cy,
                "nx": nx,
                "ny": ny,
                "w": selected[2],
                "h": selected[3],
                "framing": framing,
                "mode": selected_mode,
            }
        )

        active_bbox = selected
        active_mode = selected_mode
        frames_with_detection += 1 if selected_mode != "previous" else 0
        chosen_subject.append(
            {
                "t": rel_t,
                "mode": selected_mode,
                "primary": {
                    "cx": cx,
                    "cy": cy,
                    "w": selected[2],
                    "h": selected[3],
                },
            }
        )
        debug_frames.append(
            {
                "t": rel_t,
                "mode": selected_mode,
                "detections_found": {
                    "faces": len(faces),
                    "bodies": len(bodies),
                    "motion": len(motion_boxes),
                },
                "subject_center": {"x": nx, "y": ny},
            }
        )

        frame_idx += 1

    cap.release()

    avg_nx = sum(p["nx"] for p in points) / len(points) if points else 0.5
    avg_ny = sum(p["ny"] for p in points) / len(points) if points else 0.42
    detection_pct = (frames_with_detection / len(points)) if points else 0.0

    print(
        json.dumps(
            {
                "ok": True,
                "meta": {
                    "fps": fps,
                    "width": width,
                    "height": height,
                    "sample_fps": sample_fps,
                    "points": len(points),
                    "frames_with_detection_pct": detection_pct,
                    "average_face_center": {"x": avg_nx, "y": avg_ny},
                    "fallback_used": detection_pct < 0.99,
                },
                "detected_faces": detected_faces,
                "chosen_subject": chosen_subject,
                "debug_frames": debug_frames,
                "points": points,
            }
        )
    )


if __name__ == "__main__":
    main()
