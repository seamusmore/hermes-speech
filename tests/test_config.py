import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_speech_plugin.config import migrate_config, migrate_provider_config, provider_config, settings, validate_service_url
from hermes_speech_plugin import http_client


class ConfigTests(unittest.TestCase):
    def test_shared_backend_controls_both_capabilities(self):
        for backend, resolved in (("qwen", "qwen"), ("service", "local")):
            cfg = {"plugins": {"entries": {"hermes-speech": {"settings": {"backend": backend}}}}}
            for kind in ("stt", "tts"):
                self.assertEqual(provider_config(kind, cfg)["backend"], resolved)
                if backend == "service":
                    self.assertEqual(provider_config(kind, cfg)["service_url"], "http://127.0.0.1:8000/" + kind)

    def test_provider_migration_preserves_effective_options_and_is_idempotent(self):
        original = self.legacy()
        original["tts"]["streaming"] = {"provider": "http_tts", "enabled": True}
        migrated = migrate_provider_config(original)
        for kind in ("stt", "tts"):
            self.assertEqual(migrated[kind]["provider"], "http-speech")
            self.assertEqual(provider_config(kind, migrated), provider_config(kind, original))
        self.assertEqual(migrated["tts"]["streaming"]["provider"], "http-speech")
        self.assertEqual(migrate_provider_config(migrated), migrated)
        self.assertEqual(original["stt"]["provider"], "http_stt")
        self.assertEqual(migrated["voice"], original["voice"])

    def test_new_backend_overrides_old_selection_and_supports_mixed_backends(self):
        cfg = self.legacy()
        options = {"backend": "service", "stt": {"provider": "qwen"},
                   "tts": {"backend": "qwen"}, "service": {"url": "https://voice.example"}}
        cfg["plugins"]["entries"] = {"hermes-speech": {"settings": options}}
        self.assertEqual(provider_config("stt", cfg)["backend"], "local")
        self.assertEqual(provider_config("stt", cfg)["service_url"], "https://voice.example/stt")
        self.assertEqual(provider_config("tts", cfg)["backend"], "qwen")

    def legacy(self):
        return {"stt": {"provider": "http_stt", "http_stt": {"backend": "qwen", "qwen": {"model": "asr"}}},
                "tts": {"provider": "http_tts", "http_tts": {"backend": "local", "voice": "unchanged", "service_url": "http://127.0.0.1:8002"}},
                "plugins": {"enabled": ["http-stt", "rtk-rewrite", "http-tts", "speech-chained", "qwen-realtime-bridge"], "disabled": []},
                "voice": {"gpt_live": {"api_key": "preserved-secret", "model": "existing-model"}}}

    def test_provider_selection_is_independent_per_capability(self):
        result = migrate_config(self.legacy())
        self.assertEqual(provider_config("stt", result)["backend"], "qwen")
        self.assertEqual(provider_config("tts", result)["backend"], "local")
        self.assertEqual(provider_config("tts", result)["service_url"], "http://127.0.0.1:8000/tts")
        self.assertEqual(provider_config("stt", result)["qwen"]["model"], "asr")

    def test_migration_preserves_input_settings_and_unrelated_plugins(self):
        original = self.legacy()
        before = copy.deepcopy(original)
        result = migrate_config(original)
        self.assertEqual(original, before)
        self.assertEqual(result["voice"], before["voice"])
        self.assertEqual(result["plugins"]["enabled"], ["rtk-rewrite", "hermes-speech"])
        self.assertEqual(provider_config("tts", result)["voice"], "unchanged")
        self.assertFalse(settings(result)["service"]["managed"])

    def test_migration_is_idempotent(self):
        once = migrate_config(self.legacy())
        self.assertEqual(migrate_config(once), once)

    def test_legacy_urls_work_until_explicit_migration(self):
        self.assertEqual(provider_config("tts", self.legacy())["service_url"], "http://127.0.0.1:8002")

    def test_bad_provider_fails_explicitly(self):
        cfg = migrate_config(self.legacy())
        cfg["plugins"]["entries"]["hermes-speech"]["settings"]["stt"]["provider"] = "typo"
        with self.assertRaises(ValueError):
            provider_config("stt", cfg)

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
