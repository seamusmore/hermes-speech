"""Publish one renderer entry only when a desktop installation is present."""
import os
from pathlib import Path


def publish(plugin_path):
    package = Path(plugin_path)
    desktop = package.parent.parent / "desktop-plugins"
    source = package / "desktop" / "plugin.js"
    if not desktop.is_dir() or not source.is_file():
        return
    target = desktop / "hermes-speech" / "plugin.js"
    content = source.read_bytes()
    if target.is_file() and target.read_bytes() == content:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_suffix(".pending-" + str(os.getpid()))
    staging.write_bytes(content)
    staging.replace(target)

