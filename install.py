"""Transactional local installation. Default is a redacted plan; --apply writes."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys
from uuid import uuid4
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_speech_plugin.config import migrate_config, settings

OLD_DESKTOP = ("qwen-realtime-bridge", "speech-chained")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bounded(home, path):
    path = Path(path).resolve()
    path.relative_to(home)
    if path == home:
        raise ValueError("Refuse operation on the Hermes home itself")
    return path


def prepare(home, source, service_root=None, bridge_env=None):
    home, source = Path(home).resolve(), Path(source).resolve()
    path = bounded(home, home/"config.yaml")
    before = path.read_bytes()
    original = yaml.safe_load(before.decode("utf-8-sig")) or {}
    result = migrate_config(original)
    options = result["plugins"]["entries"]["hermes-speech"]["settings"]
    if service_root:
        service_root = Path(service_root).resolve()
        executable = service_root / "venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        if not executable.is_file() or not (service_root/"run.py").is_file():
            raise ValueError("Unified service runtime is incomplete")
        options["service"].update(managed=True, path=str(service_root), python=str(executable))
    if bridge_env:
        bridge_env = Path(bridge_env).resolve()
        if not bridge_env.is_file():
            raise FileNotFoundError("Realtime bridge environment file is missing")
        options.setdefault("bridge", {})["environment_file"] = str(bridge_env)
    if not (source/"plugin.yaml").is_file() or not (source/"desktop/plugin.js").is_file():
        raise ValueError("Build the unified package before installation")
    after = yaml.safe_dump(result, allow_unicode=True, sort_keys=False).encode("utf-8")
    summary = {"enabled": result["plugins"]["enabled"], "disabled": result["plugins"]["disabled"],
               "providers": {k: options[k]["provider"] for k in ("stt", "tts")},
               "desktop": (home/"desktop-plugins").is_dir(), "config_before_sha256": digest(before),
               "config_after_sha256": digest(after)}
    return before, after, summary


def install(home, source, *, service_root=None, bridge_env=None, apply=False):
    home, source = Path(home).resolve(), Path(source).resolve()
    before, after, summary = prepare(home, source, service_root, bridge_env)
    if not apply:
        return dict(summary, status="prepared")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
    backup = bounded(home, home/"backups"/("speech-consolidation-" + stamp))
    backup.mkdir(parents=True)
    (backup/"config.before.yaml").write_bytes(before)
    journal = {"home": str(home), "config_after_sha256": digest(after), "moves": [], "installed": []}
    log = backup/"journal.json"
    def save():
        log.write_text(json.dumps(journal, indent=2), encoding="utf-8")
    save()
    def move_old(path):
        path = bounded(home, path)
        if path.exists():
            saved = bounded(home, backup/"previous"/path.relative_to(home))
            saved.parent.mkdir(parents=True, exist_ok=True)
            path.rename(saved)
            journal["moves"].append([str(path), str(saved)])
            save()
    try:
        staging = bounded(home, backup/"staged-plugin")
        shutil.copytree(source, staging, ignore=shutil.ignore_patterns("__pycache__", "tests", ".env", "*.pyc", ".git", "runtime"))
        target = bounded(home, home/"plugins"/"hermes-speech")
        target.parent.mkdir(parents=True, exist_ok=True)
        move_old(target)
        staging.rename(target)
        journal["installed"].append(str(target))
        save()
        desktop = home/"desktop-plugins"
        if desktop.is_dir():
            for name in (*OLD_DESKTOP, "hermes-speech"):
                move_old(desktop/name)
            renderer = bounded(home, desktop/"hermes-speech")
            renderer.mkdir()
            journal["installed"].append(str(renderer))
            save()
            shutil.copy2(source/"desktop/plugin.js", renderer/"plugin.js")
        config = bounded(home, home/"config.yaml")
        if config.read_bytes() != before:
            raise RuntimeError("Configuration changed during preparation")
        pending = bounded(home, home/("config.speech-" + stamp + ".pending"))
        pending.write_bytes(after)
        pending.replace(config)
        journal["committed"] = True
        save()
    except BaseException:
        rollback(backup, allow_uncommitted=True)
        raise
    return dict(summary, status="installed", backup=str(backup), restart_required=True)


def rollback(backup, allow_uncommitted=False):
    backup = Path(backup).resolve()
    journal = json.loads((backup/"journal.json").read_text(encoding="utf-8"))
    home = Path(journal["home"]).resolve()
    bounded(home, backup)
    if journal.get("rolled_back"):
        return {"status": "already-rolled-back"}
    config = bounded(home, home/"config.yaml")
    if not allow_uncommitted and digest(config.read_bytes()) != journal["config_after_sha256"]:
        raise RuntimeError("Configuration has later edits; review the backup before rollback")
    for index, item in enumerate(reversed(journal["installed"])):
        path = bounded(home, item)
        if path.exists():
            saved = bounded(home, backup/("replaced-new-" + str(index)))
            path.rename(saved)
    for original, saved in reversed(journal["moves"]):
        original, saved = bounded(home, original), bounded(home, saved)
        saved.relative_to(backup)
        if saved.exists():
            original.parent.mkdir(parents=True, exist_ok=True)
            saved.rename(original)
    # Preserve an unrelated config edit if failure occurred before our config commit.
    if journal.get("committed") or digest(config.read_bytes()) == journal["config_after_sha256"]:
        pending = bounded(home, home/("config.speech-rollback-" + uuid4().hex + ".pending"))
        pending.write_bytes((backup/"config.before.yaml").read_bytes())
        pending.replace(config)
    journal["rolled_back"] = True
    (backup/"journal.json").write_text(json.dumps(journal, indent=2), encoding="utf-8")
    return {"status": "rolled-back", "restart_required": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path)
    parser.add_argument("--service-root", type=Path)
    parser.add_argument("--bridge-env", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rollback", type=Path)
    args = parser.parse_args()
    if args.rollback:
        result = rollback(args.rollback)
    else:
        if not args.home:
            parser.error("--home is required")
        result = install(args.home, Path(__file__).resolve().parent, service_root=args.service_root,
                         bridge_env=args.bridge_env, apply=args.apply)
    print(json.dumps(result, ensure_ascii=True, indent=2))
