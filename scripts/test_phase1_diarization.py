import unittest

import numpy as np

from scripts.diarize_source import (
    RawTurn,
    build_centroids,
    mark_overlaps,
    non_speech_ranges,
    stable_speaker_mapping,
    turn_confidence,
)


class Phase1DiarizationTests(unittest.TestCase):
    def test_labels_are_anonymous_and_ordered_by_first_turn(self):
        turns = [
            RawTurn(4.0, 6.0, "provider-9"),
            RawTurn(0.5, 2.0, "provider-2"),
            RawTurn(8.0, 9.0, "provider-2"),
        ]
        self.assertEqual(
            stable_speaker_mapping(turns),
            {"provider-2": "speaker_a", "provider-9": "speaker_b"},
        )

    def test_overlap_is_explicit(self):
        turns = [RawTurn(0.0, 2.0, "a"), RawTurn(1.5, 3.0, "b"), RawTurn(4.0, 5.0, "a")]
        mark_overlaps(turns)
        self.assertEqual([turn.overlap for turn in turns], [True, True, False])

    def test_non_speech_ranges_cover_real_gaps(self):
        turns = [RawTurn(1.0, 2.0, "a"), RawTurn(1.5, 3.0, "b"), RawTurn(4.0, 5.0, "a")]
        self.assertEqual(non_speech_ranges(turns, 6.0), [(0.0, 1.0), (3.0, 4.0), (5.0, 6.0)])

    def test_confidence_has_documented_overlap_penalty(self):
        vector_a = np.asarray([1.0, 0.0], dtype=np.float32)
        vector_b = np.asarray([0.0, 1.0], dtype=np.float32)
        normal = RawTurn(0.0, 2.5, "a", speaker_key="speaker_a", embedding=vector_a)
        overlap = RawTurn(0.0, 2.5, "a", speaker_key="speaker_a", overlap=True, embedding=vector_a)
        centroids = build_centroids([
            normal,
            RawTurn(3.0, 5.0, "b", speaker_key="speaker_b", embedding=vector_b),
        ])
        normal_score = turn_confidence(normal, centroids, 3)
        overlap_score = turn_confidence(overlap, centroids, 3)
        self.assertIsNotNone(normal_score)
        self.assertIsNotNone(overlap_score)
        self.assertGreater(normal_score, overlap_score)
        self.assertGreaterEqual(overlap_score, 0.05)
        self.assertLessEqual(normal_score, 0.98)


if __name__ == "__main__":
    unittest.main()
