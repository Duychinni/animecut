#!/usr/bin/env python3
"""Sample the customer-facing MP4 itself and report visible render defects."""
import json
import math
import sys


def fail(message):
    print(json.dumps({'ok': False, 'error': message}))
    raise SystemExit(1)


def main():
    if len(sys.argv) != 4:
        fail('usage: post_render_visual_qa.py <mp4> <layout_metadata_json> <report_json>')
    video_path, metadata_path, report_path = sys.argv[1:4]
    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
    except Exception as exc:
        fail(f'dependency_unavailable:{exc}')

    metadata = json.loads(open(metadata_path, 'r', encoding='utf-8').read())
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        fail('video_open_failed')
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / max(fps, 1.0)
    sample_rate = 4.0
    sample_times = [index / sample_rate for index in range(max(1, int(math.ceil(duration * sample_rate))))]
    detector = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.42)

    samples = []
    edge_collisions = []
    severe_empty_frames = []
    blurry_frames = []
    for timestamp in sample_times:
        capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        height, width = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        dark_ratio = float((gray < 12).sum()) / max(1, gray.size)
        result = detector.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        faces = []
        for detection in result.detections or []:
            box = detection.location_data.relative_bounding_box
            x1 = max(0.0, float(box.xmin)); y1 = max(0.0, float(box.ymin))
            x2 = min(1.0, float(box.xmin + box.width)); y2 = min(1.0, float(box.ymin + box.height))
            margin = min(x1, y1, 1.0 - x2, 1.0 - y2)
            faces.append({'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'edge_margin': margin})
            if margin < 0.012:
                edge_collisions.append(round(timestamp, 3))
        if dark_ratio > 0.72:
            severe_empty_frames.append(round(timestamp, 3))
        if sharpness < 18.0:
            blurry_frames.append(round(timestamp, 3))
        samples.append({
            'timestamp': round(timestamp, 3), 'faces': len(faces),
            'edge_collision': any(face['edge_margin'] < 0.012 for face in faces),
            'dark_ratio': round(dark_ratio, 4), 'sharpness': round(sharpness, 2),
        })

    detector.close(); capture.release()
    report = {
        'ok': True,
        'video_path': video_path,
        'duration_seconds': round(duration, 3),
        'sample_rate_fps': sample_rate,
        'rendered_samples_checked': len(samples),
        'face_edge_collision_timestamps': sorted(set(edge_collisions)),
        'severe_empty_frame_timestamps': sorted(set(severe_empty_frames)),
        'blurry_frame_timestamps': sorted(set(blurry_frames)),
        'pre_render_layout_qa': (metadata.get('meta') or {}).get('layout_qa'),
        'layout_timeline_segments': len(metadata.get('reframe_timeline') or []),
        'debug_overlay_expected_in_normal_mp4': False,
        'samples': samples,
    }
    open(report_path, 'w', encoding='utf-8').write(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    main()
