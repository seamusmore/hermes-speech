"""Bounded plugin-owned bridge lifecycle, with cross-process launch serialization."""
from __future__ import annotations
from contextlib import contextmanager
from dataclasses import asdict
import hmac
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from .signal_bridge import BridgeConfig, SERVICE_ID, config_identity, health_proof

log = logging.getLogger(__name__)

class BridgeStartupError(RuntimeError):
    pass

@contextmanager
def port_lock(path, deadline, stopped):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if path.stat().st_size == 0:
            handle.write(b"0"); handle.flush()
        acquired = False
        try:
            while not acquired:
                if stopped.is_set(): raise BridgeStartupError("Bridge plugin was unloaded")
                if time.monotonic() >= deadline: raise BridgeStartupError("Timed out waiting for bridge startup lock")
                try:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except OSError:
                    stopped.wait(0.05)
            yield
        finally:
            if acquired:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_UN)

class BridgeManager:
    def __init__(self, config, *, root=None, port=8765, timeout=12.0, command=None):
        self.config = config
        self.root = Path(root or Path(os.getenv("HERMES_HOME", str(Path.home()/".hermes"))) / "speech")
        self.port = int(port)
        self.timeout = float(timeout)
        self.command = command
        self.child = None
        self._log_handle = None
        self._mutex = threading.Lock()
        self.closed = threading.Event()
        self.log_path = self.root / "runtime" / f"bridge-{self.port}.log"
        self.last_error = None
        self.last_result = None
        self._owned_instance = None

    def _http(self, path, deadline, *, token=None, data=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise BridgeStartupError("Bridge readiness deadline expired")
        headers = {} if token is None else {"Authorization": "Bearer " + token}
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}" + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=min(0.4, remaining)) as response:
                return response.status, response.headers, json.loads(response.read(32768))
        except urllib.error.HTTPError as response:
            with response:
                try: body = json.loads(response.read(32768))
                except (ValueError, UnicodeError): body = {}
                return response.code, response.headers, body

    def _probe(self, deadline):
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=min(0.2, max(.01, deadline-time.monotonic()))): pass
        except ConnectionRefusedError:
            return None
        except OSError as exc:
            # Windows may delay ECONNREFUSED beyond a short connect timeout.
            # An exclusive bind distinguishes a genuinely free port safely.
            try:
                with socket.socket() as reservation:
                    if os.name == "nt": reservation.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                    else: reservation.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    reservation.bind(("127.0.0.1", self.port))
                return None
            except OSError:
                pass
            raise BridgeStartupError(f"Cannot inspect loopback port {self.port}: {type(exc).__name__}") from None
        try:
            challenge = secrets.token_hex(16)
            status, headers, body = self._http("/health?challenge=" + challenge, deadline)
            if status == 404:
                # Version 0.1 was already running before lifecycle support. Verify its
                # exact response and knowledge of our local token without issuing SDP.
                status, headers, body = self._http("/health", deadline)
                if status == 200 and body == {"ok": True, "model": self.config.model} and "HermesQwenBridge/0.1" in headers.get("Server", ""):
                    bad, _, _ = self._http("/v1/live/sessions", deadline, token=secrets.token_hex(24), data=b"{}")
                    good, _, error = self._http("/v1/live/sessions", deadline, token=self.config.local_token, data=b"{}")
                    if bad == 401 and good == 400 and error.get("error") == "missing_sdp":
                        return {"ok": True, "identity": "legacy-authenticated", "model": self.config.model}
            if not isinstance(body, dict): raise ValueError("Invalid health response")
            identity = config_identity(self.config)
            if (status == 200 and body.get("ok") is True and body.get("service") == SERVICE_ID
                and body.get("config_id") == identity and body.get("health_version") == 1
                and hmac.compare_digest(str(body.get("proof", "")), health_proof(self.config.local_token, challenge, identity, str(body.get("instance", ""))))):
                return {"ok": True, "identity": "authenticated", "instance": body["instance"], "model": self.config.model}
        except (OSError, ValueError, urllib.error.URLError, TimeoutError):
            pass
        raise BridgeStartupError(f"Port {self.port} is occupied by an unready or different service/configuration; left untouched")

    def _stop_child(self):
        child, self.child = self.child, None
        if child is not None:
            if child.stdin:
                try: child.stdin.close()
                except OSError: pass
            try: child.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                child.terminate()
                try: child.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    child.kill(); child.wait(timeout=1.5)
        if self._log_handle:
            self._log_handle.close(); self._log_handle = None

    def ensure(self):
        deadline = time.monotonic() + self.timeout
        if not self._mutex.acquire(timeout=self.timeout):
            raise BridgeStartupError("Timed out waiting for in-process bridge startup")
        try:
            if self.closed.is_set(): raise BridgeStartupError("Bridge plugin was unloaded")
            try: self.config.validate()
            except (RuntimeError, ValueError) as exc: raise BridgeStartupError(str(exc)) from None
            if not self.config.local_token: raise BridgeStartupError("Managed bridge requires a local authentication token")
            with port_lock(self.root / "runtime" / f"bridge-{self.port}.lock", deadline, self.closed):
                if self.child is not None and self.child.poll() is not None: self._stop_child()
                existing = self._probe(deadline)
                if existing:
                    result = dict(existing, ownership="owned" if self.child else "external", port=self.port)
                    self.last_result = result; self.last_error = None
                    return result
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                self._log_handle = self.log_path.open("ab", buffering=0)
                command = self.command or [sys.executable, "-I", "-X", "utf8", "-B", "-u", str(Path(__file__).with_name("managed_entry.py")), str(self.port)]
                env = dict(os.environ)
                env.pop("PYTHONPATH", None); env.pop("PYTHONHOME", None)
                try:
                    self.child = subprocess.Popen(command, cwd=self.root, env=env, stdin=subprocess.PIPE,
                        stdout=self._log_handle, stderr=subprocess.STDOUT,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
                    self._owned_instance = secrets.token_hex(16)
                    self.child.stdin.write((json.dumps({"config": asdict(self.config), "instance": self._owned_instance}) + "\n").encode())
                    self.child.stdin.flush()
                    while time.monotonic() < deadline and not self.closed.is_set():
                        if self.child.poll() is not None:
                            raise BridgeStartupError(f"Bridge exited with code {self.child.returncode}; log: {self.log_path}")
                        try: ready = self._probe(deadline)
                        except BridgeStartupError: ready = None
                        if ready:
                            if ready.get("instance") != self._owned_instance:
                                raise BridgeStartupError(f"Port {self.port} was claimed by another service during startup; left untouched")
                            result = dict(ready, ownership="owned", port=self.port)
                            self.last_result = result; self.last_error = None
                            log.info("Bridge ready port=%s pid=%s", self.port, self.child.pid)
                            return result
                        self.closed.wait(0.05)
                    raise BridgeStartupError(f"Bridge readiness timed out or plugin unloaded; log: {self.log_path}")
                except BaseException:
                    self._stop_child()
                    raise
        except Exception as exc:
            # Keep credentials and arbitrary response bodies out of diagnostic surfaces.
            self.last_error = str(exc) if isinstance(exc, (BridgeStartupError, ValueError)) else f"Bridge startup failed: {type(exc).__name__}; log: {self.log_path}"
            raise BridgeStartupError(self.last_error) from None
        finally:
            self._mutex.release()

    def close(self):
        self.closed.set()
        # ensure() observes closed while polling and reaps any child before release.
        with self._mutex:
            self._stop_child()
