"""Exercise the actual Hermes loader, registry, route and renderer publication."""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from hermes_speech_plugin import plugin_runtime as runtime
from hermes_speech_plugin.lifecycle import BridgeManager
from test_bridge_lifecycle import CONFIG, free_port, wait_closed


class NativePluginTests(unittest.TestCase):
    def test_official_dashboard_discovery_finds_packaged_api(self):
        from hermes_cli import web_server_dashboard as discovery
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(source / "dashboard", root / "hermes-speech" / "dashboard")
            with patch.object(discovery, "_dashboard_plugin_search_dirs", return_value=[(root, "user")]):
                entries = discovery._discover_dashboard_plugins()
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["name"], "hermes-speech")
            self.assertTrue(entries[0]["has_api"])
            self.assertEqual(entries[0]["_api_file"], "plugin_api.py")
            self.assertTrue((Path(entries[0]["_dir"]) / entries[0]["entry"]).is_file())

    def test_load_api_unload_reload_and_desktop_publication(self):
        from hermes_cli.plugins import PluginManager
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from hermes_speech_plugin import config, events_runtime
        source = Path(__file__).resolve().parents[1]
        full = {kind: {"provider": "http-speech", "http-speech": {"backend": "service"}} for kind in ("stt", "tts")}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "plugins" / "hermes-speech"
            shutil.copytree(source, target, ignore=shutil.ignore_patterns("tests", "__pycache__", ".git", ".env", "runtime"))
            (root / "desktop-plugins").mkdir()
            manager = PluginManager(scope_key=str(root))
            port = free_port()
            factory = lambda config: BridgeManager(CONFIG, root=root, port=port)
            runtime.shutdown()
            with patch.object(config, "load_full", return_value=full), \
                 patch.object(runtime, "BridgeManager", factory), \
                 patch.object(runtime.BridgeConfig, "from_env", return_value=CONFIG), \
                 patch.object(events_runtime, "activate"):
                manifest = next(m for m in manager._scan_directory(root/"plugins", "user") if m.name == "hermes-speech")
                try:
                    manager._load_plugin(manifest)
                    self.assertIsNone(manager._plugins[manifest.name].error)
                    from agent import transcription_registry, tts_registry
                    from tools.tts_streaming import _REGISTRY
                    for registry in (transcription_registry, tts_registry):
                        self.assertEqual(registry.get_provider("http-speech", scope=str(root)).name, "http-speech")
                    self.assertIn("http-speech", _REGISTRY)
                    self.assertNotIn("http_tts", _REGISTRY)
                    self.assertEqual((root/"desktop-plugins/hermes-speech/plugin.js").read_bytes(),
                                     (source/"desktop/plugin.js").read_bytes())
                    spec = importlib.util.spec_from_file_location("unified_native_api_test", target/"dashboard/plugin_api.py")
                    api = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(api)
                    app = FastAPI()
                    app.include_router(api.router, prefix="/api/plugins/hermes-speech")
                    with TestClient(app) as client:
                        first = client.post("/api/plugins/hermes-speech/ensure")
                        self.assertEqual(first.status_code, 200, first.text)
                        manager.unload(manifest.name)
                        self.assertTrue(wait_closed(port))
                        self.assertEqual(client.post("/api/plugins/hermes-speech/ensure").status_code, 503)
                        manager._load_plugin(manifest)
                        self.assertEqual(transcription_registry.get_provider("http-speech", scope=str(root)).name, "http-speech")
                        self.assertEqual(tts_registry.get_provider("http-speech", scope=str(root)).name, "http-speech")
                        second = client.post("/api/plugins/hermes-speech/ensure")
                        self.assertEqual(second.status_code, 200, second.text)
                        self.assertNotEqual(first.json()["instance"], second.json()["instance"])
                finally:
                    manager.unload(manifest.name)
                    runtime.shutdown()
                self.assertTrue(wait_closed(port))
