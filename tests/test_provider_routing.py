import copy
from contextlib import nullcontext
import unittest
from unittest.mock import patch

from starlette.requests import Request
from hermes_speech_plugin import chained_stream


class ProviderRoutingTests(unittest.TestCase):
    def test_unified_scope_respects_backend_streaming_and_provider(self):
        base = {"tts": {"provider": "http-speech", "streaming": {"provider": "http-speech"}},
                "plugins": {"entries": {"hermes-speech": {"settings": {"backend": "qwen"}}}}}
        request = Request({"type": "http", "scheme": "http", "server": ("127.0.0.1", 8765),
                           "path": "/api/plugins/hermes-speech/transport-scope", "headers": []})
        cases = [(base, True)]
        for update in ("service", "disabled", "other-provider"):
            config = copy.deepcopy(base)
            if update == "service":
                config["plugins"]["entries"]["hermes-speech"]["settings"]["backend"] = "service"
            elif update == "disabled":
                config["tts"]["streaming"]["enabled"] = False
            else:
                config["tts"]["provider"] = "other-provider"
            cases.append((config, False))
        for config, expected in cases:
            with self.subTest(config=config), \
                 patch("hermes_cli.config.load_config", return_value=config), \
                 patch.object(chained_stream, "_config_profile_scope", return_value=nullcontext()):
                self.assertEqual(chained_stream.transport_scope(request)["qwen_enabled"], expected)
