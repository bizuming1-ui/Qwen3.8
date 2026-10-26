from __future__ import annotations

import json
import struct
import unittest

from arena_protocol import C_PCM, Segmenter, SegCfg, detect_lang, frame, json_frame, policy_for


class ProtocolTests(unittest.TestCase):
    def test_client_frame_is_little_endian_and_self_delimiting(self):
        payload = b"\x01\x02\x03"
        encoded = frame(C_PCM, 7, payload)
        self.assertEqual(struct.unpack("<BII", encoded[:9]), (C_PCM, 7, 3))
        self.assertEqual(encoded[9:], payload)
        self.assertEqual(len(json_frame(3, 0, {"t": "中文"})), 9 + len('{"t":"中文"}'.encode()))

    def test_read_segmenter_preserves_source_and_adds_pause_metadata(self):
        text = "你好，世界。第二句在这里！\n\n第三句继续。"
        first = Segmenter(SegCfg.for_profile({}, "read"), 123)
        segments = first.feed(text) + first.flush()
        self.assertGreaterEqual(len(segments), 2)
        self.assertEqual("".join(segment.text for segment in segments), text)
        self.assertEqual(segments[0].pause_ms, 0)
        self.assertTrue(all(segment.pause_ms >= 0 for segment in segments[1:]))
        second = Segmenter(SegCfg.for_profile({}, "read"), 123)
        self.assertEqual([segment.as_dict() for segment in segments], [segment.as_dict() for segment in second.feed(text) + second.flush()])

    def test_live_first_sentence_can_be_submitted_before_flush(self):
        segmenter = Segmenter(SegCfg.for_profile({}, "chat"), 1)
        segments = segmenter.feed("你好。")
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].text, "你好。")

    def test_language_and_watermark_policy(self):
        self.assertEqual(detect_lang("你好，世界"), "Chinese")
        self.assertEqual(detect_lang("hello world"), "English")
        self.assertEqual(detect_lang("こんにちは"), "Japanese")
        self.assertEqual(policy_for(2.3)["low_s"], 3.5)
        self.assertEqual(policy_for(0.2, 4)["low_s"], 16.0)

    def test_diagnostic_filter_does_not_retrieve_arbitrary_text(self):
        from arena_gateway import diagnostic_map
        cleaned = diagnostic_map({
            "session": "a" * 12,
            "request_mode": "read",
            "custom_text": "do not export this",
            "client": {"text": "do not export this", "first_played_ms": 12},
        })
        serialized = json.dumps(cleaned, ensure_ascii=False)
        self.assertNotIn("do not export", serialized)
        self.assertEqual(cleaned["request_mode"], "read")
        self.assertEqual(cleaned["client"]["first_played_ms"], 12.0)


if __name__ == "__main__":
    unittest.main()
