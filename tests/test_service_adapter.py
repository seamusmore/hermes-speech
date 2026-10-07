import base64
import contextlib
import json
import threading
import unittest
from unittest.mock import patch
from hermes_speech_plugin import chained_stream, http_client
from hermes_speech_plugin.providers import tts


class ServiceAdapterTests(unittest.TestCase):
    def test_cancel_before_pcm_reaches_service_and_next_turn_works(self):
        cancelled = threading.Event()
        started = threading.Event()
        calls = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def raise_for_status(self): pass
            def iter_lines(self, **kwargs):
                started.set()
                if len(calls) == 1:
                    cancelled.wait(2)
                    return
                yield "data: " + json.dumps({"type": "audio", "b64": base64.b64encode(b"fresh-pcm").decode()})
                yield 'data: {"type":"done"}'
        def post(url, **kwargs):
            if "/cancel/" in url:
                cancelled.set()
            else:
                calls.append(kwargs["data"]["request_id"])
            return Response()
        section = {"backend": "local", "service_url": "http://127.0.0.1:8000/tts", "model": "cosyvoice3"}
        with patch.object(chained_stream, "_config_profile_scope", return_value=contextlib.nullcontext()), \
             patch.object(tts, "_load_http_tts_config", return_value=section), \
             patch.object(http_client, "headers_for", return_value={}), \
             patch.object(http_client, "post", side_effect=post):
            stream, config, _, _ = chained_stream.resolve_stream("isolated")
            stop = threading.Event()
            blocks = stream("first", config, stop_event=stop)
            self.assertEqual(next(blocks), b"")
            self.assertTrue(started.is_set())
            stop.set()
            self.assertEqual(list(blocks), [])
            self.assertTrue(cancelled.wait(1))
            next_stop = threading.Event()
            fresh = b"".join(stream("second", config, stop_event=next_stop))
            self.assertEqual(fresh, b"fresh-pcm")
            self.assertFalse(next_stop.is_set())
            self.assertEqual(len(set(calls)), 2)

    def test_local_asr_delivers_final_without_cloud_transport(self):
        from hermes_speech_plugin import duplex
        from hermes_speech_plugin.providers import stt
        events = []
        task = duplex.LocalASRTask("utterance", "isolated", events.append)
        task.feed(0, bytes(640))
        task.end()
        with patch.object(duplex, "inspect_speech", return_value={"accepted": True}), \
             patch.object(duplex, "record_decision"), \
             patch.object(duplex, "_config_profile_scope", return_value=contextlib.nullcontext()), \
             patch.object(stt.LocalHttpSTTProvider, "transcribe", return_value={"success": True, "transcript": "local text"}), \
             patch.object(duplex, "resolve_asr", side_effect=AssertionError("cloud called")):
            task.run()
        self.assertEqual([event["type"] for event in events], ["asr.final", "asr.closed"])
        self.assertEqual(events[0]["text"], "local text")
