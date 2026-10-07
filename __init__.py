"""Hermes plugin entry point. All implementation is packaged with this plugin."""
import sys
from pathlib import Path
_root = str(Path(__file__).resolve().parent)
if _root not in sys.path:
    sys.path.insert(0, _root)
from hermes_speech_plugin import register
