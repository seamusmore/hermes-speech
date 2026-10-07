"""Shared runtime for the plugin loader and its separately imported HTTP API."""
import atexit
import logging
import threading
from .lifecycle import BridgeManager, BridgeStartupError
from .signal_bridge import BridgeConfig

_mutex = threading.RLock()
_manager = None
_owners = set()

def activate():
    global _manager
    owner = object()
    with _mutex:
        if _manager is None or _manager.closed.is_set():
            _manager = BridgeManager(BridgeConfig.from_config())
        _owners.add(owner)
        manager = _manager
    def unload():
        with _mutex:
            _owners.discard(owner)
            if not _owners and _manager is manager:
                manager.close()
    return manager, unload

def ensure():
    with _mutex:
        manager = _manager
    if manager is None or manager.closed.is_set():
        raise BridgeStartupError("Qwen bridge backend plugin is not loaded; restart Hermes once after installation")
    return manager.ensure()

def shutdown():
    with _mutex:
        if _manager is not None: _manager.close()
        _owners.clear()

atexit.register(shutdown)

