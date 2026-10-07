"""HTTP transport for the service adapter; credentials remain profile-scoped."""
import os
from urllib.parse import urlsplit
import requests as _requests
from .config import settings
RequestException = _requests.RequestException
exceptions = _requests.exceptions


def headers_for(url):
    service = settings().get("service") or {}
    base = service.get("url", "http://127.0.0.1:8000").rstrip("/")
    target = urlsplit(url)
    expected = urlsplit(base)
    if (target.scheme, target.netloc) != (expected.scheme, expected.netloc):
        return {}
    if target.path != expected.path and not target.path.startswith(expected.path.rstrip("/") + "/"):
        return {}
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

