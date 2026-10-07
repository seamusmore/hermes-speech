"""Real Qwen calls through installed duplex handlers, with synthetic speech only."""
import argparse
import base64
import json
import logging
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument("--home", type=Path, required=True)
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--site-packages", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
os.environ["HERMES_HOME"] = str(args.home)
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
sys.path[:0] = [str(args.home/"plugins/hermes-speech"), str(args.site_packages), str(args.source)]
logging.basicConfig(level=logging.CRITICAL)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hermes_speech_plugin import duplex
from hermes_cli.plugins import get_plugin_manager
import numpy as np

app = FastAPI()
app.include_router(duplex.router)
report = {"mode": "installed-plugin-real-qwen-through-duplex-handler",
          "physical_playback": "not_measured", "tts": []}
audio = []
started = time.monotonic()

def collect(ws, uid):
    events = []
    while True:
        event = ws.receive_json()
        if event.get("id") != uid:
            raise RuntimeError("Unexpected task ownership")
        if event["type"] == "error":
            raise RuntimeError(event.get("code", "provider_error"))
        events.append(event)
        if event["type"] == "tts.closed":
            return events

try:
    # The production auth and origin tests are separate; only TestClient's synthetic
    # origin is bypassed here. Provider resolution and transports remain untouched.
    with patch.object(duplex, "_ws_request_is_allowed", return_value=True), TestClient(app) as client:
        bootstrap = client.post("/bootstrap")
        bootstrap.raise_for_status()
        from urllib.parse import urlsplit
        url = urlsplit(bootstrap.json()["url"])
        with client.websocket_connect(url.path+"?"+url.query) as ws:
            assert ws.receive_json()["type"] == "ready"
            sentences = ["这是合并后的流式语音测试。", "第二句话继续正常播放。", "第三句话完成整段测试。"]
            for index, text in enumerate(sentences):
                uid = "normal-" + str(index)
                begin = time.monotonic()
                ws.send_json({"type": "tts.begin", "id": uid, "text": text})
                events = collect(ws, uid)
                pcm = b"".join(base64.b64decode(e["pcm"]) for e in events if e["type"] == "tts.pcm")
                assert pcm and any(e["type"] == "tts.done" for e in events)
                audio.append(pcm)
                report["tts"].append({"id": uid, "pcm_bytes": len(pcm), "completed": True,
                                      "elapsed_ms": round((time.monotonic()-begin)*1000)})
            ws.send_json({"type": "tts.begin", "id": "cancel", "text": "这段文字用于首包前取消测试，后续音频应当被丢弃。"})
            time.sleep(.05)
            ws.send_json({"type": "tts.cancel", "id": "cancel"})
            events = collect(ws, "cancel")
            assert not any(e["type"] in ("tts.pcm", "tts.done") for e in events)
            report["cancel_before_pcm"] = True
            ws.send_json({"type": "tts.begin", "id": "fresh", "text": "取消之后的下一轮语音正常恢复。"})
            events = collect(ws, "fresh")
            assert any(e["type"] == "tts.pcm" for e in events) and any(e["type"] == "tts.done" for e in events)
            report["next_turn_recovered"] = True
            samples = np.frombuffer(audio[0], dtype="<i2")
            resampled = np.interp(np.arange(0, len(samples), 1.5), np.arange(len(samples)), samples).astype("<i2").tobytes()
            resampled += bytes((-len(resampled)) % 640)
            ws.send_json({"type": "asr.begin", "id": "recognize", "playing": False})
            for seq, offset in enumerate(range(0, len(resampled), 640)):
                ws.send_json({"type": "asr.audio", "id": "recognize", "seq": seq,
                              "pcm": base64.b64encode(resampled[offset:offset+640]).decode()})
            ws.send_json({"type": "asr.end", "id": "recognize"})
            final = None
            while True:
                event = ws.receive_json()
                if event["type"] == "error":
                    raise RuntimeError(event.get("code"))
                if event["type"] == "asr.final":
                    final = event
                if event["type"] == "asr.closed":
                    break
            assert final and final["text"] and final["speech"]["accepted"]
            report["asr"] = {"text": final["text"], "speech_accepted": True}
    report["passed"] = True
except Exception as exc:
    report["passed"] = False
    report["error_type"] = type(exc).__name__
    raise
finally:
    report["elapsed_seconds"] = round(time.monotonic()-started, 2)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    # This process owns its own provider pools and unload hooks.
    manager = get_plugin_manager()
    for name in list(manager._plugins):
        manager.unload(name)
    print(json.dumps(report, ensure_ascii=True), flush=True)
