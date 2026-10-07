import importlib.util
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


from hermes_speech_plugin.providers.stt.providers import qwen_streaming as ASR
from hermes_speech_plugin.providers.tts.providers import qwen_tts as TTS


class FakeSocket:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.sent = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def send(self, value):
        self.sent.append(value)

    def recv(self, timeout=None):
        value = next(self.replies)
        if isinstance(value, str):
            event = json.loads(value)
            event['header']['task_id'] = json.loads(self.sent[0])['header']['task_id']
            return json.dumps(event)
        return value

    def close(self):
        self.closed = True


class QwenProtocolTests(unittest.TestCase):
    def tearDown(self):
        ASR.release(); TTS.release()

    def test_public_endpoints_are_available_without_workspace_id(self):
        self.assertEqual(
            ASR.websocket_url({"region": "beijing"}),
            "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
        )
        self.assertEqual(
            TTS.websocket_url({"region": "beijing"}),
            "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
        )

    def test_asr_binary_stream_and_flash_model(self):
        replies = [
            json.dumps({"header": {"event": "task-started"}, "payload": {}}),
            json.dumps({"header": {"event": "result-generated"}, "payload": {
                "output": {"sentence": {"begin_time": 0, "text": "测试成功"}}
            }}),
            json.dumps({"header": {"event": "task-finished"}, "payload": {}}),
        ]
        socket = FakeSocket(replies)
        with patch.object(ASR.Path, "stat", return_value=SimpleNamespace(st_size=3200)), patch.object(ASR, "connect", return_value=socket), \
             patch.object(ASR, "_pcm_chunks", return_value=iter([b"\x00\x00" * 1600])):
                result = ASR.transcribe("sample.wav", {
                    "model": "qwen-audio-3.0-asr-flash-streaming",
                    "silence_gate_enabled": False,
                    "api_key": "secret",
                    "websocket_url": "wss://example.test/asr",
                })
        run = json.loads(socket.sent[0])
        self.assertEqual(run["payload"]["model"], "qwen-audio-3.0-asr-flash-streaming")
        self.assertTrue(any(isinstance(value, bytes) for value in socket.sent))
        self.assertEqual(json.loads(socket.sent[-1])["header"]["action"], "finish-task")
        self.assertEqual(result["transcript"], "测试成功")

    def test_tts_yields_pcm_and_flash_model(self):
        socket = FakeSocket([
            json.dumps({"header": {"event": "task-started"}, "payload": {}}),
            b"\x01\x02\x03\x04",
            json.dumps({"header": {"event": "task-finished"}, "payload": {}}),
        ])
        with patch.object(TTS, "connect", return_value=socket):
            blocks = list(TTS.stream_pcm("你好", {
                "model": "qwen-audio-3.0-tts-flash",
                "voice": "longanhuan_v3.6",
                "api_key": "secret",
                "websocket_url": "wss://example.test/tts",
            }))
        run = json.loads(socket.sent[0])
        actions = [json.loads(value)["header"]["action"] for value in socket.sent if isinstance(value, str)]
        self.assertEqual(run["payload"]["model"], "qwen-audio-3.0-tts-flash")
        self.assertEqual(actions, ["run-task", "continue-task", "finish-task"])
        self.assertEqual(blocks, [b"\x01\x02\x03\x04"])

    def test_model_mismatch_is_rejected(self):
        with self.assertRaises(RuntimeError):
            list(TTS.stream_pcm("x", {"model": "qwen-audio-3.0-tts-plus"}))
        with self.assertRaises(ValueError):
            ASR.transcribe("missing.wav", {"model": "qwen-audio-3.0-asr-flash"})


if __name__ == "__main__":
    unittest.main()

