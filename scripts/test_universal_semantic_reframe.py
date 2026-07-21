#!/usr/bin/env python3
"""Deterministic acceptance tests for universal semantic auto-reframing."""

from reframe_per_clip import (
    build_reframe_timeline,
    detect_fixed_two_panel_layout,
    portrait_crop_for_subject,
    semantic_subject_choice,
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
           speaker_margin=0.0, scene_cut=False, fixed_layout=None, audio_activity=None):
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


def speaker_centering_error(result, expected_centers):
    """Mean normalized distance between the crop center and expected speaker."""
    observed = [point['cropCenterX'] for segment in result for point in segment.get('points', [])]
    assert observed and expected_centers
    count = min(len(observed), len(expected_centers))
    return sum(abs(observed[i] - expected_centers[i]) / W for i in range(count)) / count


def test_silent_far_left():
    crop = portrait_crop_for_subject((40, 130, 420, 850), W, H, 'body')
    assert crop['cx'] < W * 0.32, crop


def test_silent_far_right():
    crop = portrait_crop_for_subject((1460, 130, 420, 850), W, H, 'body')
    assert crop['cx'] > W * 0.68, crop


def test_walking_left_to_right_smoothly():
    samples = []
    for index, x in enumerate((80, 200, 360, 540, 740, 940, 1140, 1320)):
        samples.append(sample(index * 0.5, subject('body', box(x, 130, 360, 820), 'body:walker', velocity_x=240)))
    result = timeline(samples)
    centers = [point['cropCenterX'] for point in result[0]['points']]
    assert centers == sorted(centers), centers
    assert max(b - a for a, b in zip(centers, centers[1:])) < W * 0.18, centers


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
    singles = [segment for segment in result if segment['mode'] == 'single']
    assert {segment['subjectStableId'] for segment in singles} >= {'face:1', 'face:2'}, result
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
    active = [segment for segment in result if segment.get('renderBranch') == 'active_speaker_right']
    assert active, result
    for segment in active:
        assert segment['mode'] == 'single' and segment['primaryPanel'] == 'right', segment
        for point in segment['points']:
            assert point['cropX'] >= fixed['right_region'][0], point
            assert point['cropX'] > fixed['divider_x'], point


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
    panel_segments = [segment for segment in result if segment.get('primaryPanel') in ('left', 'right')]
    assert [segment['primaryPanel'] for segment in panel_segments] == ['left', 'right'], result
    assert panel_segments[1]['hardCutStart'], panel_segments[1]
    assert panel_segments[0]['renderBranch'] == 'active_speaker_left'
    assert panel_segments[1]['renderBranch'] == 'active_speaker_right'
    assert panel_segments[0]['points'][-1]['cropX'] + panel_segments[0]['points'][-1]['cropW'] <= fixed['left_region'][1] + 1
    assert panel_segments[1]['points'][0]['cropX'] >= fixed['right_region'][0] - 1


def test_fixed_two_region_long_silence_holds_then_stacks_and_locks():
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
    hold = [segment for segment in result if segment.get('renderBranch') == 'active_speaker_left']
    widened = [segment for segment in result if segment.get('renderBranch') == 'silence_widen_stacked']
    locked = [segment for segment in result if segment.get('renderBranch') == 'silence_lock_stacked']
    assert hold and widened and locked, result
    assert all(segment['mode'] == 'stacked' for segment in widened + locked), result
    assert all(segment.get('silenceState') in ('widen', 'lock') for segment in widened + locked), result


def test_long_silence_resume_hard_cuts_to_confirmed_panel():
    left, right, fixed = fixed_two_region_fixture()
    samples = []
    for index in range(5):
        samples.append(sample(index * 0.25, subject('face', left, 'face:1', 0.94), [left, right], 1, 0.94, 0.62, fixed_layout=fixed))
    for index in range(5, 16):
        samples.append(sample(index * 0.25, subject('face', left, 'face:1', 0.18), [left, right], 1, 0.18, 0.01, fixed_layout=fixed, audio_activity=0.0))
    samples.append(sample(4.0, subject('face', right, 'face:2', 0.95), [left, right], 2, 0.95, 0.65, fixed_layout=fixed, audio_activity=0.8))
    result = timeline(samples, duration=4.25)
    resumed = [segment for segment in result if segment.get('renderBranch') == 'active_speaker_right']
    assert resumed and resumed[-1]['hardCutStart'], result
    assert resumed[-1]['primaryPanel'] == 'right', resumed[-1]


def test_general_conversation_long_silence_resumes_with_editorial_cut():
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
    resumed = [segment for segment in result if segment.get('subjectStableId') == 'face:2']
    assert resumed and resumed[-1]['hardCutStart'], result


def test_three_and_four_person_grids():
    three = [box(100 + index * 580, 170, 320, 600, index + 1) for index in range(3)]
    four = [
        box(100, 80, 320, 430, 1), box(1100, 80, 320, 430, 2),
        box(100, 570, 320, 430, 3), box(1100, 570, 320, 430, 4),
    ]
    three_result = timeline([sample(i * 0.25, subject('face', three[0], 'face:1'), three, 1, 0.8) for i in range(8)])
    four_result = timeline([sample(i * 0.25, subject('face', four[0], 'face:1'), four, 1, 0.8) for i in range(8)])
    assert any(segment['gridTemplate'] == 'hero_3' for segment in three_result), three_result
    assert any(segment['gridTemplate'] == 'grid_4' for segment in four_result), four_result


def test_sports_action_without_face():
    action = box(1180, 260, 480, 620)
    result = timeline([sample(i * 0.25, subject('action', action, 'action:primary', 0.7)) for i in range(8)])
    assert result[0]['mode'] == 'single' and result[0]['subjectKind'] == 'action', result
    assert result[0]['points'][0]['cropCenterX'] > W / 2


def test_screen_text_preserves_context():
    result = timeline([sample(i * 0.25, subject('screen', None, 'screen', 0.85)) for i in range(8)])
    assert result[0]['mode'] == 'wide_context', result
    assert result[0]['points'][0]['cropW'] == W and result[0]['points'][0]['cropH'] == H


def test_no_subject_uses_safe_full_frame():
    result = timeline([sample(i * 0.25) for i in range(8)])
    assert result[0]['mode'] == 'wide_context', result
    assert result[0]['fallbackReason'] == 'no_reliable_visual_subject', result
    assert result[0]['points'][0]['cropX'] == 0.0 and result[0]['points'][0]['cropW'] == W


if __name__ == '__main__':
    tests = [value for name, value in sorted(globals().items()) if name.startswith('test_')]
    for test in tests:
        test()
        print(f'PASS {test.__name__}')
    print(f'PASS {len(tests)}/{len(tests)} universal semantic reframe acceptance tests')
