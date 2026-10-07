"""HTTP transport for the service adapter; credentials remain profile-scoped."""
import os
from urllib.parse import urlsplit
import requests as _requests
from .config import service_settings
RequestException = _requests.RequestException
exceptions = _requests.exceptions


def headers_for(url):
    target = urlsplit(url)
    matches = []
    for kind in ("stt", "tts"):
        service = service_settings(kind)
        if not service:
            continue
        base = service.get("url", "http://127.0.0.1:8000").rstrip("/")
        expected = urlsplit(base)
        if (target.scheme, target.netloc) != (expected.scheme, expected.netloc):
            continue
        if target.path != expected.path and not target.path.startswith(expected.path.rstrip("/") + "/"):
            continue
        matches.append((len(expected.path), service))
    if not matches:
        return {}
    service = max(matches, key=lambda item: item[0])[1]
    name = service.get("token_env", "HERMES_SPEECH_SERVICE_TOKEN")
    try:
        from agent.secret_scope import get_secret_str
        token = get_secret_str(name)
    except ImportError:
        token = os.getenv(name, "")
    return {"Authorization": "Bearer " + token} if token else {}


def request(method, url, **kwargs):
    headers = kwargs.pop("headers", None)
    if headers is None:
        headers = headers_for(url)
    # Redirects must not forward service credentials to another endpoint.
    kwargs.setdefault("allow_redirects", False)
    return _requests.request(method, url, headers=headers, **kwargs)


def get(url, **kwargs):
    return request("GET", url, **kwargs)


def post(url, **kwargs):
    return request("POST", url, **kwargs)

