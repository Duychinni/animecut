#!/usr/bin/env python3
import json
import math
import sys
from typing import Dict, List, Optional, Tuple


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


def main():
    if len(sys.argv) < 4:
        fail(2, "usage: reframe_cv.py <input_path> <start_sec> <end_sec> [sample_fps]")

    input_path = sys.argv[1]
    start_sec = float(sys.argv[2])
    end_sec = float(sys.argv[3])
    sample_fps = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0

    try:
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

    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        fail(1, "haar_cascade_unavailable")

    points = []
    detected_faces = []
    chosen_subject = []

    frame_idx = 0
    active_bbox: Optional[Tuple[float, float, float, float]] = None
    active_id: Optional[int] = None
    next_track_id = 1
    pending_switch_id: Optional[int] = None
    pending_switch_count = 0

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
        faces_raw = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40))
        faces = [(float(x), float(y), float(w), float(h)) for (x, y, w, h) in faces_raw]
        faces.sort(key=lambda f: f[2] * f[3], reverse=True)

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
            }
        )

        if not faces:
            frame_idx += 1
            continue

        # Best detection by size.
        best = faces[0]
        selected = best
        selected_id = active_id if active_id is not None else next_track_id

        if active_bbox is not None:
            # Keep current subject unless switch is consistently better for ~2 samples.
            best_iou = max(iou(active_bbox, f) for f in faces)
            active_present = best_iou >= 0.12

            if active_present:
                # stick to nearest active face candidate
                selected = max(faces, key=lambda f: iou(active_bbox, f))
            else:
                selected = best

            if best != selected:
                # switching candidate appeared; require persistence (hysteresis)
                switch_id = id(best)
                if pending_switch_id == switch_id:
                    pending_switch_count += 1
                else:
                    pending_switch_id = switch_id
                    pending_switch_count = 1

                if pending_switch_count >= 2:
                    selected = best
                    pending_switch_id = None
                    pending_switch_count = 0
                else:
                    # hold current subject this frame
                    selected = selected
            else:
                pending_switch_id = None
                pending_switch_count = 0
        else:
            selected = best

        # Two-speaker handling: if two similar faces, center between them briefly (wider-feel framing).
        framing = "single"
        if len(faces) >= 2:
            f1, f2 = faces[0], faces[1]
            a1, a2 = f1[2] * f1[3], f2[2] * f2[3]
            ratio = (a1 / a2) if a2 > 0 else 999.0
            c1x, c1y = center(f1)
            c2x, c2y = center(f2)
            dx = abs(c1x - c2x) / max(width, 1.0)
            dy = abs(c1y - c2y) / max(height, 1.0)

            if ratio < 1.65 and dx > 0.12 and dx < 0.65 and dy < 0.22:
                mx = (c1x + c2x) / 2.0
                my = (c1y + c2y) / 2.0
                points.append(
                    {
                        "t": rel_t,
                        "cx": mx,
                        "cy": my,
                        "nx": max(0.0, min(1.0, mx / width)),
                        "ny": max(0.0, min(1.0, my / height)),
                        "w": max(f1[2], f2[2]),
                        "h": max(f1[3], f2[3]),
                        "framing": "wide_pair",
                    }
                )
                chosen_subject.append({"t": rel_t, "mode": "pair", "primary": None})
                frame_idx += 1
                continue

        cx, cy = center(selected)
        points.append(
            {
                "t": rel_t,
                "cx": cx,
                "cy": cy,
                "nx": max(0.0, min(1.0, cx / width)),
                "ny": max(0.0, min(1.0, cy / height)),
                "w": selected[2],
                "h": selected[3],
                "framing": framing,
            }
        )

        # update active subject for next step
        active_bbox = selected
        if active_id is None:
            active_id = next_track_id
            next_track_id += 1
        selected_id = active_id

        chosen_subject.append(
            {
                "t": rel_t,
                "mode": "single",
                "primary": {
                    "subject_id": selected_id,
                    "cx": cx,
                    "cy": cy,
                    "w": selected[2],
                    "h": selected[3],
                },
            }
        )

        frame_idx += 1

    cap.release()

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
                },
                "detected_faces": detected_faces,
                "chosen_subject": chosen_subject,
                "points": points,
            }
        )
    )


if __name__ == "__main__":
    main()
