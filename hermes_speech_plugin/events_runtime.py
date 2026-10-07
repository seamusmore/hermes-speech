"""Desktop metadata broker ownership; no subscribers or Avatar logic live here."""
import atexit
import importlib.util
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from .lifecycle import port_lock

_mutex = threading.RLock()
_owners = set()
_child = None
_output = None
_stop = threading.Event()
_worker = None


def health():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open("http://127.0.0.1:18794/health", timeout=.5) as response:
            body = json.load(response)
    except urllib.error.URLError:
        return None
    if body.get("protocol") != "speech-events" or body.get("version") != 1:
        raise RuntimeError("Speech metadata endpoint is occupied")
    return body


def _ensure(stop):
    global _child, _output
    if health():
        return
    root = Path(os.getenv("HERMES_HOME", str(Path.home()/".hermes"))) / "speech" / "runtime"
    root.mkdir(parents=True, exist_ok=True)
    with port_lock(root / "events.lock", time.monotonic()+4, stop):
        if health() or stop.is_set():
            return
        if _child is not None and _child.poll() is None:
            return
        if _output:
            _output.close()
        site_path = Path(importlib.util.find_spec("aiohttp").origin).parent.parent
        _output = (root / "events.log").open("ab")
        try:
            _child = subprocess.Popen([sys.executable, "-I", "-B", str(Path(__file__).with_name("events_entry.py")), str(site_path)],
                stdin=subprocess.PIPE, stdout=_output, stderr=_output,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except BaseException:
            _output.close()
            _output = None
            raise


def shutdown():
    global _child, _output, _worker
    with _mutex:
        _stop.set()
        if _worker:
            _worker.join(timeout=5)
            _worker = None
        if _child:
            if _child.stdin:
                _child.stdin.close()
            try:
                _child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                _child.terminate()
                _child.wait(timeout=3)
            _child = None
        if _output:
            _output.close()
            _output = None
        _owners.clear()


def activate(ctx):
    global _worker, _stop
    desktop = Path(ctx.manifest.path).parent.parent / "desktop-plugins"
    if not desktop.is_dir():
        return
    owner = object()
    with _mutex:
        _owners.add(owner)
        if _worker is None or not _worker.is_alive():
            _stop = stop = threading.Event()
            def supervise():
                previous = None
                while not stop.is_set():
                    try:
                        _ensure(stop)
                        previous = None
                    except Exception as exc:
                        message = type(exc).__name__
                        if message != previous:
                            logging.getLogger(__name__).warning("Speech events unavailable: %s", message)
                        previous = message
                    stop.wait(5)
            _worker = threading.Thread(target=supervise, name="speech-events", daemon=True)
            _worker.start()
    def unload():
        with _mutex:
            _owners.discard(owner)
            if not _owners:
                shutdown()
    ctx.on_unload(unload)


atexit.register(shutdown)

