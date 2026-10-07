import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch


from hermes_speech_plugin.providers.stt.providers import qwen_streaming as ASR


class FakeSocket:
    def __init__(self, replies):
        self.replies = iter(replies)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def send(self, value):
        if isinstance(value, str) and json.loads(value)['header']['action'] == 'run-task':
            self.task_id = json.loads(value)['header']['task_id']

    def close(self): pass

    def recv(self, timeout=None):
        event=json.loads(next(self.replies))
        event['header']['task_id']=self.task_id
        return json.dumps(event)


class AsrIncrementalMergeTests(unittest.TestCase):
    def tearDown(self): ASR.release()

    def test_final_replaces_intermediate_for_same_sentence(self):
        replies = [
            json.dumps({"header": {"event": "task-started"}, "payload": {}}),
            json.dumps({"header": {"event": "result-generated"}, "payload": {
                "output": {"sentence": {
                    "sentence_id": 1, "sentence_end": False,
                    "begin_time": 0, "text": "partial"
                }}
            }}),
            json.dumps({"header": {"event": "result-generated"}, "payload": {
                "output": {"sentence": {
                    "sentence_id": 1, "sentence_end": True,
                    "begin_time": 170, "end_time": 920, "text": "final"
                }}
            }}),
            json.dumps({"header": {"event": "task-finished"}, "payload": {}}),
        ]
        with patch.object(ASR.Path, "stat", return_value=SimpleNamespace(st_size=3200)), patch.object(ASR, "connect", return_value=FakeSocket(replies)), patch.object(
            ASR, "_pcm_chunks", return_value=iter([b"\x00\x00" * 1600])
        ):
            result = ASR.transcribe("sample.webm", {
                "model": "qwen-audio-3.0-asr-flash-streaming",
                    "silence_gate_enabled": False,
                "api_key": "secret",
                "websocket_url": "wss://example.test/asr",
            })
        self.assertEqual(result["transcript"], "final")


if __name__ == "__main__":
    unittest.main()
