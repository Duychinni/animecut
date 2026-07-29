#!/usr/bin/env python3
"""Deterministic acceptance tests for universal semantic auto-reframing."""

from reframe_per_clip import (
    build_reframe_timeline,
    detect_fixed_two_panel_layout,
    distinct_face_detections,
    face_is_complete_in_source,
    lock_handheld_source_composition,
    lock_unstable_panel_composition,
    portrait_crop_for_face_in_panel,
    portrait_crop_for_subject,
    semantic_subject_choice,
    stabilize_continuous_conversation_layout,
    strongest_face_pair,
    visual_usability,
)


W, H = 1920.0, 1080.0


def box(x, y, w, h, track_id=None, confidence=0.8):
    value = {
        'x': float(x), 'y': float(y), 'w': float(w), 'h': float(h),
        'cx': float(x + w / 2), 'cy': float(y + h / 2),
        'predicted': False, 'active_speaker_confidence': confidence,
        'mouth_motion': 0.08,
    }
    if track_id is not None:
        value['track_id'] = int(track_id)
    return value


def sample(t, subject=None, faces=None, active_id=None, speaker_conf=0.0,
           speaker_margin=0.0, scene_cut=False, fixed_layout=None, audio_activity=None,
           scene_change=0.0):
    subject = subject or {
        'kind': 'context', 'box': None, 'confidence': 0.0,
        'reason': 'no_reliable_visual_subject', 'predicted': False,
        'stable_id': 'context', 'velocity_x': 0.0,
    }
    frame = {
        't': float(t), 'faces': faces or [], 'active_track_id': active_id,
        'selected_box': subject.get('box') if subject.get('kind') == 'face' else None,
        'semantic_subject': subject, 'scene_cut': scene_cut,
        'speaker_score_margin': float(speaker_margin),
    }
    if fixed_layout is not None:
        frame['fixed_two_panel'] = fixed_layout
    point = {
        't': float(t), 'speaker_confidence': float(speaker_conf),
        'speaker_score_margin': float(speaker_margin),
        'audio_activity': (0.7 if speaker_conf else 0.0) if audio_activity is None else float(audio_activity),
        'fallback_used': bool(subject.get('predicted')),
        'subject_kind': subject.get('kind'),
        'subject_confidence': subject.get('confidence', 0.0),
        'selection_reason': subject.get('reason'),
        'subject_predicted': subject.get('predicted', False),
        'subject_stable_id': subject.get('stable_id', subject.get('kind')),
        'subject_velocity_x': subject.get('velocity_x', 0.0),
        'face_box': subject.get('face_box'),
        'face_source_complete': bool(subject.get('kind') == 'face' and subject.get('face_box')),
        'scene_change': float(scene_change),
    }
    return point, frame


def subject(kind, value, stable_id, confidence=0.8, velocity_x=0.0, predicted=False):
    return {
        'kind': kind, 'box': value, 'face_box': value if kind == 'face' else None,
        'confidence': confidence, 'reason': f'test_{kind}', 'predicted': predicted,
        'stable_id': stable_id, 'velocity_x': velocity_x,
    }


def timeline(samples, duration=None):
    points, frames = zip(*samples)
    return build_reframe_timeline(
        list(points), list(frames), W, H,
        duration if duration is not None else float(points[-1]['t']) + 0.25,
    )


def test_repeated_panel_wide_closeup_switching_locks_one_composition():
    modes = ['single', 'wide_context', 'single', 'stacked', 'wide_context', 'single', 'wide_context', 'single']
    segments = []
    for index, mode in enumerate(modes):
        segments.append({
            'start': float(index),
            'end': float(index + 1),
            'mode': mode,
            'wideKind': 'safe_wide' if mode == 'wide_context' else None,
            'visibleCountMax': 2,
            'points': [{'t': float(index)}],
        })
    result = lock_unstable_panel_composition(segments)
    assert len(result) == 1, result
    assert result[0]['mode'] == 'wide_context', result
    assert result[0]['renderBranch'] == 'stable_panel_composition', result


def test_handheld_action_with_bystanders_does_not_lock_as_panel():
    modes = ['single', 'wide_context', 'single', 'wide_context', 'single', 'wide_context', 'single', 'single']
    segments = []
    for index, mode in enumerate(modes):
        segments.append({
            'start': float(index),
            'end': float(index + 1),
            'mode': mode,
            'wideKind': 'safe_wide' if mode == 'wide_context' else None,
            'visibleCountMax': 2 if index in {1, 3, 5} else 1,
            'editorialSceneType': 'FULL_BODY_ACTION',
            'editorialLayout': 'TRACK_ACTION',
            'points': [{'t': float(index)}],
        })
    result = lock_unstable_panel_composition(segments)
    assert len(result) == len(segments), result
    assert all(
        segment.get('renderBranch') != 'stable_panel_composition'
        for segment in result
    ), result


def test_busy_handheld_action_preserves_operated_source_camera():
    layouts = (
        ['TRACK_ACTION'] * 5
        + ['BROLL_FILL'] * 4
        + ['PRESERVE_SCREEN'] * 3
        + ['ACTIVE_SPEAKER_CROP'] * 3
    )
    segments = []
    for index, layout in enumerate(layouts):
        segments.append({
            'start': float(index),
            'end': float(index + 1),
            'mode': 'single' if index % 3 else 'wide_context',
            'editorialLayout': layout,
            'points': [{'t': float(index), 'cropX': float(index * 80)}],
        })
    result = lock_handheld_source_composition(segments)
    assert len(result) == 1, result
    assert result[0]['mode'] == 'wide_context', result
    assert result[0]['renderBranch'] == 'handheld_source_composition', result
    assert result[0]['points'] == [], result


def test_continuous_conversation_never_opens_wide_then_pulses_close_before_split():
    left = box(120, 130, 520, 760, 1, 0.9)
    right = box(1260, 140, 520, 750, 2, 0.9)
    segments = [
        {
            'start': 0.0, 'end': 6.0, 'mode': 'wide_context',
            'wideKind': 'safe_wide', 'visibleCountMax': 2,
            'points': [{'t': 0.0}],
        },
        {
            'start': 6.0, 'end': 7.5, 'mode': 'single',
            'visibleCountMax': 2, 'points': [{'t': 6.0}],
        },
        {
            'start': 7.5, 'end': 17.5, 'mode': 'stacked',
            'topTrackId': 1, 'bottomTrackId': 2,
            'topBox': left, 'bottomBox': right,
            'visibleCountMax': 2, 'points': [{'t': 7.5}],
        },
        {
            'start': 17.5, 'end': 29.4, 'mode': 'stacked',
            'topTrackId': 1, 'bottomTrackId': 2,
            'topBox': left, 'bottomBox': right,
            'visibleCountMax': 2, 'points': [{'t': 17.5}],
        },
    ]
    result = stabilize_continuous_conversation_layout(
        segments,
        {'recommended_layout': 'TWO_PERSON_CONVERSATION'},
    )
    assert len(result) == 1, result
    assert result[0]['start'] == 0.0 and result[0]['end'] == 29.4, result
    assert result[0]['mode'] == 'stacked', result
    assert result[0].get('topBox') and result[0].get('bottomBox'), result


def test_brief_pair_does_not_force_entire_solo_clip_into_split_screen():
    left = box(120, 130, 520, 760, 1, 0.9)
    right = box(1260, 140, 520, 750, 2, 0.9)
    segments = [
        {'start': 0.0, 'end': 8.0, 'mode': 'single', 'points': [{'t': 0.0}]},
        {
            'start': 8.0, 'end': 10.0, 'mode': 'stacked',
            'topBox': left, 'bottomBox': right, 'points': [{'t': 8.0}],
        },
    ]
    result = stabilize_continuous_conversation_layout(
        segments,
        {'recommended_layout': 'TWO_PERSON_CONVERSATION'},
    )
    assert [segment['mode'] for segment in result] == ['single', 'stacked'], result


def test_handheld_conversation_holds_one_split_through_detector_dropouts():
    left = box(170, 150, 390, 600, 1, 0.9)
    right = box(1260, 145, 410, 610, 2, 0.9)
    segments = [
        {'start': 0.0, 'end': 2.5, 'mode': 'single', 'points': [{'t': 0.0}]},
        {
            'start': 2.5, 'end': 5.5, 'mode': 'stacked',
            'topBox': left, 'bottomBox': right,
            'editorialLayout': 'TWO_PERSON_CONVERSATION',
            'points': [{'t': 2.5}],
        },
        {'start': 5.5, 'end': 7.0, 'mode': 'wide_context', 'points': [{'t': 5.5}]},
        {
            'start': 7.0, 'end': 10.0, 'mode': 'stacked',
            'topBox': box(190, 160, 380, 590, 1, 0.9),
            'bottomBox': box(1240, 155, 420, 600, 2, 0.9),
            'editorialLayout': 'TWO_PERSON_CONVERSATION',
            'points': [{'t': 7.0}],
        },
        {'start': 10.0, 'end': 24.0, 'mode': 'single', 'points': [{'t': 10.0}]},
    ]
    result = stabilize_continuous_conversation_layout(segments)
    assert len(result) == 1, result
    assert result[0]['mode'] == 'stacked', result
    assert result[0]['start'] == 0.0 and result[0]['end'] == 24.0, result
    assert result[0]['topBox'] == left, result
    assert result[0]['bottomBox'] == right, result


def speaker_centering_error(result, expected_centers):
    """Mean normalized distance between the crop center and expected speaker."""
    observed = [point['cropCenterX'] for segment in result for point in segment.get('points', [])]
    assert observed and expected_centers
    count = min(len(observed), len(expected_centers))
    return sum(abs(observed[i] - expected_centers[i]) / W for i in range(count)) / count


def test_overlapping_duplicate_face_detections_do_not_form_a_pair():
    primary = box(610, 90, 720, 900, 10, 0.95)
    duplicate = box(735, 105, 700, 875, 11, 0.82)
    assert strongest_face_pair([primary, duplicate], W) is None
    assert len(distinct_face_detections([primary, duplicate])) == 1


def test_stacked_to_solo_closeup_exits_immediately_and_holds_face_through_gap():
    left = box(160, 160, 360, 560, 1, 0.9)
    right = box(1390, 150, 370, 570, 2, 0.9)
    solo = box(980, 80, 760, 920, 3, 0.95)
    duplicate = box(1110, 95, 700, 890, 4, 0.72)
    hand = box(180, 400, 240, 280)
    samples = [
        sample(
            index * 0.25, subject('face', left, 'face:1', 0.9),
            [left, right], 1, 0.9, 0.5, audio_activity=0.8,
        )
        for index in range(4)
    ]
    samples.append(sample(
        1.0, subject('face', solo, 'face:3', 0.95),
        [solo, duplicate], 3, 0.95, 0.6, audio_activity=0.8,
    ))
    samples.extend([
        sample(
            1.25, subject('action', hand, 'action:hand', 0.48),
            [], None, 0.0, 0.0, audio_activity=0.8,
        ),
        sample(
            1.5, subject('face', solo, 'face:3', 0.95),
            [solo], 3, 0.95, 0.6, audio_activity=0.8,
        ),
    ])
    result = timeline(samples, duration=1.75)
    transition = [
        segment for segment in result
        if segment['end'] > 1.0 and segment['start'] < 1.75
    ]
    assert transition, result
    assert all(segment['mode'] == 'single' for segment in transition), result
    transition_points = [
        point for segment in transition for point in segment['points']
        if point['t'] >= 1.0
    ]
    assert transition_points, result
    assert all(point.get('primaryTrackId') == 3 for point in transition_points), result
    assert len({point['cropX'] for point in transition_points}) == 1, result


def test_solo_to_split_detector_gap_never_renders_searching_frame():
    solo = box(570, 75, 780, 900, 1, 0.95)
    left = box(180, 170, 340, 430, 2, 0.9)
    right = box(1390, 160, 350, 440, 3, 0.9)
    motion = box(900, 400, 180, 180)
    samples = [
        sample(
            index * 0.25, subject('face', solo, 'face:1', 0.94),
            [solo], 1, 0.94, 0.62, audio_activity=0.75,
        )
        for index in range(4)
    ]
    samples.extend([
        sample(
            1.0, subject('action', motion, 'action:searching', 0.4),
            [], None, 0.0, 0.0, audio_activity=0.75,
        ),
        sample(
            1.25, subject('action', motion, 'action:searching', 0.4),
            [], None, 0.0, 0.0, audio_activity=0.75,
        ),
    ])
    samples.extend(
        sample(
            index * 0.25, subject('face', left, 'face:2', 0.9),
            [left, right], 2, 0.9, 0.55, audio_activity=0.75,
        )
        for index in range(6, 9)
    )
    result = timeline(samples, duration=2.25)
    after_transition = [
        segment for segment in result
        if segment['end'] > 1.0 and segment['start'] < 2.25
    ]
    assert after_transition, result
    assert all(segment['mode'] == 'stacked' for segment in after_transition), result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in after_transition), result
    assert all(
        point.get('selectionReason') != 'test_action'
        for segment in after_transition for point in segment['points']
        if point['t'] >= 1.0
    ), result


def test_moderate_frame_spike_does_not_break_unchanged_pair_lock():
    left = box(150, 140, 420, 760, 1, 0.9)
    right = box(1350, 140, 420, 760, 2, 0.9)
    samples = [
        sample(
            index * 0.25, subject('face', left, 'face:1', 0.9),
            [left, right], 1, 0.9, 0.5, audio_activity=0.7,
        )
        for index in range(4)
    ]
    samples.extend(
        sample(
            index * 0.25, subject('face', left, 'face:1', 0.9),
            [left, right], 1, 0.9, 0.5, audio_activity=0.7,
            scene_change=0.44 if index == 4 else 0.0,
        )
        for index in range(4, 8)
    )
    result = timeline(samples, duration=2.0)
    assert len(result) == 1, result
    assert result[0]['mode'] == 'stacked', result
    assert not result[0].get('sceneCutStart'), result


def test_stationary_solo_face_ignores_moderate_motion_spike():
    speaker = box(680, 90, 620, 900, 1, 0.95)
    samples = [
        sample(
            index * 0.25, subject('face', speaker, 'face:1', 0.95),
            [speaker], 1, 0.95, 0.62, audio_activity=0.8,
            scene_change=0.46 if index == 4 else 0.0,
        )
        for index in range(10)
    ]
    result = timeline(samples, duration=2.5)
    face_segments = [segment for segment in result if segment.get('subjectKind') == 'face']
    assert len(face_segments) == 1, result
    crop_positions = {
        (point['cropX'], point['cropY'], point['cropW'], point['cropH'])
        for point in face_segments[0].get('points', [])
    }
    assert len(crop_positions) == 1, result
    assert not any(segment.get('sceneCutStart') for segment in result), result


def test_soft_solo_to_solo_cut_reacquires_incoming_face_atomically():
    outgoing = box(1300, 80, 520, 920, 1, 0.94)
    # Some cuts reuse the detector's track id. Geometry must still be enough
    # to recognize that this is a different shot and release the stale crop.
    incoming = box(190, 85, 560, 910, 1, 0.96)
    samples = [
        sample(
            index * 0.25, subject('face', outgoing, 'face:1', 0.94),
            [outgoing], 1, 0.94, 0.6, audio_activity=0.8,
        )
        for index in range(4)
    ]
    samples.extend(
        sample(
            index * 0.25, subject('face', incoming, 'face:1', 0.96),
            [incoming], 1, 0.96, 0.64, audio_activity=0.8,
            scene_change=0.18 if index == 4 else 0.0,
        )
        for index in range(4, 9)
    )
    result = timeline(samples, duration=2.25)
    incoming_segments = [
        segment for segment in result
        if segment.get('sceneCutStart') and segment['end'] > 1.0
    ]
    assert incoming_segments, result
    incoming_points = [
        point for segment in result for point in segment.get('points', [])
        if point['t'] >= 1.0
    ]
    assert incoming_points, result
    assert all(point.get('primaryTrackId') == 1 for point in incoming_points), result
    assert all(point.get('cropCenterX') < W / 2 for point in incoming_points), result


def test_silent_far_left():
    crop = portrait_crop_for_subject((40, 130, 420, 850), W, H, 'body')
    assert crop['cx'] < W * 0.32, crop


def test_single_layout_without_verified_person_is_rejected_during_speech():
    points = [
        {
            't': index * 0.25,
            'audio_activity': 0.7,
            'subject_kind': 'context',
            'face_box': None,
            'face_source_complete': False,
        }
        for index in range(5)
    ]
    layout = [{
        'start': 0.0,
        'end': 1.25,
        'mode': 'single',
        'points': [{'t': point['t'], 'cropH': H} for point in points],
    }]
    usable, reason = visual_usability(points, layout)
    assert not usable
    assert reason == 'unframed_speaking_subject_at_open'


def test_complete_face_single_layout_remains_usable_during_speech():
    visible = box(760, 120, 360, 500, 1, 0.9)
    points = [
        {
            't': index * 0.25,
            'audio_activity': 0.7,
            'subject_kind': 'face',
            'face_box': visible,
            'face_source_complete': True,
        }
        for index in range(5)
    ]
    layout = [{
        'start': 0.0,
        'end': 1.25,
        'mode': 'single',
        'points': [{'t': point['t'], 'cropH': 800.0} for point in points],
    }]
    usable, reason = visual_usability(points, layout)
    assert usable, reason


def test_silent_far_right():
    crop = portrait_crop_for_subject((1460, 130, 420, 850), W, H, 'body')
    assert crop['cx'] > W * 0.68, crop


def test_small_speaking_face_gets_intentional_close_portrait():
    tiny_face = box(860, 210, 90, 90, 1, 0.94)
    crop = portrait_crop_for_subject(
        (tiny_face['x'], tiny_face['y'], tiny_face['w'], tiny_face['h']),
        W,
        H,
        'face',
        (tiny_face['x'], tiny_face['y'], tiny_face['w'], tiny_face['h']),
    )
    assert crop['h'] < H, crop
    assert crop['h'] >= H * 0.38, crop
    assert tiny_face['h'] / crop['h'] >= 0.18, crop
    assert abs(crop['w'] / crop['h'] - 9.0 / 16.0) < 0.001, crop


def test_small_panel_face_is_zoomed_instead_of_rejected():
    small_face = box(1330, 260, 150, 150, 2, 0.9)
    crop = portrait_crop_for_face_in_panel(
        (small_face['x'], small_face['y'], small_face['w'], small_face['h']),
        W,
        H,
        980,
        1920,
    )
    assert crop['h'] < H, crop
    assert small_face['h'] / crop['h'] >= 0.22, crop
    assert crop['x'] >= 980, crop
    assert crop['x'] + crop['w'] <= 1920, crop


def test_walking_left_to_right_smoothly():
    samples = []
    for index, x in enumerate((80, 200, 360, 540, 740, 940, 1140, 1320)):
        samples.append(sample(index * 0.5, subject('body', box(x, 130, 360, 820), 'body:walker', velocity_x=240)))
    result = timeline(samples)
    centers = [point['cropCenterX'] for point in result[0]['points']]
    assert centers == sorted(centers), centers
    assert max(b - a for a, b in zip(centers, centers[1:])) < W * 0.18, centers


def test_stationary_subject_jitter_does_not_pan_camera():
    samples = []
    for index, x in enumerate((700, 716, 688, 710, 692, 718, 696, 708, 690, 712)):
        samples.append(sample(index * 0.25, subject('body', box(x, 130, 360, 820), 'body:still')))
    result = timeline(samples)
    centers = [point['cropCenterX'] for point in result[0]['points']]
    assert max(centers) - min(centers) < W * 0.015, centers


def test_gentle_head_sway_keeps_camera_planted():
    samples = []
    for index, x in enumerate((700, 732, 758, 740, 704, 674, 692, 728, 754, 718, 686, 706)):
        samples.append(sample(index * 0.25, subject('body', box(x, 130, 360, 820), 'body:still')))
    result = timeline(samples)
    centers = [point['cropCenterX'] for point in result[0]['points']]
    assert max(centers) - min(centers) < W * 0.02, centers


def test_moderate_seated_movement_does_not_trigger_camera_corrections():
    samples = []
    positions = (700, 760, 812, 770, 716, 658, 704, 780, 820, 748, 680, 720)
    for index, x in enumerate(positions):
        samples.append(sample(index * 0.25, subject('body', box(x, 130, 360, 820), 'body:seated')))
    result = timeline(samples)
    centers = [point['cropCenterX'] for point in result[0]['points']]
    assert max(centers) - min(centers) < W * 0.025, centers


def test_motion_box_breathing_does_not_pulse_camera_zoom():
    samples = []
    sizes = ((360, 820), (390, 850), (340, 790), (405, 870), (350, 805), (380, 840))
    for index, (width, height) in enumerate(sizes):
        samples.append(sample(index * 0.25, subject('body', box(700, 130, width, height), 'body:still')))
    result = timeline(samples)
    points = result[0]['points']
    assert len({point['cropW'] for point in points}) == 1, points
    assert len({point['cropH'] for point in points}) == 1, points
    assert len({point['zoom'] for point in points}) == 1, points


def test_detected_face_keeps_camera_fully_locked():
    samples = []
    positions = (620, 700, 770, 820, 740, 660, 590, 680, 760, 810)
    for index, x in enumerate(positions):
        samples.append(sample(index * 0.25, subject('face', box(x, 150, 300, 360), 'face:locked')))
    result = timeline(samples)
    points = result[0]['points']
    assert len({point['cropCenterX'] for point in points}) == 1, points
    assert len({point['cropCenterY'] for point in points}) == 1, points
    assert len({point['cropW'] for point in points}) == 1, points
    assert len({point['cropH'] for point in points}) == 1, points


def test_face_lock_ignores_hand_motion_during_detection_gap():
    face = box(690, 150, 300, 360)
    waving_hand = box(120, 260, 420, 520)
    established = semantic_subject_choice(
        face_box=face,
        motion_box=waving_hand,
        speaker_confidence=0.72,
    )
    held = semantic_subject_choice(
        body_box=box(520, 90, 720, 900),
        motion_box=waving_hand,
        saliency_box=waving_hand,
        saliency_confidence=0.70,
        prior=established,
        scene_cut=False,
    )
    assert held['kind'] == 'face', held
    assert held['box'] == face, held
    assert held['reason'] == 'face_lock_detection_gap', held
    assert held['predicted'] is True, held


def test_scene_cut_releases_face_lock_before_motion_fallback():
    face = box(690, 150, 300, 360)
    incoming_body = box(180, 90, 720, 900)
    established = semantic_subject_choice(face_box=face, speaker_confidence=0.72)
    selected = semantic_subject_choice(
        body_box=incoming_body,
        motion_box=box(120, 260, 420, 520),
        prior=established,
        scene_cut=True,
    )
    assert selected['kind'] == 'body', selected
    assert selected['box'] == incoming_body, selected
    assert selected['predicted'] is False, selected


def test_body_tracking_waits_for_sustained_meaningful_displacement():
    positions = (640, 750, 820, 730, 610, 790, 830, 670, 620, 810, 700, 760)
    samples = [
        sample(index * 0.25, subject('body', box(x, 130, 360, 820), 'body:seated'))
        for index, x in enumerate(positions)
    ]
    result = timeline(samples)
    centers = [point['cropCenterX'] for point in result[0]['points']]
    assert len(set(centers)) == 1, centers


def test_short_detection_loss_holds_subject():
    prior = semantic_subject_choice(body_box=(240, 120, 420, 840))
    held = semantic_subject_choice(prior=prior, scene_cut=False)
    assert held['predicted'] and held['box'] == prior['box'], held


def test_scene_cut_resets_and_hard_cuts():
    samples = []
    for index in range(5):
        samples.append(sample(index * 0.25, subject('body', box(80, 120, 380, 840), 'body:left')))
    for index in range(5, 10):
        samples.append(sample(index * 0.25, subject('body', box(1450, 120, 380, 840), 'body:right'), scene_cut=index == 5))
    result = timeline(samples)
    assert len(result) >= 2 and result[1]['sceneCutStart'], result
    assert result[0]['points'][-1]['cropCenterX'] < W / 2
    assert result[1]['points'][0]['cropCenterX'] > W / 2


def test_alternating_speakers_cut_identity():
    left = box(120, 130, 380, 780, 1, 0.9)
    right = box(1420, 130, 380, 780, 2, 0.9)
    samples = []
    for index in range(16):
        active = 1 if index < 8 else 2
        value = left if active == 1 else right
        samples.append(sample(
            index * 0.25,
            subject('face', value, f'face:{active}', 0.9),
            [left, right], active, 0.9,
        ))
    result = timeline(samples)
    assert len(result) == 1, result
    assert result[0]['mode'] == 'stacked', result
    assert {
        point['primaryTrackId']
        for point in result[0]['points']
    } >= {1, 2}, result
    expected = [left['cx']] * 8 + [right['cx']] * 8
    assert speaker_centering_error(result, expected) < 0.12, result


def test_difficult_asymmetric_podcast_centering_accuracy():
    host = box(40, 115, 310, 760, 1, 0.92)
    guest = box(1510, 175, 240, 620, 2, 0.90)
    samples = []
    expected = []
    for index in range(24):
        active = 1 if index < 7 or 15 <= index < 20 else 2
        active_box = host if active == 1 else guest
        samples.append(sample(index * 0.25, subject('face', active_box, f'face:{active}', 0.9), [host, guest], active, 0.9, 0.5))
        expected.append(active_box['cx'])
    result = timeline(samples)
    assert speaker_centering_error(result, expected) < 0.14, result


def test_reaction_face_does_not_steal_active_speaker():
    speaker = box(180, 130, 340, 760, 1, 0.94)
    large_reactor = box(1160, 60, 650, 940, 2, 0.18)
    samples = [
        sample(i * 0.25, subject('face', speaker, 'face:1', 0.94), [speaker, large_reactor], 1, 0.94, 0.62)
        for i in range(16)
    ]
    result = timeline(samples)
    assert speaker_centering_error(result, [speaker['cx']] * 16) < 0.12, result


def test_sustained_two_person_exchange_uses_locked_top_bottom_layout():
    left = box(120, 130, 380, 780, 1, 0.92)
    right = box(1420, 130, 380, 780, 2, 0.92)
    samples = []
    for index in range(32):
        active = 1 if (index // 4) % 2 == 0 else 2
        active_box = left if active == 1 else right
        samples.append(sample(
            index * 0.25,
            subject('face', active_box, f'face:{active}', 0.92),
            [left, right], active, 0.92, 0.55,
        ))
    result = timeline(samples)
    assert result, result
    stacked = [segment for segment in result if segment['mode'] == 'stacked']
    assert stacked, result
    assert all(segment.get('renderBranch') == 'two_person_stacked' for segment in stacked), stacked
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in stacked), stacked


def test_stable_wide_speaker_and_listener_use_top_bottom_layout():
    speaker = box(120, 130, 380, 780, 1, 0.94)
    listener = box(1420, 130, 380, 780, 2, 0.18)
    samples = [
        sample(
            index * 0.25,
            subject('face', speaker, 'face:1', 0.94),
            [speaker, listener], 1, 0.94, 0.62,
        )
        for index in range(32)
    ]
    result = timeline(samples)
    stacked = [segment for segment in result if segment['mode'] == 'stacked']
    assert stacked, result
    assert all(segment.get('topTrackId') == 1 for segment in stacked), stacked
    assert all(segment.get('bottomTrackId') == 2 for segment in stacked), stacked
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in stacked), stacked


def test_unframed_speech_holds_one_complete_visible_person():
    visible_person = box(1280, 130, 390, 780, 7, 0.28)
    samples = [
        sample(
            index * 0.25,
            faces=[visible_person],
            active_id=None,
            speaker_conf=0.0,
            audio_activity=0.7,
        )
        for index in range(12)
    ]
    result = timeline(samples)
    assert result
    assert all(segment['mode'] == 'single' for segment in result), result
    assert all(segment.get('subjectStableId') == 'face:7' for segment in result), result
    assert speaker_centering_error(result, [visible_person['cx']] * 12) < 0.12, result


def test_source_edge_half_face_is_not_complete():
    half_face = box(0, 160, 210, 560, 1, 0.95)
    complete_face = box(1320, 150, 330, 700, 2, 0.55)
    assert not face_is_complete_in_source(
        (half_face['x'], half_face['y'], half_face['w'], half_face['h']), W, H
    )
    assert face_is_complete_in_source(
        (complete_face['x'], complete_face['y'], complete_face['w'], complete_face['h']), W, H
    )


def test_half_face_active_target_moves_to_complete_person():
    half_face = box(0, 160, 210, 560, 1, 0.96)
    complete_face = box(1320, 150, 330, 700, 2, 0.42)
    samples = [
        sample(
            index * 0.25,
            subject('face', half_face, 'face:1', 0.96),
            [half_face, complete_face],
            1,
            0.96,
            0.6,
        )
        for index in range(10)
    ]
    result = timeline(samples)
    singles = [segment for segment in result if segment['mode'] == 'single']
    assert singles, result
    assert all(segment.get('subjectStableId') == 'face:2' for segment in singles), result
    assert all(
        point['cropCenterX'] > W * 0.60
        for segment in singles
        for point in segment['points']
    ), result


def test_only_half_faces_fail_closed_to_context():
    left_half = box(0, 150, 210, 620, 1, 0.92)
    right_half = box(1740, 150, 180, 620, 2, 0.88)
    samples = [
        sample(
            index * 0.25,
            subject('face', left_half, 'face:1', 0.92),
            [left_half, right_half],
            1,
            0.92,
            0.5,
        )
        for index in range(10)
    ]
    result = timeline(samples)
    assert all(segment['mode'] == 'wide_context' for segment in result), result
    assert all(segment.get('selectionReason') == 'only_partial_faces_visible' for segment in result), result


def test_speaking_reel_cannot_open_on_empty_safe_wide():
    points = [
        {'t': index * 0.25, 'audio_activity': 0.65}
        for index in range(6)
    ]
    timeline_result = [{
        'start': 0.0, 'end': 1.5, 'mode': 'wide_context', 'wideKind': 'safe_wide',
    }]
    usable, reason = visual_usability(points, timeline_result)
    assert not usable
    assert reason == 'unframed_speaking_subject_at_open'


def test_speaking_reel_rejects_mid_clip_empty_stage_fallback():
    points = [
        {
            't': index * 0.25,
            'audio_activity': 0.75,
            'subject_kind': 'context' if 2.0 <= index * 0.25 <= 2.75 else 'face',
            'face_box': None if 2.0 <= index * 0.25 <= 2.75 else box(760, 120, 360, 500, 1, 0.9),
            'face_source_complete': not (2.0 <= index * 0.25 <= 2.75),
        }
        for index in range(24)
    ]
    timeline_result = [
        {'start': 0.0, 'end': 2.0, 'mode': 'single', 'points': []},
        {'start': 2.0, 'end': 2.75, 'mode': 'wide_context', 'wideKind': 'safe_wide'},
        {'start': 2.75, 'end': 6.0, 'mode': 'single', 'points': []},
    ]
    usable, reason = visual_usability(points, timeline_result)
    assert not usable
    assert reason == 'sustained_unframed_speaking_subject'


def test_one_confirmed_exchange_keeps_both_people_in_locked_panes():
    left = box(130, 140, 360, 740, 1, 0.92)
    right = box(1430, 140, 360, 740, 2, 0.92)
    samples = []
    # Establish the first speaker, then let the other person answer.
    for index in range(8):
        active_id = 1 if index < 4 else 2
        active_box = left if active_id == 1 else right
        samples.append(sample(
            index * 0.25,
            subject('face', active_box, f'face:{active_id}', 0.92),
            [left, right], active_id, 0.92, 0.55, audio_activity=0.75,
        ))
    # A sustained monologue must not discard the other person while the source
    # remains a stable wide two-person composition.
    for index in range(8, 28):
        samples.append(sample(
            index * 0.25,
            subject('face', right, 'face:2', 0.92),
            [left, right], 2, 0.92, 0.55, audio_activity=0.75,
        ))
    result = timeline(samples, duration=7.0)
    assert all(segment['mode'] == 'stacked' for segment in result), result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in result), result
    assert result[-1]['points'][-1]['primaryTrackId'] == 2, result


def test_deliberate_silent_wide_context_remains_allowed():
    points = [
        {'t': index * 0.25, 'audio_activity': 0.0}
        for index in range(10)
    ]
    timeline_result = [{
        'start': 0.0, 'end': 2.5, 'mode': 'wide_context', 'wideKind': 'safe_wide',
    }]
    usable, reason = visual_usability(points, timeline_result)
    assert usable
    assert reason is None


def fixed_two_region_fixture():
    left = box(180, 145, 350, 720, 1, 0.92)
    right = box(1380, 145, 350, 720, 2, 0.92)
    detector_frames = [
        {'timestamp': index * 0.25, 'faces': [left, right]}
        for index in range(16)
    ]
    fixed = detect_fixed_two_panel_layout(detector_frames, W, H)
    assert fixed and fixed['mode'] == 'FIXED_TWO_REGION_CONVERSATION', fixed
    assert fixed['track_region_map'] == {'1': 'left', '2': 'right'}, fixed
    return left, right, fixed


def test_small_webcams_with_stable_divider_are_locked_as_streamer_layout():
    left = box(250, 120, 210, 92, 1, 0.88)
    right = box(1450, 118, 210, 94, 2, 0.88)
    detector_frames = [
        {
            'timestamp': index * 0.25,
            'faces': [left, right] if index not in (5, 6) else [],
            'divider_x': W / 2,
            'divider_confidence': 3.2,
        }
        for index in range(24)
    ]
    fixed = detect_fixed_two_panel_layout(detector_frames, W, H)
    assert fixed and fixed['mode'] == 'FIXED_TWO_REGION_CONVERSATION', fixed
    assert fixed['detection_method'] == 'divider', fixed
    assert fixed['panel_face_height_ratio'] == 0.075, fixed
    assert fixed['track_region_map'] == {'1': 'left', '2': 'right'}, fixed

    samples = []
    for index in range(24):
        active_id = 1 if (index // 3) % 2 == 0 else 2
        active_box = left if active_id == 1 else right
        faces = [] if index in (5, 6) else [left, right]
        samples.append(sample(
            index * 0.25,
            subject('face', active_box, f'face:{active_id}', 0.90),
            faces,
            active_id if faces else None,
            0.90 if faces else 0.0,
            0.55 if faces else 0.0,
            fixed_layout=fixed,
            audio_activity=0.75,
        ))
    result = timeline(samples, duration=6.0)
    assert len(result) == 1, result
    assert result[0]['mode'] == 'stacked', result
    assert result[0]['renderBranch'] == 'fixed_two_panel_stacked', result
    assert result[0].get('topBox') and result[0].get('bottomBox'), result


def test_fixed_two_region_right_speaker_never_uses_midpoint():
    left, right, fixed = fixed_two_region_fixture()
    samples = [
        sample(
            index * 0.25,
            subject('face', right, 'face:2', 0.92),
            [left, right], 2, 0.92, 0.55, fixed_layout=fixed,
        )
        for index in range(12)
    ]
    result = timeline(samples)
    assert all(segment['mode'] == 'stacked' for segment in result), result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in result), result


def test_fixed_two_region_holds_person_through_detector_gap():
    left, right, fixed = fixed_two_region_fixture()
    samples = []
    for index in range(20):
        if 4 <= index < 14:
            samples.append(sample(
                index * 0.25,
                faces=[],
                active_id=None,
                speaker_conf=0.0,
                audio_activity=0.75,
                fixed_layout=fixed,
            ))
        else:
            samples.append(sample(
                index * 0.25,
                subject('face', right, 'face:2', 0.92),
                [left, right],
                2,
                0.92,
                0.55,
                fixed_layout=fixed,
                audio_activity=0.75,
            ))
    points, frames = zip(*samples)
    result = build_reframe_timeline(list(points), list(frames), W, H, 5.0)
    usable, reason = visual_usability(list(points), result)
    assert usable, reason
    assert result[0]['mode'] == 'stacked', result
    assert result[0].get('topBox') and result[0].get('bottomBox'), result


def test_fixed_two_region_confirmed_switch_is_a_hard_panel_cut():
    left, right, fixed = fixed_two_region_fixture()
    samples = []
    for index in range(12):
        active_id = 1 if index < 6 else 2
        active_box = left if active_id == 1 else right
        samples.append(sample(
            index * 0.25,
            subject('face', active_box, f'face:{active_id}', 0.94),
            [left, right], active_id, 0.94, 0.62, fixed_layout=fixed,
        ))
    result = timeline(samples)
    assert all(segment['mode'] == 'stacked' for segment in result), result
    assert all(segment['renderBranch'] == 'fixed_two_panel_stacked' for segment in result), result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in result), result


def test_fixed_two_region_exits_stack_immediately_for_solo_closeup():
    left, right, fixed = fixed_two_region_fixture()
    closeup = box(570, 75, 780, 900, 3, 0.95)
    samples = [
        sample(
            index * 0.25,
            subject('face', left, 'face:1', 0.92),
            [left, right], 1, 0.92, 0.55, fixed_layout=fixed,
            audio_activity=0.75,
        )
        for index in range(8)
    ]
    samples.extend(
        sample(
            index * 0.25,
            subject('face', closeup, 'face:3', 0.95),
            [closeup], 3, 0.95, 0.62, fixed_layout=fixed,
            audio_activity=0.75,
            # Deliberately below the hard 0.72 scene-cut threshold.
            scene_change=0.46 if index == 8 else 0.0,
        )
        for index in range(8, 16)
    )
    result = timeline(samples, duration=4.0)
    incoming = [segment for segment in result if segment['start'] >= 2.0 - 0.001]
    assert incoming, result
    assert all(segment['mode'] == 'single' for segment in incoming), result
    assert all(segment.get('primaryTrackId') == 3 for segment in incoming), result
    assert all(not segment.get('sourceLayout') for segment in incoming), result


def test_general_two_person_stack_exits_on_first_soft_cut_sample():
    left = box(180, 170, 340, 430, 1, 0.9)
    right = box(1390, 160, 350, 440, 2, 0.9)
    closeup = box(570, 75, 780, 900, 3, 0.95)
    samples = [
        sample(
            index * 0.25,
            subject('face', left, 'face:1', 0.92),
            [left, right], 1, 0.92, 0.55,
            audio_activity=0.75,
        )
        for index in range(8)
    ]
    samples.extend(
        sample(
            index * 0.25,
            subject('face', closeup, 'face:3', 0.95),
            [closeup], 3, 0.95, 0.62,
            audio_activity=0.75,
            scene_change=0.46 if index == 8 else 0.0,
        )
        for index in range(8, 16)
    )
    result = timeline(samples, duration=4.0)
    incoming = [segment for segment in result if segment['start'] >= 2.0 - 0.001]
    assert incoming, result
    assert incoming[0]['start'] == 2.0, result
    assert all(segment['mode'] == 'single' for segment in incoming), result
    assert all(segment.get('primaryTrackId') == 3 for segment in incoming), result


def test_fixed_two_region_soft_cut_uses_incoming_face_from_first_cut_sample():
    left, right, fixed = fixed_two_region_fixture()
    motion = box(1410, 330, 260, 260)
    closeup = box(570, 75, 780, 900, 3, 0.95)
    samples = [
        sample(
            index * 0.25,
            subject('face', right, 'face:2', 0.92),
            [left, right], 2, 0.92, 0.55, fixed_layout=fixed,
            audio_activity=0.75,
        )
        for index in range(8)
    ]
    samples.extend(
        sample(
            index * 0.25,
            subject('action', motion, 'action:set-light', 0.48),
            [], None, 0.0, 0.0, fixed_layout=fixed,
            audio_activity=0.75,
            scene_change=0.44 if index == 8 else 0.0,
        )
        for index in range(8, 12)
    )
    samples.extend(
        sample(
            index * 0.25,
            subject('face', closeup, 'face:3', 0.95),
            [closeup], 3, 0.95, 0.62, fixed_layout=fixed,
            audio_activity=0.75,
        )
        for index in range(12, 16)
    )
    result = timeline(samples, duration=4.0)
    incoming = [
        segment for segment in result
        if segment['start'] < 3.0 and segment['end'] > 2.0
    ]
    assert incoming, result
    assert all(segment['mode'] == 'single' for segment in incoming), result
    assert all(segment.get('primaryTrackId') == 3 for segment in incoming), result
    assert all(segment.get('renderBranch') != 'safe_full_frame' for segment in incoming), result
    incoming_points = [
        point for segment in incoming for point in segment.get('points', [])
        if point['t'] >= 2.0
    ]
    assert incoming_points and incoming_points[0]['t'] == 2.0, result
    assert all(point.get('primaryTrackId') == 3 for point in incoming_points), result


def test_solo_to_split_cut_uses_confirmed_pair_from_first_cut_sample():
    solo = box(570, 75, 780, 900, 1, 0.95)
    left = box(180, 170, 340, 430, 2, 0.9)
    right = box(1390, 160, 350, 440, 3, 0.9)
    motion = box(900, 400, 180, 180)
    samples = [
        sample(
            index * 0.25,
            subject('face', solo, 'face:1', 0.94),
            [solo], 1, 0.94, 0.62, audio_activity=0.75,
        )
        for index in range(8)
    ]
    samples.extend(
        sample(
            index * 0.25,
            subject('action', motion, 'action:transition', 0.4),
            [], None, 0.0, 0.0, audio_activity=0.75,
            scene_change=0.45 if index == 8 else 0.0,
        )
        for index in range(8, 10)
    )
    samples.extend(
        sample(
            index * 0.25,
            subject('face', left, 'face:2', 0.9),
            [left, right], 2, 0.9, 0.55, audio_activity=0.75,
        )
        for index in range(10, 16)
    )
    result = timeline(samples, duration=4.0)
    incoming = [segment for segment in result if segment['start'] >= 2.0 - 0.001]
    assert incoming, result
    assert incoming[0]['start'] == 2.0, result
    assert all(segment['mode'] == 'stacked' for segment in incoming), result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in incoming), result


def test_atomic_transition_never_emits_partial_pair_or_search_frame():
    solo = box(570, 75, 780, 900, 1, 0.95)
    left = box(180, 170, 340, 430, 2, 0.9)
    right = box(1390, 160, 350, 440, 3, 0.9)
    partial = box(1510, 240, 260, 460, 90, 0.34)
    samples = [
        sample(
            index * 0.125,
            subject('face', solo, 'face:1', 0.95),
            [solo], 1, 0.95, 0.62, audio_activity=0.75,
        )
        for index in range(16)
    ]
    samples.extend([
        sample(
            2.0, subject('face', partial, 'face:90', 0.34),
            [partial], 90, 0.34, 0.04, audio_activity=0.75,
            scene_change=0.48,
        ),
        sample(
            2.125, subject('face', left, 'face:2', 0.9),
            [left], 2, 0.9, 0.40, audio_activity=0.75,
        ),
    ])
    samples.extend(
        sample(
            index * 0.125,
            subject('face', left, 'face:2', 0.9),
            [left, right], 2, 0.9, 0.55, audio_activity=0.75,
        )
        for index in range(18, 32)
    )
    result = timeline(samples, duration=4.0)
    incoming = [segment for segment in result if segment['end'] > 2.0]
    assert incoming, result
    assert all(segment['mode'] == 'stacked' for segment in incoming), result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in incoming), result
    assert all(
        segment.get('renderBranch') not in ('safe_full_frame', 'single_subject_uncertain')
        for segment in incoming
    ), result
    incoming_points = [
        point for segment in incoming for point in segment.get('points', [])
        if point['t'] >= 2.0
    ]
    assert incoming_points and incoming_points[0]['t'] == 2.0, result
    assert all(point.get('primaryTrackId') in (2, 3) for point in incoming_points), result


def test_cut_sample_false_face_is_replaced_by_stable_incoming_face():
    left = box(180, 170, 340, 430, 1, 0.9)
    right = box(1390, 160, 350, 440, 2, 0.9)
    false_hand = box(1540, 360, 210, 260, 90, 0.35)
    solo = box(570, 75, 780, 900, 3, 0.95)
    samples = [
        sample(
            index * 0.25, subject('face', left, 'face:1', 0.9),
            [left, right], 1, 0.9, 0.5, audio_activity=0.75,
        )
        for index in range(8)
    ]
    samples.append(sample(
        2.0, subject('face', false_hand, 'face:90', 0.35),
        [false_hand], 90, 0.35, 0.05, audio_activity=0.75,
        scene_change=0.48,
    ))
    samples.append(sample(
        2.25, subject('face', false_hand, 'face:90', 0.30),
        [false_hand], 90, 0.30, 0.03, audio_activity=0.75,
    ))
    samples.extend(
        sample(
            index * 0.25, subject('face', solo, 'face:3', 0.95),
            [solo], 3, 0.95, 0.62, audio_activity=0.75,
        )
        for index in range(10, 16)
    )
    result = timeline(samples, duration=4.0)
    incoming = [segment for segment in result if segment['end'] > 2.0]
    points = [
        point for segment in incoming for point in segment.get('points', [])
        if point['t'] >= 2.0
    ]
    assert points and points[0]['t'] == 2.0, result
    assert all(point.get('primaryTrackId') == 3 for point in points), result
    assert all(point.get('cropCenterX') < 1400 for point in points), result


def test_duplicate_pair_flash_is_backfilled_to_actual_soft_cut():
    left = box(180, 170, 340, 430, 1, 0.9)
    right = box(1390, 160, 350, 440, 2, 0.9)
    # A close-up is briefly misread as two separate face fragments. This is
    # the exact bad frame: outgoing stacked geometry applied after the source
    # has already cut to one person.
    fragment_left = box(120, 90, 330, 760, 40, 0.42)
    fragment_right = box(1130, 80, 350, 780, 41, 0.41)
    solo = box(560, 70, 790, 910, 3, 0.95)
    samples = [
        sample(
            index * 0.25, subject('face', left, 'face:1', 0.9),
            [left, right], 1, 0.9, 0.5, audio_activity=0.75,
        )
        for index in range(8)
    ]
    samples.extend([
        sample(
            2.0, subject('face', fragment_right, 'face:41', 0.42),
            [fragment_left, fragment_right], 41, 0.42, 0.04,
            audio_activity=0.75, scene_change=0.22,
        ),
        sample(
            2.25, subject('face', fragment_right, 'face:41', 0.41),
            [fragment_left, fragment_right], 41, 0.41, 0.03,
            audio_activity=0.75,
        ),
    ])
    samples.extend(
        sample(
            index * 0.25, subject('face', solo, 'face:3', 0.95),
            [solo], 3, 0.95, 0.62, audio_activity=0.75,
        )
        for index in range(10, 16)
    )
    result = timeline(samples, duration=4.0)
    incoming = [
        segment for segment in result
        if segment['start'] < 2.5 and segment['end'] > 2.0
    ]
    assert incoming, result
    assert all(segment['mode'] == 'single' for segment in incoming), result
    incoming_points = [
        point for segment in incoming for point in segment.get('points', [])
        if point['t'] >= 2.0
    ]
    assert incoming_points and incoming_points[0]['t'] == 2.0, result
    assert all(point.get('primaryTrackId') == 3 for point in incoming_points), result


def test_same_face_track_fragment_does_not_create_camera_jump():
    first = box(570, 75, 780, 900, 7, 0.95)
    fragmented = box(610, 85, 760, 890, 17, 0.92)
    samples = [
        sample(
            index * 0.25, subject('face', first, 'face:7', 0.95),
            [first], 7, 0.95, 0.62, audio_activity=0.75,
        )
        for index in range(8)
    ]
    samples.extend(
        sample(
            index * 0.25, subject('face', fragmented, 'face:17', 0.92),
            [fragmented], 17, 0.92, 0.55, audio_activity=0.75,
        )
        for index in range(8, 16)
    )
    result = timeline(samples, duration=4.0)
    single_segments = [segment for segment in result if segment['mode'] == 'single']
    assert len(single_segments) == 1, result
    crops = {
        (point['cropX'], point['cropY'], point['cropW'], point['cropH'])
        for point in single_segments[0]['points']
    }
    assert len(crops) == 1, result


def test_real_timeline_points_emit_detected_face_box():
    face = box(570, 75, 780, 900, 3, 0.95)
    result = timeline([
        sample(
            index * 0.25,
            subject('face', face, 'face:3', 0.95),
            [face], 3, 0.95, 0.62, audio_activity=0.75,
        )
        for index in range(8)
    ])
    points = [point for segment in result for point in segment.get('points', [])]
    assert points, result
    assert all(point.get('face_box') for point in points), result
    assert all(point['face_box']['w'] == face['w'] for point in points), result


def test_uncertain_fixed_two_person_speech_keeps_both_locked_panes():
    left, right, fixed = fixed_two_region_fixture()
    samples = [
        sample(
            index * 0.25,
            subject('face', left, 'face:1', 0.45),
            [left, right], 1, 0.12, 0.01, fixed_layout=fixed, audio_activity=0.6,
        )
        for index in range(10)
    ]
    result = timeline(samples)
    assert all(segment['mode'] == 'stacked' for segment in result), result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in result), result


def test_fixed_two_region_long_silence_keeps_locked_stack():
    left, right, fixed = fixed_two_region_fixture()
    samples = []
    for index in range(5):
        samples.append(sample(
            index * 0.25, subject('face', left, 'face:1', 0.94),
            [left, right], 1, 0.94, 0.62, fixed_layout=fixed,
        ))
    for index in range(5, 19):
        samples.append(sample(
            index * 0.25, subject('face', left, 'face:1', 0.20),
            [left, right], 1, 0.20, 0.01, fixed_layout=fixed, audio_activity=0.0,
        ))
    result = timeline(samples)
    assert all(segment['mode'] == 'stacked' for segment in result), result
    assert all(segment.get('renderBranch') == 'fixed_two_panel_stacked' for segment in result), result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in result), result


def test_single_closeup_long_silence_never_flashes_safe_wide():
    first = box(420, 90, 560, 900, 1, 0.95)
    second = box(1180, 90, 560, 900, 2, 0.95)
    samples = []
    for index in range(9):
        samples.append(sample(
            index * 0.25,
            subject('face', first, 'face:1', 0.62),
            [first], 1, 0.62, 0.40,
            audio_activity=0.0,
        ))
    for index in range(9, 15):
        samples.append(sample(
            index * 0.25,
            subject('face', second, 'face:2', 0.62),
            [second], 2, 0.62, 0.40,
            scene_cut=index == 9,
            audio_activity=0.0 if index < 12 else 0.8,
        ))
    result = timeline(samples, duration=3.75)
    assert all(segment['mode'] == 'single' for segment in result), result
    assert not any(
        segment.get('renderBranch', '').endswith('safe_full_frame')
        for segment in result
    ), result


def test_two_person_uncertain_context_uses_both_locked_panes():
    left = box(110, 150, 360, 720, 1, 0.22)
    right = box(1450, 150, 360, 720, 2, 0.18)
    samples = [
        sample(
            index * 0.25,
            subject('context', None, 'context', 0.0),
            [left, right],
            None,
            0.0,
            0.0,
            audio_activity=0.55,
        )
        for index in range(12)
    ]
    result = timeline(samples)
    stacked = [segment for segment in result if segment['mode'] == 'stacked']
    assert stacked, result
    assert all(segment.get('topBox') and segment.get('bottomBox') for segment in stacked), result


def test_long_silence_resume_keeps_stack_and_marks_speaker_change():
    left, right, fixed = fixed_two_region_fixture()
    samples = []
    for index in range(5):
        samples.append(sample(index * 0.25, subject('face', left, 'face:1', 0.94), [left, right], 1, 0.94, 0.62, fixed_layout=fixed))
    for index in range(5, 16):
        samples.append(sample(index * 0.25, subject('face', left, 'face:1', 0.18), [left, right], 1, 0.18, 0.01, fixed_layout=fixed, audio_activity=0.0))
    samples.append(sample(4.0, subject('face', right, 'face:2', 0.95), [left, right], 2, 0.95, 0.65, fixed_layout=fixed, audio_activity=0.8))
    result = timeline(samples, duration=4.25)
    assert len(result) == 1, result
    assert result[0]['mode'] == 'stacked', result
    assert result[0]['renderBranch'] == 'fixed_two_panel_stacked', result
    assert result[0]['points'][-1]['primaryTrackId'] == 2, result


def test_general_stacked_conversation_resumes_without_layout_jump():
    left = box(150, 140, 360, 760, 1, 0.94)
    right = box(1380, 140, 360, 760, 2, 0.94)
    samples = [
        sample(index * 0.25, subject('face', left, 'face:1', 0.94), [left, right], 1, 0.94, 0.62)
        for index in range(5)
    ]
    samples.extend(
        sample(index * 0.25, subject('face', left, 'face:1', 0.18), [left, right], 1, 0.18, 0.01, audio_activity=0.0)
        for index in range(5, 16)
    )
    samples.append(sample(4.0, subject('face', right, 'face:2', 0.95), [left, right], 2, 0.95, 0.65, audio_activity=0.8))
    result = timeline(samples, duration=4.25)
    final_segment = result[-1]
    assert final_segment['mode'] == 'stacked', result
    assert final_segment['points'][-1]['primaryTrackId'] == 2, final_segment
    assert final_segment.get('topBox') and final_segment.get('bottomBox'), final_segment


def test_three_and_four_person_speech_stays_on_one_speaker():
    three = [box(100 + index * 580, 170, 320, 600, index + 1) for index in range(3)]
    four = [
        box(100, 80, 320, 430, 1), box(1100, 80, 320, 430, 2),
        box(100, 570, 320, 430, 3), box(1100, 570, 320, 430, 4),
    ]
    three_result = timeline([sample(i * 0.25, subject('face', three[0], 'face:1'), three, 1, 0.8) for i in range(8)])
    four_result = timeline([sample(i * 0.25, subject('face', four[0], 'face:1'), four, 1, 0.8) for i in range(8)])
    assert all(segment['mode'] == 'single' for segment in three_result), three_result
    assert all(segment.get('subjectStableId') == 'face:1' for segment in three_result), three_result
    assert all(segment['mode'] == 'single' for segment in four_result), four_result
    assert all(segment.get('subjectStableId') == 'face:1' for segment in four_result), four_result


def test_sports_action_without_face():
    action = box(1180, 260, 480, 620)
    result = timeline([sample(i * 0.25, subject('action', action, 'action:primary', 0.7)) for i in range(8)])
    assert result[0]['mode'] == 'single' and result[0]['subjectKind'] == 'action', result
    assert result[0]['points'][0]['cropCenterX'] > W / 2


def test_screen_text_preserves_context():
    result = timeline([sample(i * 0.25, subject('screen', None, 'screen', 0.85)) for i in range(8)])
    assert result[0]['mode'] == 'wide_context', result
    assert result[0]['points'][0]['cropW'] == W and result[0]['points'][0]['cropH'] == H


def test_screen_led_speech_is_publishable_without_a_face():
    samples = [
        sample(
            i * 0.25,
            subject('screen', None, 'screen', 0.85),
            audio_activity=0.8,
        )
        for i in range(12)
    ]
    points, _ = zip(*samples)
    result = timeline(samples)
    usable, reason = visual_usability(list(points), result)
    assert usable, (reason, result)


def test_action_led_speech_is_publishable_without_a_face():
    action = box(900, 160, 600, 760)
    samples = [
        sample(
            i * 0.25,
            subject('action', action, 'action:primary', 0.70),
            audio_activity=0.8,
        )
        for i in range(12)
    ]
    points, _ = zip(*samples)
    result = timeline(samples)
    usable, reason = visual_usability(list(points), result)
    assert usable, (reason, result)


def test_dominant_screen_context_survives_brief_facecam_misclassification():
    screen_samples = [
        sample(
            i * 0.25,
            subject('screen', None, 'screen', 0.85),
            audio_activity=0.8,
        )
        for i in range(9)
    ]
    tiny_face = box(1700, 20, 120, 120, 1)
    face_samples = [
        sample(
            (9 + i) * 0.25,
            subject('face', tiny_face, 'face:1', 0.70),
            [tiny_face], 1, 0.70, audio_activity=0.8,
        )
        for i in range(3)
    ]
    samples = screen_samples + face_samples
    points, _ = zip(*samples)
    result = timeline(samples)
    usable, reason = visual_usability(list(points), result)
    assert usable, (reason, result)


def test_tiny_facecam_does_not_replace_gameplay_or_screen_context():
    facecam = box(1680, 30, 180, 180)
    selected = semantic_subject_choice(
        face_box=facecam,
        speaker_confidence=0.85,
        screen_score=0.82,
        face_area_ratio=(180 * 180) / (W * H),
    )
    assert selected['kind'] == 'screen', selected
    assert selected['box'] is None, selected
    assert selected['reason'] == 'screen_or_text_context', selected


def test_handheld_motion_is_not_misclassified_as_a_screen():
    selected = semantic_subject_choice(
        motion_box=box(0, 160, 1920, 920),
        screen_score=0.90,
        motion_area_ratio=(1920 * 920) / (W * H),
    )
    assert selected['kind'] == 'action', selected
    assert selected['reason'] == 'primary_motion_or_action', selected


def test_large_presenter_remains_primary_over_screen_detail():
    presenter = box(120, 100, 620, 900)
    selected = semantic_subject_choice(
        face_box=presenter,
        speaker_confidence=0.85,
        screen_score=0.82,
        face_area_ratio=(620 * 900) / (W * H),
    )
    assert selected['kind'] == 'face', selected
    assert selected['box'] == presenter, selected


def test_full_body_fitness_or_demo_is_not_reduced_to_tiny_face():
    face = box(900, 100, 150, 150)
    body = box(600, 80, 720, 920)
    selected = semantic_subject_choice(
        face_box=face,
        body_box=body,
        speaker_confidence=0.75,
        face_area_ratio=(150 * 150) / (W * H),
        body_area_ratio=(720 * 920) / (W * H),
    )
    assert selected['kind'] == 'body', selected
    assert selected['box'] == body, selected
    assert selected['reason'] == 'full_body_action_context', selected


def test_close_talking_head_stays_face_led_when_body_is_detected():
    face = box(650, 80, 620, 720)
    body = box(420, 60, 1080, 1000)
    selected = semantic_subject_choice(
        face_box=face,
        body_box=body,
        speaker_confidence=0.88,
        face_area_ratio=(620 * 720) / (W * H),
        body_area_ratio=(1080 * 1000) / (W * H),
    )
    assert selected['kind'] == 'face', selected
    assert selected['box'] == face, selected


def test_no_subject_uses_safe_full_frame():
    result = timeline([sample(i * 0.25) for i in range(8)])
    assert result[0]['mode'] == 'wide_context', result
    assert result[0]['fallbackReason'] == 'no_reliable_visual_subject', result
    assert result[0]['points'][0]['cropX'] == 0.0 and result[0]['points'][0]['cropW'] == W


def test_sustained_tiny_speaking_face_is_rejected():
    tiny = box(820, 420, 75, 75, 1, 0.92)
    samples = [
        sample(i * 0.25, subject('face', tiny, 'face:1', 0.92), [tiny], 1, 0.92, audio_activity=0.8)
        for i in range(12)
    ]
    points, _ = zip(*samples)
    fake_timeline = [{
        'start': 0.0,
        'end': 3.0,
        'mode': 'single',
        'wideKind': None,
        'points': [
            {'t': i * 0.25, 'cropH': H}
            for i in range(12)
        ],
    }]
    usable, reason = visual_usability(list(points), fake_timeline)
    assert not usable and reason == 'speaking_subject_too_small', (usable, reason)


if __name__ == '__main__':
    tests = [value for name, value in sorted(globals().items()) if name.startswith('test_')]
    for test in tests:
        test()
        print(f'PASS {test.__name__}')
    print(f'PASS {len(tests)}/{len(tests)} universal semantic reframe acceptance tests')
