"""Optional local process ownership shared by profiles."""
import atexit
import os
from pathlib import Path
import subprocess
import threading
from urllib.parse import urlsplit
from .config import provider_config, settings

_lock = threading.RLock()
_owned = {}


def _close(entry):
    child, output = entry["child"], entry["output"]
    try:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
    finally:
        output.close()


def shutdown():
    with _lock:
        for entry in list(_owned.values()):
            _close(entry)
        _owned.clear()


def activate(ctx):
    options = settings().get("service") or {}
    if not options.get("managed") or all(provider_config(k)["backend"] == "qwen" for k in ("stt", "tts")):
        return
    base = options.get("url", "http://127.0.0.1:8000").rstrip("/")
    url = urlsplit(base)
    if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1") or url.path:
        raise ValueError("Only a loopback service root can be managed by the plugin")
    executable = Path(options["python"]).expanduser().resolve()
    root = Path(options["path"]).expanduser().resolve()
    if not executable.is_file() or not (root / "run.py").is_file():
        raise ValueError("Managed speech service requires valid python and path settings")
    identity = (str(executable), str(root), tuple(sorted((options.get("environment") or {}).items())))
    endpoint = ("loopback", url.port or 8000)
    from . import http_client
    with _lock:
        entry = _owned.get(endpoint)
        if entry is not None and entry["child"].poll() is not None:
            _close(entry)
            del _owned[endpoint]
            entry = None
        if entry is not None:
            if entry["identity"] != identity:
                raise ValueError("Profiles sharing a service endpoint must use matching launch settings")
        else:
            try:
                response = http_client.get(base + "/health", timeout=1)
            except http_client.RequestException:
                response = None
            if response is not None:
                with response:
                    if response.status_code != 200 or response.json().get("service") != "hermes-speech-service":
                        raise RuntimeError("Service endpoint is occupied by another application")
                return
            env = dict(os.environ)
            env.pop("PYTHONPATH", None)
            env.pop("PYTHONHOME", None)
            for key, value in (options.get("environment") or {}).items():
                env[str(key)] = str(value)
            headers = http_client.headers_for(base)
            if headers.get("Authorization", "").startswith("Bearer "):
                env["HERMES_SPEECH_SERVICE_TOKEN"] = headers["Authorization"][7:]
            logs = Path(os.getenv("HERMES_HOME", str(Path.home()/".hermes"))) / "logs"
            logs.mkdir(parents=True, exist_ok=True)
            output = (logs / "hermes-speech-service.log").open("ab")
            try:
                child = subprocess.Popen([str(executable), "-B", str(root/"run.py"), "--host", url.hostname,
                                          "--port", str(url.port or 8000)], cwd=root, env=env,
                                         stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except BaseException:
                output.close()
                raise
            entry = {"child": child, "output": output, "owners": set(), "identity": identity}
            _owned[endpoint] = entry
        owner = object()
        entry["owners"].add(owner)

    def unload():
        with _lock:
            entry["owners"].discard(owner)
            if not entry["owners"] and _owned.get(endpoint) is entry:
                del _owned[endpoint]
                _close(entry)
    ctx.on_unload(unload)


atexit.register(shutdown)
