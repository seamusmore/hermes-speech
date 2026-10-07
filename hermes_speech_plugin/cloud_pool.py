"""Exclusive DashScope task leases. Only acknowledged terminal tasks return to idle."""
import hashlib
import json
import threading
import time
from dataclasses import dataclass, field
from uuid import uuid4

@dataclass
class Lease:
    socket: object
    key: str
    generation: int
    connection_id: str = field(default_factory=lambda: uuid4().hex[:12])
    reused: bool = False
    handshake_ms: float = 0
    timer: object = None
    born: float = field(default_factory=time.monotonic)

class TaskPool:
    def __init__(self, limit=4):
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(limit)
        self.idle = {}
        self.generation = 0
        self.warmers = {}
        self.retired = set()

    @staticmethod
    def key(config, url, key):
        # Include resolved authentication and profile, not just the endpoint.
        value = json.dumps([config, url, key], sort_keys=True, default=str)
        return hashlib.sha256(value.encode()).hexdigest()

    @staticmethod
    def close_socket(socket):
        try: socket.close()
        except Exception: pass

    def acquire(self, config, url, key, connector, stop=None):
        deadline = time.monotonic() + min(float(config.get('timeout_seconds', 60)), 10)
        while not self.slots.acquire(timeout=.05):
            if stop and stop.is_set(): raise InterruptedError()
            if time.monotonic() >= deadline: raise TimeoutError('Qwen connection pool is busy')
        lease = None
        try:
            if stop and stop.is_set(): raise InterruptedError()
            identity = self.key(config, url, key)
            with self.lock:
                generation = self.generation
                entries = self.idle.get(identity, [])
                lease = entries.pop() if entries else None
                if lease and lease.timer: lease.timer.cancel()
            if lease:
                try:
                    if time.monotonic()-lease.born >= 50: raise TimeoutError('Qwen connection age limit')
                    if not lease.socket.ping().wait(.5): raise TimeoutError('Qwen stale socket')
                    lease.reused = True
                    lease.handshake_ms = 0
                except Exception:
                    self.close_socket(lease.socket)
                    lease = None
            if lease is None:
                start = time.perf_counter()
                socket = connector(url, additional_headers={
                    'Authorization': f'bearer {key}', 'X-DashScope-DataInspection': 'enable'},
                    open_timeout=min(float(config.get('connect_timeout_seconds', 3)), 5),
                    close_timeout=.2, max_size=None)
                lease = Lease(socket, identity, generation, handshake_ms=(time.perf_counter()-start)*1000)
            if stop and stop.is_set(): raise InterruptedError()
            return lease
        except BaseException:
            if lease: self.close_socket(lease.socket)
            self.slots.release()
            raise

    def put(self, lease, config, reusable):
        try:
            with self.lock:
                if reusable and lease.generation == self.generation and lease.key not in self.retired:
                    # Vendor idle timeout is 60 seconds. Expire proactively below it.
                    seconds = max(.05, min(float(config.get('idle_seconds', 30)), 50))
                    self.idle.setdefault(lease.key, []).append(lease)
                    def expire():
                        with self.lock:
                            entries = self.idle.get(lease.key, [])
                            if lease.timer is not timer or lease not in entries: return
                            entries.remove(lease)
                        self.close_socket(lease.socket)
                    timer = threading.Timer(seconds, expire)
                    lease.timer = timer
                    lease.timer.daemon = True
                    lease.timer.start()
                    return
            self.close_socket(lease.socket)
        finally:
            self.slots.release()

    def warm(self, config, url, key, connector):
        lease = self.acquire(config, url, key, connector)
        self.put(lease, config, True)
        return {'connection_id': lease.connection_id, 'reused': lease.reused, 'handshake_ms': lease.handshake_ms}

    def retain_warm(self, config, url, key, connector):
        identity = self.key(config, url, key)
        scope = str(config.get('_profile_scope', 'default'))
        retired = []
        with self.lock:
            if identity in self.warmers: return
            for old, (old_stop, old_scope) in list(self.warmers.items()):
                if old_scope == scope:
                    old_stop.set()
                    self.warmers.pop(old)
                    self.retired.add(old)
                    retired.extend(self.idle.pop(old, []))
            self.retired.discard(identity)
            stop = threading.Event()
            self.warmers[identity] = (stop, scope)
        for lease in retired:
            if lease.timer: lease.timer.cancel()
            self.close_socket(lease.socket)
        def refresh():
            while not stop.is_set():
                try:
                    lease = self.acquire(config, url, key, connector, stop)
                    self.put(lease, config, not stop.is_set())
                except Exception:
                    pass  # Actual requests surface their errors; warm is best effort.
                if stop.wait(20): break
        thread = threading.Thread(target=refresh, name='qwen-cloud-preconnect', daemon=True)
        thread.start()

    def release(self):
        with self.lock:
            self.generation += 1
            for stop, _scope in self.warmers.values(): stop.set()
            self.warmers.clear()
            leases = [lease for entries in self.idle.values() for lease in entries]
            self.idle.clear()
        for lease in leases:
            if lease.timer: lease.timer.cancel()
            self.close_socket(lease.socket)
        # In-flight tasks retain exclusive ownership, but cannot re-enter this generation.

