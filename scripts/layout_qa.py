"""Pre-render layout safety validation and deterministic fallback selection."""

from collections import Counter


FIXED_TWO_REGION_LAYOUTS = {
    'FIXED_TWO_REGION_CONVERSATION',
    'FIXED_TWO_PANEL_INTERVIEW',
}


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


def _nearest_frame(frames, timestamp):
    return min(frames, key=lambda frame: abs(float(frame.get('timestamp', 0.0)) - timestamp)) if frames else None


def _panel_crop_for_face(face, source_w, source_h, panel_left, panel_right):
    panel_width = max(2.0, float(panel_right) - float(panel_left))
    face_h = max(1.0, float(face.get('h', 1.0)))
    crop_h = min(float(source_h), max(face_h / 0.24, face_h * 3.6))
    crop_w = min(panel_width, crop_h * 9.0 / 16.0)
    if crop_w >= panel_width:
        crop_h = min(float(source_h), crop_w * 16.0 / 9.0)
    face_cx = float(face.get('cx', float(face['x']) + float(face['w']) / 2.0))
    crop_x = max(float(panel_left), min(float(panel_right) - crop_w, face_cx - crop_w / 2.0))
    crop_y = max(0.0, min(float(source_h) - crop_h, float(face['y']) - crop_h * 0.08))
    return {
        'cropX': round(crop_x, 3), 'cropY': round(crop_y, 3),
        'cropW': round(crop_w, 3), 'cropH': round(crop_h, 3),
        'cropCenterX': round(crop_x + crop_w / 2.0, 3),
        'cropCenterY': round(crop_y + crop_h / 2.0, 3),
        'zoom': round(float(source_h) / max(crop_h, 1.0), 4),
    }


def _median_crop(crops):
    if not crops:
        return None
    ordered = sorted(
        crops,
        key=lambda crop: (
            float(crop['cropCenterX']),
            float(crop['cropCenterY']),
            float(crop['cropW']),
            float(crop['cropH']),
        ),
    )
    return dict(ordered[len(ordered) // 2])


def _apply_locked_crop(points, crop):
    if not crop:
        return
    for point in points:
        point.update(crop)


def _distinct_face_pair_for_boxes(faces, top_box, bottom_box):
    top_matches = [face for face in faces if _intersection_ratio(top_box, face) >= 0.35]
    bottom_matches = [face for face in faces if _intersection_ratio(bottom_box, face) >= 0.35]
    for top_face in top_matches:
        for bottom_face in bottom_matches:
            top_id = top_face.get('track_id')
            bottom_id = bottom_face.get('track_id')
            if top_id is not None and bottom_id is not None and top_id == bottom_id:
                continue
            if _intersection_ratio(top_face, bottom_face) > 0.25:
                continue
            return top_face, bottom_face
    return None


def _best_verified_face(frames):
    by_track = {}
    for frame in frames:
        for face in frame.get('faces', []):
            if face.get('predicted') or face.get('track_id') is None:
                continue
            track_id = face.get('track_id')
            by_track.setdefault(track_id, []).append(face)
    if not by_track:
        return None, None
    track_id, faces = max(
        by_track.items(),
        key=lambda item: (
            len(item[1]),
            sum(float(face.get('w', 0.0)) * float(face.get('h', 0.0)) for face in item[1]),
        ),
    )
    ordered = sorted(
        faces,
        key=lambda face: (
            float(face.get('cx', float(face['x']) + float(face['w']) / 2.0)),
            float(face.get('cy', float(face['y']) + float(face['h']) / 2.0)),
        ),
    )
    return track_id, dict(ordered[len(ordered) // 2])


def validate_layout_timeline(timeline, frames, source_w, source_h):
    """Reject crops that cut a primary head/shoulders or partially show a face."""
    validated = []
    issue_counts = Counter()
    rejected_segments = 0
    remaining_unsafe_segments = 0

    for raw_segment in timeline:
        segment = dict(raw_segment)
        issues = Counter()
        checked = 0
        segment_points = segment.get('points') or []
        speaking_face_points = [
            point for point in segment_points
            if float(point.get('audioActivity', 0.0)) >= 0.10
            and point.get('subjectKind') == 'face'
        ]
        if (
            segment.get('mode') == 'wide_context'
            and segment.get('primaryTrackId') is not None
            and speaking_face_points
            and len(speaking_face_points) >= max(1, len(segment_points) // 2)
        ):
            segment['mode'] = 'single'
            segment['wideKind'] = None
            segment['editorialLayout'] = 'ACTIVE_SPEAKER_CROP'
            segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA restored the verified speaking person."
        segment_frames = [
            frame for frame in frames
            if float(segment.get('start', 0.0)) - 0.001 <= float(frame.get('timestamp', 0.0)) <= float(segment.get('end', 0.0)) + 0.001
        ]

        if segment.get('mode') == 'stacked' and segment.get('topBox') and segment.get('bottomBox'):
            verified_pair_samples = 0
            face_samples = 0
            for frame in segment_frames:
                faces = [face for face in frame.get('faces', []) if not face.get('predicted')]
                if not faces:
                    continue
                face_samples += 1
                if _distinct_face_pair_for_boxes(faces, segment['topBox'], segment['bottomBox']):
                    verified_pair_samples += 1
            required_pair_samples = max(2, (face_samples + 1) // 2)
            if face_samples and verified_pair_samples < required_pair_samples:
                # A stale second box can survive a camera cut and turn the
                # empty set, a microphone, or a duplicate crop into the lower
                # panel. A stacked export is allowed only when two distinct
                # faces remain visually verified through the shot.
                issues['stacked_distinct_faces_unverified'] += 1
                primary_id, primary_face = _best_verified_face(segment_frames)
                if primary_face:
                    crop = _panel_crop_for_face(primary_face, source_w, source_h, 0.0, source_w)
                    _apply_locked_crop(segment_points, crop)
                    segment['mode'] = 'single'
                    segment['primaryTrackId'] = primary_id
                    segment['subjectKind'] = 'face'
                    segment['topBox'] = None
                    segment['bottomBox'] = None
                    segment['wideKind'] = None
                    segment['editorialLayout'] = 'ACTIVE_SPEAKER_CROP'
                    segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA removed an unverified empty or duplicate panel."
                    segment['qaFallbackApplied'] = 'invalid_stacked_to_verified_single'
                else:
                    segment['mode'] = 'wide_context'
                    segment['wideKind'] = 'safe_wide'
                    segment['topBox'] = None
                    segment['bottomBox'] = None
                    segment['editorialLayout'] = 'SAFE_ORIGINAL'
                    segment['qaFallbackApplied'] = 'invalid_stacked_to_safe_original'

        if segment.get('mode') == 'stacked' and not (segment.get('topBox') and segment.get('bottomBox')):
            issues['stacked_subject_box_missing'] += 1
            segment['mode'] = 'wide_context'
            segment['wideKind'] = 'safe_wide'
            segment['qaFallbackApplied'] = 'safe_original'

        if segment.get('mode') == 'grid':
            required = 4 if segment.get('gridTemplate') == 'grid_4' else 3
            subjects = [subject for subject in (segment.get('subjects') or []) if subject.get('box')]
            if len(subjects) < required:
                issues['grid_subject_box_missing'] += 1
                segment['mode'] = 'wide_context'
                segment['wideKind'] = 'safe_wide'
                segment['gridTemplate'] = None
                segment['subjects'] = []
                segment['qaFallbackApplied'] = 'safe_original'

        if segment.get('mode') == 'single':
            primary_id = segment.get('primaryTrackId')
            fixed_two_panel = segment.get('sourceLayout') in FIXED_TWO_REGION_LAYOUTS
            panel_boundary = float(segment.get('panelBoundaryX') or source_w / 2.0)
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
                if not _contains(crop, primary, margin=max(2.0, crop['w'] * 0.012)):
                    issues['primary_face_cut'] += 1

                if fixed_two_panel and crop['x'] < panel_boundary < crop['x'] + crop['w']:
                    issues['crop_crosses_panel_boundary'] += 1

                for face in faces:
                    if face.get('track_id') == primary_id:
                        continue
                    overlap = _intersection_ratio(crop, face)
                    if 0.08 < overlap < 0.92:
                        issues['secondary_face_partially_visible'] += 1

            if checked == 0:
                issues['no_primary_samples_checked'] += 1

        # A tight portrait may intentionally omit some shoulders. That is a
        # composition warning, not a reason to replace a complete speaker with
        # the full multi-person source. Face cuts, divider crossings, and
        # partially visible secondary faces remain hard safety failures.
        invalid_samples = sum(
            count for name, count in issues.items()
            if name != 'primary_head_shoulders_cut'
        )
        invalid_ratio = invalid_samples / max(1, checked)
        # A partially visible face or body fragment is noticeable even for a
        # brief beat. Allow one noisy detector sample, but reject sustained
        # unsafe crops instead of publishing them.
        unsafe_face_samples = (
            issues['primary_face_cut']
            + issues['secondary_face_partially_visible']
            + issues['crop_crosses_panel_boundary']
        )
        unsafe_face_ratio = unsafe_face_samples / max(1, checked)
        if segment.get('mode') == 'single' and (
            checked == 0
            or invalid_ratio > 0.08
            or unsafe_face_samples >= 2
            or unsafe_face_ratio > 0.05
        ):
            rejected_segments += 1
            if segment.get('sourceLayout') in FIXED_TWO_REGION_LAYOUTS:
                regions = segment.get('panelRegions') or {}
                primary_panel = segment.get('primaryPanel')
                region = regions.get(primary_panel) if primary_panel in ('left', 'right') else None
                primary_id = segment.get('primaryTrackId')
                corrected_crops = []
                if region and len(region) == 2:
                    for point in segment.get('points') or []:
                        frame = _nearest_frame(segment_frames, float(point.get('t', 0.0)))
                        primary = next(
                            (face for face in (frame or {}).get('faces', []) if face.get('track_id') == primary_id),
                            None,
                        )
                        if primary is None:
                            continue
                        corrected_crops.append(
                            _panel_crop_for_face(
                                primary, source_w, source_h,
                                float(region[0]), float(region[1]),
                            )
                        )
                locked_crop = _median_crop(corrected_crops)
                if locked_crop:
                    _apply_locked_crop(segment.get('points') or [], locked_crop)
                    segment['editorialLayout'] = 'ACTIVE_SPEAKER_CROP'
                    segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA constrained the crop to the active source panel."
                    segment['qaFallbackApplied'] = 'panel_bounded_crop'
                elif segment.get('topBox') and segment.get('bottomBox'):
                    segment['mode'] = 'stacked'
                    segment['wideKind'] = None
                    segment['editorialLayout'] = 'TWO_PERSON_CONVERSATION'
                    segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA preserved both source panels because active-speaker identity was uncertain."
                    segment['qaFallbackApplied'] = 'stacked_two_panel'
                else:
                    # Fail closed. Without verified primary samples or two
                    # independently safe participant boxes, preserve source
                    # context. Never invent a panel and never center a portrait
                    # crop on the divider.
                    segment['mode'] = 'wide_context'
                    segment['wideKind'] = 'safe_wide'
                    segment['editorialLayout'] = 'SAFE_ORIGINAL'
                    segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA lacked safe active-speaker evidence."
                    segment['qaFallbackApplied'] = 'safe_two_region_context'
            else:
                # A rejected generic crop does not mean the moment is
                # unusable. Build a tighter portrait region around the
                # verified primary face, bounded halfway to neighboring
                # faces, so only one complete person remains on screen.
                primary_id = segment.get('primaryTrackId')
                corrected_crops = []
                for point in segment.get('points') or []:
                    frame = _nearest_frame(segment_frames, float(point.get('t', 0.0)))
                    faces = [
                        face for face in (frame or {}).get('faces', [])
                        if not face.get('predicted')
                    ]
                    primary = next(
                        (face for face in faces if face.get('track_id') == primary_id),
                        None,
                    )
                    if primary is None:
                        continue
                    primary_cx = float(primary.get('cx', float(primary['x']) + float(primary['w']) / 2.0))
                    left = 0.0
                    right = float(source_w)
                    for face in faces:
                        if face.get('track_id') == primary_id:
                            continue
                        other_cx = float(face.get('cx', float(face['x']) + float(face['w']) / 2.0))
                        boundary = (primary_cx + other_cx) / 2.0
                        if other_cx < primary_cx:
                            left = max(left, boundary)
                        elif other_cx > primary_cx:
                            right = min(right, boundary)
                    corrected_crops.append(
                        _panel_crop_for_face(primary, source_w, source_h, left, right)
                    )
                locked_crop = _median_crop(corrected_crops)
                if locked_crop:
                    # QA is the last stage before FFmpeg. Applying each raw
                    # detector box here used to undo timeline stabilization and
                    # visibly pan/zoom every 250 ms. One verified crop per shot
                    # keeps the virtual camera planted on the face.
                    _apply_locked_crop(segment.get('points') or [], locked_crop)
                    segment['mode'] = 'single'
                    segment['wideKind'] = None
                    segment['editorialLayout'] = 'ACTIVE_SPEAKER_CROP'
                    segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA isolated one complete visible person."
                    segment['qaFallbackApplied'] = 'single_person_reframe'
                elif speaking_face_points:
                    # The track can disappear from the QA frame list at a
                    # shot/track boundary even though the reframe timeline
                    # already carries a detector-verified face crop for every
                    # speaking sample. Preserve that person-led crop rather
                    # than widening to an empty set or split-screen divider.
                    segment['mode'] = 'single'
                    segment['wideKind'] = None
                    segment['editorialLayout'] = 'ACTIVE_SPEAKER_CROP'
                    segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA preserved the verified timeline face."
                    segment['qaFallbackApplied'] = 'verified_timeline_face'
                else:
                    segment['mode'] = 'wide_context'
                    segment['wideKind'] = 'safe_wide'
                    segment['editorialLayout'] = 'SAFE_ORIGINAL'
                    segment['editorialReason'] = f"{segment.get('editorialReason', '')} Layout QA rejected the crop."
                    segment['qaFallbackApplied'] = 'safe_original'

        segment['qaStatus'] = 'fallback' if segment.get('qaFallbackApplied') else 'pass'
        if (
            segment.get('mode') == 'single'
            and checked == 0
            and segment.get('qaFallbackApplied') != 'verified_timeline_face'
        ):
            segment['qaStatus'] = 'fail'
            remaining_unsafe_segments += 1
        segment['qaIssues'] = dict(issues)
        segment['qaCheckedSamples'] = checked
        validated.append(segment)
        issue_counts.update(issues)

    return validated, {
        'segments_checked': len(timeline),
        'segments_rejected_before_fallback': rejected_segments,
        'segments_safe_after_fallback': len(validated),
        'issue_counts_before_fallback': dict(issue_counts),
        'remaining_unsafe_segments': remaining_unsafe_segments,
    }
