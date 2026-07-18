#!/usr/bin/env python3
"""Deterministic acceptance tests for universal semantic auto-reframing."""

from reframe_per_clip import (
    build_reframe_timeline,
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


def sample(t, subject=None, faces=None, active_id=None, speaker_conf=0.0, scene_cut=False):
    subject = subject or {
        'kind': 'context', 'box': None, 'confidence': 0.0,
        'reason': 'no_reliable_visual_subject', 'predicted': False,
        'stable_id': 'context', 'velocity_x': 0.0,
    }
    frame = {
        't': float(t), 'faces': faces or [], 'active_track_id': active_id,
        'selected_box': subject.get('box') if subject.get('kind') == 'face' else None,
        'semantic_subject': subject, 'scene_cut': scene_cut,
    }
    point = {
        't': float(t), 'speaker_confidence': float(speaker_conf),
        'audio_activity': 0.7 if speaker_conf else 0.0,
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
    print(f'PASS {len(tests)}/10 universal semantic reframe acceptance tests')
