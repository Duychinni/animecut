"""Deterministic acceptance coverage for editorial layout planning."""

import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from editorial_layout_planner import plan_editorial_timeline  # noqa: E402
from layout_qa import validate_layout_timeline  # noqa: E402


def crop_point(timestamp=0.0):
    return {
        't': timestamp,
        'cropX': 100.0,
        'cropY': 0.0,
        'cropW': 607.5,
        'cropH': 1080.0,
        'cropCenterX': 403.75,
        'cropCenterY': 540.0,
        'zoom': 1.0,
    }


def subject(track_id, x):
    return {
        'trackId': track_id,
        'box': {'x': x, 'y': 120.0, 'w': 260.0, 'h': 520.0},
        'score': 0.95,
    }


class EditorialLayoutPlannerTests(unittest.TestCase):
    def test_single_speaker_remains_face_aware(self):
        planned, _ = plan_editorial_timeline([{
            'start': 0.0, 'end': 4.0, 'mode': 'single',
            'visibleCount': 1, 'points': [crop_point()],
        }])
        self.assertEqual(planned[0]['mode'], 'single')
        self.assertEqual(planned[0]['editorialSceneType'], 'SINGLE_SPEAKER')

    def test_two_people_use_vertical_stack(self):
        planned, _ = plan_editorial_timeline([{
            'start': 0.0, 'end': 5.0, 'mode': 'stacked', 'visibleCount': 2,
            'topBox': {'x': 80.0, 'y': 100.0, 'w': 420.0, 'h': 700.0},
            'bottomBox': {'x': 1040.0, 'y': 100.0, 'w': 420.0, 'h': 700.0},
        }])
        self.assertEqual(planned[0]['mode'], 'stacked')
        self.assertEqual(planned[0]['editorialLayout'], 'TWO_PERSON_CONVERSATION')

    def test_three_people_use_hero_grid(self):
        planned, _ = plan_editorial_timeline([{
            'start': 0.0, 'end': 5.0, 'mode': 'grid', 'visibleCount': 3,
            'gridTemplate': 'hero_3',
            'subjects': [subject(1, 50), subject(2, 650), subject(3, 1250)],
        }])
        self.assertEqual(planned[0]['mode'], 'grid')
        self.assertEqual(planned[0]['gridTemplate'], 'hero_3')
        self.assertEqual(planned[0]['editorialSceneType'], 'THREE_PERSON')

    def test_four_people_preserve_grid(self):
        planned, _ = plan_editorial_timeline([{
            'start': 0.0, 'end': 5.0, 'mode': 'grid', 'visibleCount': 4,
            'gridTemplate': 'grid_4',
            'subjects': [subject(1, 30), subject(2, 480), subject(3, 930), subject(4, 1380)],
        }])
        self.assertEqual(planned[0]['mode'], 'grid')
        self.assertEqual(planned[0]['editorialLayout'], 'PRESERVE_GRID')

    def test_broll_uses_context_fill(self):
        planned, _ = plan_editorial_timeline([{
            'start': 0.0, 'end': 3.0, 'mode': 'wide_context',
            'wideKind': 'broll', 'visibleCount': 0,
        }])
        self.assertEqual(planned[0]['mode'], 'wide_context')
        self.assertEqual(planned[0]['wideKind'], 'broll')
        self.assertEqual(planned[0]['editorialSceneType'], 'BROLL')

    def test_scene_cut_boundary_is_not_merged_away(self):
        planned, summary = plan_editorial_timeline([
            {'start': 0.0, 'end': 2.0, 'mode': 'single', 'visibleCount': 1, 'points': [crop_point()]},
            {'start': 2.0, 'end': 4.0, 'mode': 'single', 'visibleCount': 1,
             'points': [crop_point(2.0)], 'sceneCutStart': True},
        ])
        self.assertEqual(summary['segments'], 2)
        self.assertTrue(planned[1]['sceneCutStart'])

    def test_qa_rejects_stack_without_both_subjects(self):
        validated, report = validate_layout_timeline([{
            'start': 0.0, 'end': 2.0, 'mode': 'stacked',
            'topBox': {'x': 0.0, 'y': 0.0, 'w': 500.0, 'h': 700.0},
        }], [], 1920, 1080)
        self.assertEqual(validated[0]['mode'], 'wide_context')
        self.assertEqual(validated[0]['wideKind'], 'safe_wide')
        self.assertEqual(report['remaining_unsafe_segments'], 0)

    def test_qa_rejects_incomplete_grid(self):
        validated, _ = validate_layout_timeline([{
            'start': 0.0, 'end': 2.0, 'mode': 'grid', 'gridTemplate': 'grid_4',
            'subjects': [subject(1, 50), subject(2, 650), subject(3, 1250)],
        }], [], 1920, 1080)
        self.assertEqual(validated[0]['mode'], 'wide_context')
        self.assertEqual(validated[0]['subjects'], [])


if __name__ == '__main__':
    unittest.main()
