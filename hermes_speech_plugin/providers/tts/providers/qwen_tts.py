"""Qwen Audio Flash streaming TTS over the raw DashScope WebSocket API."""

from __future__ import annotations

import json
import logging
import math
import os
import time
from typing import Any, Dict, Iterator
from uuid import uuid4

from websockets.sync.client import connect
import sys
import queue
import threading
from ....cloud_pool import TaskPool
_POOL = TaskPool()

def warm(config):
    return _POOL.warm(config, websocket_url(config), _api_key(config), connect)

def retain_warm(config):
    _POOL.retain_warm(config, websocket_url(config), _api_key(config), connect)

def release():
    _POOL.release()


logger = logging.getLogger(__name__)

QWEN_TTS_MODEL = "qwen-audio-3.1-tts-flash"
SUPPORTED_QWEN_TTS_MODELS = frozenset({
    "qwen-audio-3.0-tts-flash",
    "qwen-audio-3.1-tts-flash",
})
DEFAULT_SAMPLE_RATE = 24000
MIN_RATE = 0.5
MAX_RATE = 2.0


def _secret(name):
    try:
        from agent.secret_scope import get_secret_str
    except ImportError:
        return os.getenv(name, '')  # standalone probe without Hermes installed
    return get_secret_str(name)


def _setting(value: Any, env_name: str) -> str:
    raw = str(value or "").strip()
    if raw.startswith("${") and raw.endswith("}"):
        return _secret(raw[2:-1]).strip()
    return raw or _secret(env_name).strip()


def websocket_url(config: Dict[str, Any]) -> str:
    explicit = _setting(config.get("websocket_url"), "QWEN_TTS_WEBSOCKET_URL")
    if explicit:
        return explicit
    workspace_id = _setting(config.get("workspace_id"), "DASHSCOPE_WORKSPACE_ID")
    region = str(config.get("region", "beijing")).strip().lower()
    hosts = {
        "beijing": "cn-beijing.maas.aliyuncs.com",
        "cn-beijing": "cn-beijing.maas.aliyuncs.com",
        "singapore": "ap-southeast-1.maas.aliyuncs.com",
        "ap-southeast-1": "ap-southeast-1.maas.aliyuncs.com",
    }
    try:
        host = hosts[region]
    except KeyError as exc:
        raise RuntimeError(f"Unsupported Qwen region: {region}") from exc
    if workspace_id:
        return f"wss://{workspace_id}.{host}/api-ws/v1/inference"
    public_hosts = {
        "beijing": "dashscope.aliyuncs.com",
        "cn-beijing": "dashscope.aliyuncs.com",
        "singapore": "dashscope-intl.aliyuncs.com",
        "ap-southeast-1": "dashscope-intl.aliyuncs.com",
    }
    return f"wss://{public_hosts[region]}/api-ws/v1/inference"


def credentials_available(config: Dict[str, Any]) -> bool:
    key_env = str(config.get("api_key_env", "DASHSCOPE_API_KEY"))
    key = _setting(config.get("api_key"), key_env)
    return bool(key)


def _api_key(config: Dict[str, Any]) -> str:
    key_env = str(config.get("api_key_env", "DASHSCOPE_API_KEY"))
    key = _setting(config.get("api_key"), key_env)
    if not key:
        raise RuntimeError(f"Qwen TTS requires {key_env}")
    return key


def _event(message: Any) -> Dict[str, Any]:
    try:
        return json.loads(message)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Qwen TTS returned invalid JSON") from exc


def _error(event: Dict[str, Any]) -> str:
    header = event.get("header") or {}
    payload = event.get("payload") or {}
    return str(header.get("error_message") or payload.get("message") or "Qwen TTS task failed")


def resolve_rate(config: Dict[str, Any]) -> float:
    """Return the shared Qwen speech-rate multiplier for every TTS path."""
    try:
        rate = float(config.get("rate", 1.0))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Qwen TTS rate must be a number between 0.5 and 2.0") from exc
    if not math.isfinite(rate) or not MIN_RATE <= rate <= MAX_RATE:
        raise RuntimeError("Qwen TTS rate must be between 0.5 and 2.0")
    return rate


def stream_pcm(text: str, config: Dict[str, Any], *, stop_event=None) -> Iterator[bytes]:
    model = str(config.get("model") or QWEN_TTS_MODEL)
    if model not in SUPPORTED_QWEN_TTS_MODELS:
        supported = ", ".join(sorted(SUPPORTED_QWEN_TTS_MODELS))
        raise RuntimeError(f"Unsupported http-speech Qwen model: {model}; supported: {supported}")
    voice = str(config.get("voice") or "").strip()
    if not voice:
        raise RuntimeError("Qwen TTS requires a voice ID")
    sample_rate = int(config.get("sample_rate", DEFAULT_SAMPLE_RATE))
    if sample_rate != DEFAULT_SAMPLE_RATE:
        raise RuntimeError("Qwen TTS PCM playback is locked to 24000 Hz")
    task_id = str(uuid4())
    timeout = float(config.get("timeout_seconds", 60))
    rate = resolve_rate(config)
    parameters = {
        "text_type": "PlainText",
        "voice": voice,
        "format": "pcm",
        "sample_rate": sample_rate,
        "volume": int(config.get("volume", 50)),
        "rate": rate,
        "pitch": float(config.get("pitch", 1)),
        "enable_ssml": False,
    }
    run_task = {
        "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
        "payload": {
            "task_group": "audio",
            "task": "tts",
            "function": "SpeechSynthesizer",
            "model": model,
            "parameters": parameters,
            "input": {},
        },
    }
    # The worker owns the socket; the consumer always gets a cancellation checkpoint.
    started = time.perf_counter()
    # One generator serves ONE sentence. The caller's stop_event (e.g. the chained
    # endpoint's whole-session stop) is read-only here: this sentence completing,
    # timing out or failing must never mark the caller's session stopped, or every
    # later sentence of that session is silently skipped. All exit points observe
    # the merged view; the finally below sets only the internal event.
    internal_stop = threading.Event()
    session_stop = stop_event

    class _MergedStop:
        def is_set(self):
            return internal_stop.is_set() or (session_stop is not None and session_stop.is_set())

    stop = _MergedStop()
    first_pcm_deadline = timeout if session_stop is not None else min(timeout, 5)
    output = queue.Queue(maxsize=8)
    done = threading.Event()
    errors = []
    def worker():
        lease = None
        completed = False
        sent = False
        first_pcm = True
        try:
            lease = _POOL.acquire(config, websocket_url(config), _api_key(config), connect, stop)
            socket = lease.socket
            logger.info("qwen_tts_connection task_id=%s connection_id=%s reused=%s handshake_ms=%.2f acquire_ms=%.2f",
                        task_id, lease.connection_id, lease.reused, lease.handshake_ms, (time.perf_counter()-started)*1000)
            if stop.is_set(): return
            socket.send(json.dumps(run_task, ensure_ascii=False))
            sent = True
            phase = 'starting'
            deadline = time.monotonic() + timeout
            while not stop.is_set():
                if time.monotonic() > deadline: raise TimeoutError("Qwen TTS task timed out")
                if first_pcm and time.perf_counter()-started > first_pcm_deadline:
                    raise TimeoutError("Qwen TTS first PCM deadline exceeded")
                try: message = socket.recv(timeout=.05)
                except TimeoutError: continue
                # recv may return after the caller cancelled the session.
                if stop.is_set(): break
                deadline = time.monotonic() + timeout
                if isinstance(message, bytes):
                    if phase != 'audio': raise RuntimeError("Qwen PCM before matching task-started")
                    if message:
                        if first_pcm:
                            first_pcm = False
                            logger.info("qwen_tts_first_pcm task_id=%s elapsed_ms=%.2f", task_id, (time.perf_counter()-started)*1000)
                        while not stop.is_set():
                            try: output.put(message, timeout=.05); break
                            except queue.Full: pass
                    continue
                event = _event(message)
                header = event.get('header') or {}
                if header.get('task_id') != task_id:
                    raise RuntimeError("Qwen TTS task identity mismatch")
                name = header.get('event')
                if name == 'task-failed': raise RuntimeError(_error(event))
                if name == 'task-started' and phase == 'starting':
                    phase = 'audio'
                    if stop.is_set(): break
                    socket.send(json.dumps({
                        'header': {'action': 'continue-task', 'task_id': task_id, 'streaming': 'duplex'},
                        'payload': {'input': {'text': text}}}, ensure_ascii=False))
                    if stop.is_set(): break
                    socket.send(json.dumps({
                        'header': {'action': 'finish-task', 'task_id': task_id, 'streaming': 'duplex'},
                        'payload': {'input': {}}}))
                if name == 'task-finished':
                    completed = True
                    break
            if stop.is_set() and not completed and sent:
                socket.send(json.dumps({
                    'header': {'action': 'finish-task', 'task_id': task_id, 'streaming': 'duplex'},
                    'payload': {'input': {'directive': 'cancel'}}}))
                deadline = time.monotonic() + .8
                while time.monotonic() < deadline:
                    try: message = socket.recv(timeout=.05)
                    except TimeoutError: continue
                    if isinstance(message, bytes): continue  # Drain canceled PCM; never deliver it.
                    header = (_event(message).get('header') or {})
                    if header.get('task_id') != task_id: break
                    if header.get('event') == 'task-failed': break
                    if header.get('event') == 'task-finished':
                        completed = True
                        break
        except Exception as exc:
            if not stop.is_set(): errors.append(exc)
        finally:
            # Deliberately NOT setting internal_stop here: the consumer drains the
            # output queue after this worker finishes (its loop checks stop BEFORE
            # each drain step), and a stop set here makes it abandon ready PCM.
            # The internal event is the consumer->worker signal only.
            if lease: _POOL.put(lease, config, completed)
            done.set()
    from contextvars import copy_context
    context = copy_context()
    thread = threading.Thread(target=lambda: context.run(worker), name='qwen-tts-task', daemon=True)
    thread.start()
    audible = False
    try:
        while not done.is_set() or not output.empty():
            if stop.is_set(): return
            if not audible and time.perf_counter()-started > first_pcm_deadline:
                raise TimeoutError("Qwen TTS first PCM deadline exceeded")
            try:
                block = output.get(timeout=.05)
                if stop.is_set(): return
                audible = audible or bool(block)
                yield block
            except queue.Empty:
                if audible and not done.is_set(): yield b''
        if errors: raise errors[0]
    finally:
        # End only THIS sentence. The caller's session event is read-only: setting it
        # here is exactly the cross-sentence poisoning bug (see chained endpoint review).
        internal_stop.set()
        # Socket work has bounded connect / cancel / close deadlines.
        thread.join(timeout=5.5)

