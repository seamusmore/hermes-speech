import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_speech_plugin.config import provider_config, settings, validate_service_url
from hermes_speech_plugin import http_client


class ConfigTests(unittest.TestCase):
    def test_shared_backend_controls_both_capabilities(self):
        for backend, resolved in (("qwen", "qwen"), ("service", "local")):
            cfg = {"plugins": {"entries": {"hermes-speech": {"settings": {"backend": backend}}}}}
            for kind in ("stt", "tts"):
                self.assertEqual(provider_config(kind, cfg)["backend"], resolved)
                if backend == "service":
                    self.assertEqual(provider_config(kind, cfg)["service_url"], "http://127.0.0.1:8000/" + kind)

    def config(self, options):
        return {"plugins": {"entries": {"hermes-speech": {"settings": options}}}}

    def test_mixed_backends_and_service_root(self):
        cfg = self.config({"backend": "service", "tts": {"backend": "qwen"},
                           "service": {"url": "https://voice.example/api/"}})
        self.assertEqual(provider_config("stt", cfg)["service_url"], "https://voice.example/api/stt")
        self.assertEqual(provider_config("tts", cfg)["backend"], "qwen")

    def test_old_sections_cannot_override_or_supply_options(self):
        cfg = self.config({"backend": "qwen", "tts": {"qwen": {"voice": "current"}}})
        cfg["tts"] = {"http_tts": {"backend": "local", "qwen": {"voice": "old", "rate": 2}}}
        result = provider_config("tts", cfg)
        self.assertEqual(result["backend"], "qwen")
        self.assertEqual(result["qwen"], {"voice": "current"})
        old_only = {"stt": {"http_stt": {"backend": "qwen", "qwen": {"model": "old"}}}}
        self.assertEqual(provider_config("stt", old_only)["backend"], "local")
        self.assertEqual(provider_config("stt", old_only)["qwen"], {})

    def test_old_selection_and_url_are_ignored(self):
        cfg = self.config({"stt": {"provider": "qwen", "service_url": "http://127.0.0.1:8001"}})
        result = provider_config("stt", cfg)
        self.assertEqual(result["backend"], "local")
        self.assertEqual(result["service_url"], "http://127.0.0.1:8000/stt")

    def test_options_are_copied_without_mutating_input(self):
        cfg = self.config({"backend": "qwen", "tts": {"qwen": {"voice": "current", "rate": 1.2}}})
        before = copy.deepcopy(cfg)
        result = provider_config("tts", cfg)
        result["qwen"]["voice"] = "changed"
        self.assertEqual(cfg, before)
        self.assertEqual(settings(cfg)["tts"]["qwen"]["rate"], 1.2)

    def test_bad_backend_fails_explicitly(self):
        for backend in ("typo", "local"):
            with self.assertRaises(ValueError):
                provider_config("stt", self.config({"backend": backend}))

    def test_remote_service_requires_tls_and_separate_credentials(self):
        self.assertEqual(validate_service_url("https://voice.example/api/"), "https://voice.example/api")
        for url in ("http://voice.example", "file:///etc", "https://user:secret@voice.example", "https://voice.example?token=secret"):
            with self.assertRaises(ValueError):
                validate_service_url(url)

    def test_qwen_does_not_require_the_local_service(self):
        from hermes_speech_plugin import local_service
        with patch.object(local_service, "settings", return_value={"service": {"managed": True}}), \
             patch.object(local_service, "provider_config", return_value={"backend": "qwen"}), \
             patch.object(local_service.subprocess, "Popen") as spawn:
            local_service.activate(object())
            spawn.assert_not_called()

    def test_http_stream_credentials_are_captured_by_caller(self):
        with patch.object(http_client, "headers_for", side_effect=AssertionError("profile lost")), \
             patch.object(http_client._requests, "request") as send:
            http_client.post("http://127.0.0.1:8000/tts/cancel/a", headers={"Authorization": "Bearer captured"})
            self.assertEqual(send.call_args.kwargs["headers"]["Authorization"], "Bearer captured")
            self.assertFalse(send.call_args.kwargs["allow_redirects"])


if __name__ == "__main__":
    unittest.main()
