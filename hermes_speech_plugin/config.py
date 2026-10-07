"""Unified speech configuration, independent of desktop state."""
from copy import deepcopy
from urllib.parse import urlsplit

PLUGIN_ID = "hermes-speech"
PROVIDER_ID = "http-speech"


def load_full():
    from hermes_cli.config import load_config
    return load_config()


def settings(full=None):
    full = load_full() if full is None else full
    entry = ((full.get("plugins") or {}).get("entries") or {}).get(PLUGIN_ID) or {}
    return deepcopy(entry.get("settings") or {})


def validate_service_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Speech service URL must be an HTTP(S) base URL without credentials or query")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Remote speech services require HTTPS")
    return url.rstrip("/")


def provider_config(kind, full=None):
    if kind not in ("stt", "tts"):
        raise ValueError("Unknown speech capability")
    unified = settings(full)
    selected = unified.get(kind) or {}
    backend = selected.get("backend", unified.get("backend", "service"))
    if backend not in ("qwen", "service"):
        raise ValueError("Unsupported speech backend: " + str(backend))
    result = {k: deepcopy(v) for k, v in selected.items() if k != "provider"}
    result["backend"] = "qwen" if backend == "qwen" else "local"
    result["qwen"] = deepcopy(selected.get("qwen") or {})
    if backend == "service":
        service = unified.get("service") or {}
        result["service_url"] = validate_service_url(service.get("url", "http://127.0.0.1:8000")) + "/" + kind
    return result
