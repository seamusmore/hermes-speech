"""Local Hermes-compatible WebRTC signaling relay for Qwen Audio Realtime."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Mapping, Optional, Tuple
from uuid import uuid4

from . import REALTIME_MODEL

SERVICE_ID = "hermes-qwen-realtime-bridge"
HEALTH_VERSION = 1

SUPPORTED_REALTIME_MODELS = (REALTIME_MODEL, "qwen-audio-3.1-realtime-plus")


@dataclass(frozen=True)
class BridgeConfig:
    api_key: str
    workspace_id: str = ""
    region: str = "beijing"
    local_token: str = ""
    model: str = REALTIME_MODEL
    timeout_seconds: float = 30.0
    endpoint_url: str = ""

    @classmethod
    def from_config(cls) -> "BridgeConfig":
        from .config import load_full
        live = (load_full().get("voice") or {}).get("gpt_live") or {}
        qwen = live.get("qwen") or {}
        from agent.secret_scope import get_secret_str
        def secret(name):
            return get_secret_str(name).strip()
        return cls(
            api_key=secret(str(qwen.get("api_key_env", "DASHSCOPE_API_KEY"))),
            workspace_id=str(qwen.get("workspace_id") or secret("DASHSCOPE_WORKSPACE_ID")),
            region=str(qwen.get("region", "beijing")),
            local_token=str(live.get("api_key") or ""),
            model=str(live.get("model") or REALTIME_MODEL),
            timeout_seconds=float(qwen.get("timeout_seconds", 30)),
            endpoint_url=str(qwen.get("endpoint_url") or ""),
        )

    def validate(self) -> None:
        if not self.api_key:
            raise RuntimeError("The cloud API key selected by voice.gpt_live.qwen.api_key_env is required")
        if self.model not in SUPPORTED_REALTIME_MODELS:
            raise ValueError(f"Unsupported Qwen Realtime model: {self.model}")
        if not self.workspace_id and not self.endpoint_url:
            raise ValueError("WebRTC requires voice.gpt_live.qwen.workspace_id or endpoint_url")

    @property
    def upstream_url(self) -> str:
        if self.endpoint_url:
            base = self.endpoint_url.rstrip("?")
            separator = "&" if "?" in base else "?"
            return f"{base}{separator}{urllib.parse.urlencode({'model': self.model})}"
        hosts = {
            "beijing": "cn-beijing.maas.aliyuncs.com",
            "cn-beijing": "cn-beijing.maas.aliyuncs.com",
            "singapore": "ap-southeast-1.maas.aliyuncs.com",
            "ap-southeast-1": "ap-southeast-1.maas.aliyuncs.com",
        }
        try:
            host = hosts[self.region.lower()]
        except KeyError as exc:
            raise RuntimeError(f"Unsupported Qwen region: {self.region}") from exc
        if self.workspace_id:
            endpoint = f"https://{self.workspace_id}.{host}/api/v1/webrtc/realtime"
        else:
            raise ValueError("WebRTC requires a workspace-specific API host")
        query = urllib.parse.urlencode({"model": self.model})
        return f"{endpoint}?{query}"


def config_identity(config: BridgeConfig) -> str:
    payload = json.dumps([config.model, config.upstream_url, config.api_key], separators=(",", ":"))
    return hmac.new(config.local_token.encode(), payload.encode(), hashlib.sha256).hexdigest()


def health_proof(token: str, challenge: str, identity: str, instance: str) -> str:
    return hmac.new(token.encode(), f"{challenge}:{identity}:{instance}".encode(), hashlib.sha256).hexdigest()


Exchange = Callable[[str, str, Mapping[str, str], float], Tuple[int, str]]


def exchange_sdp(url: str, offer_sdp: str, headers: Mapping[str, str], timeout: float) -> Tuple[int, str]:
    request = urllib.request.Request(
        url,
        data=offer_sdp.encode("utf-8"),
        headers=dict(headers),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")


def _extract_offer(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    candidates = [
        payload.get("sdp"),
        (payload.get("transport") or {}).get("sdp") if isinstance(payload.get("transport"), dict) else None,
        (payload.get("offer") or {}).get("sdp") if isinstance(payload.get("offer"), dict) else None,
    ]
    return next((str(value) for value in candidates if value), "")


def create_handler(config: BridgeConfig, exchange: Exchange = exchange_sdp, *, instance_id: str = ""):
    config.validate()
    instance = instance_id or uuid4().hex
    identity = config_identity(config)

    class Handler(BaseHTTPRequestHandler):
        server_version = "HermesQwenBridge/0.1"

        def _json(self, status: int, payload: object) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()

        def do_GET(self) -> None:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == "/health":
                challenge = urllib.parse.parse_qs(parsed.query).get("challenge", [""])[0][:128]
                self._json(200, {"ok": True, "model": config.model,
                    "service": SERVICE_ID, "health_version": HEALTH_VERSION,
                    "config_id": identity, "instance": instance,
                    "proof": health_proof(config.local_token, challenge, identity, instance)})
                return
            self._json(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:
            if self.path.split("?", 1)[0] != "/v1/live/sessions":
                self._json(404, {"ok": False, "error": "not_found"})
                return
            if config.local_token:
                expected = f"Bearer {config.local_token}"
                if self.headers.get("Authorization", "") != expected:
                    self._json(401, {"ok": False, "error": "unauthorized"})
                    return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                self._json(400, {"ok": False, "error": "invalid_json"})
                return
            offer_sdp = _extract_offer(payload)
            if not offer_sdp:
                self._json(400, {"ok": False, "error": "missing_sdp"})
                return
            try:
                status, answer = exchange(
                    config.upstream_url,
                    offer_sdp,
                    {
                        "Authorization": f"Bearer {config.api_key}",
                        "Content-Type": "application/sdp",
                    },
                    config.timeout_seconds,
                )
            except (OSError, TimeoutError, urllib.error.URLError):
                self._json(502, {"ok": False, "error": "upstream_unavailable"})
                return
            if status != 200:
                self._json(502, {"ok": False, "error": "upstream_signaling_failed", "status": status})
                return
            self._json(200, {
                "ok": True,
                "session": {"id": uuid4().hex, "model": config.model},
                "transport": {"type": "webrtc", "sdp": answer},
            })

        def log_message(self, fmt: str, *args: object) -> None:
            # Keep API keys and SDP bodies out of logs.
            print("bridge", self.address_string(), fmt % args)

    return Handler


def serve(host: str, port: int, config: Optional[BridgeConfig] = None) -> None:
    if host != "127.0.0.1":
        raise ValueError("Bridge must bind to 127.0.0.1")
    active = config or BridgeConfig.from_config()
    server = ThreadingHTTPServer((host, port), create_handler(active))
    print(f"Hermes Qwen signaling bridge listening on http://{host}:{port}")
    print(f"Realtime model: {active.model}")
    server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
