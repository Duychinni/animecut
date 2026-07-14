#!/usr/bin/env python3
"""Select a representative poster from the final customer-facing render."""
import json
import math
import sys


def clamp(value, low, high):
    return max(low, min(high, value))


def fail(message):
    print(json.dumps({'ok': False, 'error': message}))
    raise SystemExit(1)


def main():
    if len(sys.argv) != 4:
        fail('usage: select_thumbnail.py <input_mp4> <output_jpg> <duration_seconds>')

    input_path, output_path = sys.argv[1], sys.argv[2]
    duration = max(0.25, float(sys.argv[3]))

    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
    except Exception as exc:
        fail(f'dependency_unavailable:{exc}')

    capture = cv2.VideoCapture(input_path)
    if not capture.isOpened():
        fail('video_open_failed')

    detector = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.42)
    face_mesh = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=4,
        refine_landmarks=False,
        min_detection_confidence=0.42,
    )
    sample_start = min(max(0.35, duration * 0.08), max(0.0, duration - 0.25))
    sample_end = max(sample_start, min(duration - 0.25, duration * 0.90))
    sample_count = max(8, min(20, int(math.ceil(duration / 3.0))))
    sample_times = [
        sample_start + (sample_end - sample_start) * index / max(1, sample_count - 1)
        for index in range(sample_count)
    ]

    best = None
    samples = []
    for timestamp in sample_times:
        capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue

        height, width = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        brightness = float(gray.mean())
        exposure_score = 1.0 - clamp(abs(brightness - 128.0) / 128.0, 0.0, 1.0)
        sharpness_score = clamp(math.log1p(sharpness) / 7.5, 0.0, 1.0)

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = detector.process(rgb)
        mesh_result = face_mesh.process(rgb)
        eye_openness = []
        if mesh_result.multi_face_landmarks:
            for landmarks in mesh_result.multi_face_landmarks:
                points = landmarks.landmark
                def distance(first, second):
                    return math.hypot(points[first].x - points[second].x, points[first].y - points[second].y)
                left_ratio = distance(159, 145) / max(distance(33, 133), 1e-6)
                right_ratio = distance(386, 374) / max(distance(362, 263), 1e-6)
                eye_openness.append((left_ratio + right_ratio) / 2.0)
        open_eye_score = clamp((max(eye_openness, default=0.0) - 0.12) / 0.10, 0.0, 1.0)
        face_scores = []
        if result.detections:
            for detection in result.detections:
                bbox = detection.location_data.relative_bounding_box
                x1 = clamp(float(bbox.xmin), 0.0, 1.0)
                y1 = clamp(float(bbox.ymin), 0.0, 1.0)
                x2 = clamp(float(bbox.xmin + bbox.width), 0.0, 1.0)
                y2 = clamp(float(bbox.ymin + bbox.height), 0.0, 1.0)
                area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
                center_x = (x1 + x2) / 2.0
                center_y = (y1 + y2) / 2.0
                edge_margin = min(x1, 1.0 - x2, y1, 1.0 - y2)
                edge_score = clamp(edge_margin / 0.08, 0.0, 1.0)
                eye_line_score = 1.0 - clamp(abs(center_y - 0.34) / 0.34, 0.0, 1.0)
                center_score = 1.0 - clamp(abs(center_x - 0.5) / 0.5, 0.0, 1.0)
                face_scores.append(
                    clamp(area * 7.5, 0.0, 1.0) * 0.30
                    + edge_score * 0.22
                    + eye_line_score * 0.16
                    + center_score * 0.12
                    + open_eye_score * 0.20
                )

        face_score = max(face_scores, default=0.0)
        face_bonus = min(0.12, max(0, len(face_scores) - 1) * 0.04)
        time_position = timestamp / duration
        time_score = 1.0 - clamp(abs(time_position - 0.42) / 0.48, 0.0, 1.0)
        score = (
            face_score * 0.46
            + sharpness_score * 0.25
            + exposure_score * 0.17
            + time_score * 0.12
            + face_bonus
        )
        sample = {
            'timestamp': round(timestamp, 3),
            'score': round(score, 4),
            'faces': len(face_scores),
            'eye_openness': round(max(eye_openness, default=0.0), 4),
            'sharpness': round(sharpness, 2),
            'brightness': round(brightness, 2),
        }
        samples.append(sample)
        if best is None or score > best['score']:
            best = {'score': score, 'frame': frame.copy(), **sample}

    detector.close()
    face_mesh.close()
    capture.release()
    if best is None:
        fail('no_decodable_samples')

    if not cv2.imwrite(output_path, best['frame'], [int(cv2.IMWRITE_JPEG_QUALITY), 94]):
        fail('thumbnail_write_failed')

    print(json.dumps({
        'ok': True,
        'selected_timestamp': best['timestamp'],
        'selected_score': round(float(best['score']), 4),
        'selected_faces': best['faces'],
        'samples': samples,
    }))


if __name__ == '__main__':
    main()
