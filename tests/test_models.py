import unittest

from hermes_speech_plugin import ASR_MODEL, REALTIME_MODEL, TTS_MODEL


class ModelTests(unittest.TestCase):
    def test_flash_models_are_locked(self):
        self.assertEqual(ASR_MODEL, "qwen-audio-3.0-asr-flash-streaming")
        self.assertEqual(TTS_MODEL, "qwen-audio-3.0-tts-flash")
        self.assertEqual(REALTIME_MODEL, "qwen-audio-3.0-realtime-flash")


if __name__ == "__main__":
    unittest.main()

