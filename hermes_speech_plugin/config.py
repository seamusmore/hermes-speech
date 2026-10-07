"""Provider selection, independent of desktop state. Legacy keys remain readable."""
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
    full = load_full() if full is None else full
    legacy = deepcopy((full.get(kind) or {}).get("http_" + kind) or {})
    unified = settings(full)
    selected = unified.get(kind) or {}
    provider = selected.get("backend", unified.get("backend", selected.get("provider", legacy.get("backend", "service"))))
    if provider == "local":
        provider = "service"
    if provider not in ("qwen", "service"):
        raise ValueError("Unsupported speech provider: " + str(provider))
    result = {**legacy, **{k: deepcopy(v) for k, v in selected.items() if k != "provider"}}
    result["backend"] = "qwen" if provider == "qwen" else "local"
    result["qwen"] = {**(legacy.get("qwen") or {}), **(selected.get("qwen") or {})}
    if provider == "service":
        service = unified.get("service") or {}
        # Explicit unified settings opt into the merged service; old configs keep their URL.
        if service.get("url"):
            result["service_url"] = validate_service_url(service.get("url", "http://127.0.0.1:8000")) + "/" + kind
        elif selected.get("service_url"):
            result["service_url"] = validate_service_url(selected["service_url"])
        elif selected or "backend" in unified:
            result["service_url"] = "http://127.0.0.1:8000/" + kind
        elif result.get("service_url"):
            result["service_url"] = validate_service_url(result["service_url"])
        else:
            result["service_url"] = "http://127.0.0.1:8000/" + kind
    return result


def migrate_provider_config(full):
    """Normalize provider IDs and backend selection without changing other settings."""
    out = deepcopy(full)
    options = settings(full)
    resolved = {kind: provider_config(kind, full) for kind in ("stt", "tts")}
    backends = {kind: "qwen" if cfg["backend"] == "qwen" else "service" for kind, cfg in resolved.items()}
    options["backend"] = backends["stt"]
    for kind in ("stt", "tts"):
        section = out.setdefault(kind, {})
        if section.get("provider") in (None, "", "http_" + kind, PROVIDER_ID):
            section["provider"] = PROVIDER_ID
        streaming = section.get("streaming")
        if isinstance(streaming, dict) and streaming.get("provider") == "http_" + kind:
            streaming["provider"] = PROVIDER_ID
        selected = deepcopy(options.get(kind) or {})
        selected.pop("provider", None)
        selected.pop("backend", None)
        if backends[kind] != options["backend"]:
            selected["backend"] = backends[kind]
        # Preserve legacy service URLs until the user explicitly configures a shared service URL.
        if backends[kind] == "service" and not (options.get("service") or {}).get("url"):
            selected["service_url"] = resolved[kind]["service_url"]
        if selected:
            options[kind] = selected
        else:
            options.pop(kind, None)
    out.setdefault("plugins", {}).setdefault("entries", {}).setdefault(PLUGIN_ID, {})["settings"] = options
    return out


def migrate_config(full, service_url="http://127.0.0.1:8000"):
    """Pure migration. No filesystem, secret resolution or process side effects."""
    out = deepcopy(full)
    previous = settings(full)
    service = {**previous.get("service", {}), "url": validate_service_url(service_url)}
    service.setdefault("managed", False)
    service.setdefault("token_env", "HERMES_SPEECH_SERVICE_TOKEN")
    migrated = {**previous, "service": service}
    for kind in ("stt", "tts"):
        old = deepcopy((full.get(kind) or {}).get("http_" + kind) or {})
        prior = previous.get(kind) or {}
        provider = prior.get("provider", old.get("backend", "service"))
        provider = "service" if provider == "local" else provider
        if provider not in ("service", "qwen"):
            raise ValueError("Unsupported provider in migration")
        migrated[kind] = {**old, **prior, "provider": provider}
        migrated[kind].pop("backend", None)
        migrated[kind].pop("service_url", None)
        if provider == "service":
            out.setdefault(kind, {}).setdefault("http_" + kind, {})["service_url"] = service["url"] + "/" + kind
    plugins = out.setdefault("plugins", {})
    old_ids = {"http-stt", "http-tts", "qwen-realtime-bridge", "speech-chained"}
    enabled = plugins.get("enabled") or []
    plugins["enabled"] = list(dict.fromkeys([name for name in enabled if name not in old_ids] + [PLUGIN_ID]))
    plugins["disabled"] = list(dict.fromkeys([name for name in plugins.get("disabled", []) if name != PLUGIN_ID] + sorted(old_ids)))
    entry = plugins.setdefault("entries", {}).setdefault(PLUGIN_ID, {})
    entry["settings"] = migrated
    return out
