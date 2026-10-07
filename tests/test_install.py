import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import yaml

spec = importlib.util.spec_from_file_location("speech_installer_test", Path(__file__).resolve().parents[1]/"install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def fixture(self, root):
        home = root/"home"
        home.mkdir()
        before = b"# retain exact original on rollback\nplugins:\n  enabled: [http-stt, http-tts, rtk-rewrite]\n"
        (home/"config.yaml").write_bytes(before)
        for name in installer.OLD_DESKTOP:
            target = home/"desktop-plugins"/name
            target.mkdir(parents=True)
            (target/"plugin.js").write_text(name)
        source = root/"source"
        (source/"desktop").mkdir(parents=True)
        (source/"desktop/plugin.js").write_text("export default {}")
        (source/"plugin.yaml").write_text("name: hermes-speech")
        return home, source, before

    def test_dry_run_install_and_byte_exact_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            home, source, before = self.fixture(Path(directory))
            plan = installer.install(home, source)
            self.assertEqual(plan["status"], "prepared")
            self.assertEqual((home/"config.yaml").read_bytes(), before)
            result = installer.install(home, source, apply=True)
            self.assertEqual(sorted(p.name for p in (home/"desktop-plugins").iterdir()), ["hermes-speech"])
            full = yaml.safe_load((home/"config.yaml").read_text())
            self.assertEqual(full["plugins"]["enabled"], ["rtk-rewrite", "hermes-speech"])
            installer.rollback(result["backup"])
            self.assertEqual((home/"config.yaml").read_bytes(), before)
            self.assertEqual(sorted(p.name for p in (home/"desktop-plugins").iterdir()), sorted(installer.OLD_DESKTOP))

    def test_partial_copy_failure_restores_old_installation(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            home, source, before = self.fixture(Path(directory))
            original = installer.shutil.copy2
            def fail(src, dst, *args, **kwargs):
                if Path(dst).parent.name == "hermes-speech":
                    raise OSError("simulated disk failure")
                return original(src, dst, *args, **kwargs)
            with patch.object(installer.shutil, "copy2", side_effect=fail):
                with self.assertRaises(OSError):
                    installer.install(home, source, apply=True)
            self.assertEqual((home/"config.yaml").read_bytes(), before)
            self.assertTrue((home/"desktop-plugins/speech-chained/plugin.js").exists())

    def test_rollback_refuses_to_overwrite_later_config_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            home, source, _ = self.fixture(Path(directory))
            result = installer.install(home, source, apply=True)
            (home/"config.yaml").write_text("newer: true")
            with self.assertRaisesRegex(RuntimeError, "later edits"):
                installer.rollback(result["backup"])
            self.assertEqual((home/"config.yaml").read_text(), "newer: true")

