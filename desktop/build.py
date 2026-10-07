"""Build the single runtime-plugin entry using only Python's standard library."""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parent
MODULES = ["shared/core.mjs", "shared/events.mjs", "shared/playback.mjs",
           "shared/realtime.mjs", "host-adapter.mjs", "chained.mjs", "panel.mjs", "entry.mjs"]

def build():
    parts = ["const WORKLET_SOURCE=" + json.dumps((ROOT/"capture-worklet.js").read_text(encoding="utf-8")) + ";"]
    for name in MODULES:
        source = (ROOT/name).read_text(encoding="utf-8")
        source = re.sub(r"^import .+ from ['\"]\.\.?/[^'\"]+['\"];?\n", "", source, flags=re.M)
        if name != "entry.mjs":
            source = re.sub(r"^export ", "", source, flags=re.M)
        parts.append(source)
    (ROOT/"plugin.js").write_text("\n".join(parts), encoding="utf-8")
    return ROOT/"plugin.js"

if __name__ == "__main__":
    print(build())

