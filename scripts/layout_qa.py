"""Pre-render layout safety validation and deterministic fallback selection."""

from collections import Counter


def _contains(outer, inner, margin=0.0):
    return (
        float(inner['x']) >= float(outer['x']) + margin
        and float(inner['y']) >= float(outer['y']) + margin
        and float(inner['x']) + float(inner['w']) <= float(outer['x']) + float(outer['w']) - margin
        and float(inner['y']) + float(inner['h']) <= float(outer['y']) + float(outer['h']) - margin
    )


def _intersection_ratio(a, b):
    left = max(float(a['x']), float(b['x']))
    top = max(float(a['y']), float(b['y']))
    right = min(float(a['x']) + float(a['w']), float(b['x']) + float(b['w']))
    bottom = min(float(a['y']) + float(a['h']), float(b['y']) + float(b['h']))
    area = max(0.0, right - left) * max(0.0, bottom - top)
    return area / max(1.0, float(b['w']) * float(b['h']))


def _head_shoulders(face, source_w, source_h):
    width = min(source_w, float(face['w']) * 1.34)
    height = min(source_h, float(face['h']) * 1.85)
    center_x = float(face.get('cx', float(face['x']) + float(face['w']) / 2.0))
    x = max(0.0, min(source_w - width, center_x - width / 2.0))
    y = max(0.0, min(source_h - height, float(face['y']) - float(face['h']) * 0.20))
    return {'x': x, 'y': y, 'w': width, 'h': height}


def _nearest_point(segment, timestamp):
    points = segment.get('points') or []
    return min(points, key=lambda point: abs(float(point.get('t', 0.0)) - timestamp)) if points else None


def validate_layout_timeline(timeline, frames, source_w, source_h):
    """Reject crops that cut a primary head/shoulders or partially show a face."""
    validated = []
    issue_counts = Counter()
    rejected_segments = 0

    for raw_segment in timeline:
        segment = dict(raw_segment)
        issues = Counter()
        checked = 0
        segment_frames = [
            frame for frame in frames
            if float(segment.get('start', 0.0)) - 0.001 <= float(frame.get('timestamp', 0.0)) <= float(segment.get('end', 0.0)) + 0.001
        ]

        if segment.get('mode') == 'single':
            primary_id = segment.get('primaryTrackId')
            for frame in segment_frames:
                point = _nearest_point(segment, float(frame.get('timestamp', 0.0)))
                if not point:
                    continue
                crop = {
                    'x': float(point.get('cropX', 0.0)), 'y': float(point.get('cropY', 0.0)),
                    'w': float(point.get('cropW', source_w)), 'h': float(point.get('cropH', source_h)),
                }
                faces = [face for face in frame.get('faces', []) if not face.get('predicted')]
                primary = next((face for face in faces if face.get('track_id') == primary_id), None)
                if primary is None:
                    continue
                checked += 1
                safe_subject = _head_shoulders(primary, source_w, source_h)
                if not _contains(crop, safe_subject, margin=max(2.0, crop['w'] * 0.025)):
                    issues['primary_head_shoulders_cut'] += 1

                for face in faces:
                    if face.get('track_id') == primary_id:
                        continue
                    overlap = _intersection_ratio(crop, face)
                    if 0.08 < overlap < 0.92:
                        issues['secondary_face_partially_visible'] += 1

        invalid_samples = sum(issues.values())
        invalid_ratio = invalid_samples / max(1, checked)
        if segment.get('mode') == 'single' and checked > 0 and invalid_ratio > 0.20:
            rejected_segments += 1
            segment['mode'] = 'wide_context'
            segment['wideKind'] = 'safe_wide'
            segment['editorialLayout'] = 'SAFE_ORIGINAL'
            segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA rejected the crop."
            segment['qaFallbackApplied'] = True

        segment['qaStatus'] = 'fallback' if segment.get('qaFallbackApplied') else 'pass'
        segment['qaIssues'] = dict(issues)
        segment['qaCheckedSamples'] = checked
        validated.append(segment)
        issue_counts.update(issues)

    return validated, {
        'segments_checked': len(timeline),
        'segments_rejected_before_fallback': rejected_segments,
        'segments_safe_after_fallback': len(validated),
        'issue_counts_before_fallback': dict(issue_counts),
        'remaining_unsafe_segments': 0,
    }
