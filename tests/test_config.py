import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_speech_plugin.config import provider_config, validate_service_url
from hermes_speech_plugin import http_client


class ConfigTests(unittest.TestCase):
    def config(self, stt=None, tts=None):
        return {"stt": {"provider": "http-speech", "http-speech": stt or {}},
                "tts": {"provider": "http-speech", "http-speech": tts or {}}}

    def test_backend_selection_and_default_service_endpoints(self):
        for backend, resolved in (("qwen", "qwen"), ("service", "local")):
            cfg = self.config({"backend": backend}, {"backend": backend})
            for kind in ("stt", "tts"):
                self.assertEqual(provider_config(kind, cfg)["backend"], resolved)
                if backend == "service":
                    self.assertEqual(provider_config(kind, cfg)["service_url"], "http://127.0.0.1:8000/" + kind)

    def test_mixed_backends_and_explicit_service_endpoint(self):
        cfg = self.config({"backend": "service", "service": {"url": "https://voice.example/api/"}},
                          {"backend": "qwen", "qwen": {"voice": "current"}})
        self.assertEqual(provider_config("stt", cfg)["service_url"], "https://voice.example/api/stt")
        self.assertEqual(provider_config("tts", cfg)["backend"], "qwen")

    def test_old_sections_cannot_override_or_supply_options(self):
        cfg = self.config(tts={"backend": "qwen", "qwen": {"voice": "current"}})
        cfg["tts"]["http_tts"] = {"backend": "local", "qwen": {"voice": "old", "rate": 2}}
        cfg["plugins"] = {"entries": {"hermes-speech": {"settings": {
            "backend": "qwen", "stt": {"qwen": {"model": "old"}},
            "tts": {"qwen": {"voice": "old", "rate": 2}}}}}}
        self.assertEqual(provider_config("tts", cfg)["qwen"], {"voice": "current"})
        self.assertEqual(provider_config("stt", cfg)["backend"], "local")
        self.assertEqual(provider_config("stt", cfg)["qwen"], {})
        old_only = {"stt": {"http_stt": {"backend": "qwen"}}}
        self.assertEqual(provider_config("stt", old_only)["backend"], "local")

    def test_options_are_copied_without_mutating_input(self):
        cfg = self.config(tts={"backend": "qwen", "qwen": {"voice": "current", "rate": 1.2}})
        before = copy.deepcopy(cfg)
        result = provider_config("tts", cfg)
        result["qwen"]["voice"] = "changed"
        self.assertEqual(cfg, before)
        self.assertEqual(provider_config("tts", cfg)["qwen"]["rate"], 1.2)

    def test_bad_backend_fails_explicitly(self):
        for backend in ("typo", "local"):
            with self.assertRaises(ValueError):
                provider_config("stt", self.config(stt={"backend": backend}))

    def test_remote_service_requires_tls_and_separate_credentials(self):
        self.assertEqual(validate_service_url("https://voice.example/api/"), "https://voice.example/api")
        for url in ("http://voice.example", "file:///etc", "https://user:secret@voice.example", "https://voice.example?token=secret"):
            with self.assertRaises(ValueError):
                validate_service_url(url)

    def test_qwen_does_not_require_the_local_service(self):
        from hermes_speech_plugin import local_service
        with patch("hermes_speech_plugin.config.load_full", return_value=self.config({"backend": "qwen", "service": {"managed": True}}, {"backend": "qwen"})), \
             patch.object(local_service.subprocess, "Popen") as spawn:
            local_service.activate(object())
            spawn.assert_not_called()

    def test_service_credentials_stay_with_configured_endpoint(self):
        cfg = self.config(stt={"backend": "service", "service": {
            "url": "https://speech.example/private", "token_env": "STT_TOKEN"}},
            tts={"backend": "qwen"})
        with patch("hermes_speech_plugin.config.load_full", return_value=cfg), \
             patch("agent.secret_scope.get_secret_str", return_value="scoped-token") as secret:
            self.assertEqual(http_client.headers_for("https://speech.example/private/stt/transcribe"),
                             {"Authorization": "Bearer scoped-token"})
            secret.assert_called_with("STT_TOKEN")
            for url in ("https://other.example/private", "https://speech.example/private-other", "http://speech.example/private"):
                self.assertEqual(http_client.headers_for(url), {})

    def test_service_management_uses_each_capability_settings(self):
        from hermes_speech_plugin import local_service
        cfg = self.config(stt={"backend": "service", "service": {"url": "http://127.0.0.1:8000", "managed": True}},
                          tts={"backend": "qwen", "service": {"managed": True}})
        with patch("hermes_speech_plugin.config.load_full", return_value=cfg), \
             patch.object(local_service, "_activate_service") as activate:
            local_service.activate(object())
            self.assertEqual(activate.call_args_list[0].args[1], cfg["stt"]["http-speech"]["service"])
            self.assertEqual(activate.call_args_list[1].args[1], {})

    def test_realtime_reads_voice_config_and_scoped_cloud_secret(self):
        from hermes_speech_plugin.signal_bridge import BridgeConfig
        cfg = {"voice": {"gpt_live": {"model": "qwen-audio-3.1-realtime-plus",
               "api_key": "local-bridge-token", "qwen": {"api_key_env": "CUSTOM_QWEN_KEY",
               "workspace_id": "workspace", "region": "singapore", "timeout_seconds": 42}}}}
        with patch("hermes_speech_plugin.config.load_full", return_value=cfg), \
             patch("agent.secret_scope.get_secret_str", return_value="scoped-cloud-key") as secret:
            bridge = BridgeConfig.from_config()
            secret.assert_called_once_with("CUSTOM_QWEN_KEY")
            self.assertEqual(bridge.api_key, "scoped-cloud-key")
            self.assertEqual(bridge.local_token, "local-bridge-token")
            self.assertEqual(bridge.model, cfg["voice"]["gpt_live"]["model"])
            self.assertEqual(bridge.timeout_seconds, 42)
            self.assertIn("workspace.ap-southeast-1", bridge.upstream_url)

    def test_realtime_does_not_fall_back_outside_secret_scope(self):
        from hermes_speech_plugin.signal_bridge import BridgeConfig
        with patch("hermes_speech_plugin.config.load_full", return_value={}), \
             patch("agent.secret_scope.get_secret_str", return_value=""), \
             patch.dict("os.environ", {"DASHSCOPE_API_KEY": "foreign-key", "HERMES_SPEECH_BRIDGE_TOKEN": "old-token"}):
            bridge = BridgeConfig.from_config()
            self.assertEqual(bridge.api_key, "")
            self.assertEqual(bridge.local_token, "")

    def test_http_stream_credentials_are_captured_by_caller(self):
        with patch.object(http_client, "headers_for", side_effect=AssertionError("profile lost")), \
             patch.object(http_client._requests, "request") as send:
            http_client.post("http://127.0.0.1:8000/tts/cancel/a", headers={"Authorization": "Bearer captured"})
            self.assertEqual(send.call_args.kwargs["headers"]["Authorization"], "Bearer captured")
            self.assertFalse(send.call_args.kwargs["allow_redirects"])


if __name__ == "__main__":
    unittest.main()
