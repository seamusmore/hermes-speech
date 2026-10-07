"""Qwen Audio 3.0 Flash streaming ASR over the raw DashScope WebSocket API."""

from __future__ import annotations

import audioop
import json
import logging
import os
import time
import wave
from pathlib import Path
from typing import Any, Dict, Iterator, Optional
from uuid import uuid4

from websockets.sync.client import connect
import sys
from ....cloud_pool import TaskPool
_POOL = TaskPool()

def warm(config):
    return _POOL.warm(config, websocket_url(config), _api_key(config), connect)

def retain_warm(config):
    _POOL.retain_warm(config, websocket_url(config), _api_key(config), connect)

def release():
    _POOL.release()


logger = logging.getLogger(__name__)

QWEN_ASR_MODEL = "qwen-audio-3.0-asr-flash-streaming"
SUPPORTED_QWEN_ASR_MODELS = (
    QWEN_ASR_MODEL,
    "qwen-audio-3.1-asr-flash-streaming",
)
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_SILENCE_FRAME_MS = 20
DEFAULT_SILENCE_RMS_THRESHOLD = 180
DEFAULT_SILENCE_PEAK_THRESHOLD = 1000
DEFAULT_SILENCE_RECORDING_RMS_THRESHOLD = 350
DEFAULT_SILENCE_MIN_VOICED_MS = 200
DEFAULT_SILENCE_MIN_CONSECUTIVE_MS = 80


def _secret(name):
    try:
        from agent.secret_scope import get_secret_str
    except ImportError:
        return os.getenv(name, '')  # standalone probe without Hermes installed
    return get_secret_str(name)


def _setting(value: Any, env_name: str) -> str:
    """Resolve a literal setting or a ${NAME} environment reference."""
    raw = str(value or "").strip()
    if raw.startswith("${") and raw.endswith("}"):
        return _secret(raw[2:-1]).strip()
    return raw or _secret(env_name).strip()


def websocket_url(config: Dict[str, Any]) -> str:
    explicit = _setting(config.get("websocket_url"), "QWEN_ASR_WEBSOCKET_URL")
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
        raise RuntimeError(f"Qwen ASR requires {key_env}")
    return key


def _pcm_chunks(file_path: str, chunk_ms: int) -> Iterator[bytes]:
    """Decode Hermes audio to 16 kHz, signed 16-bit, mono PCM chunks."""
    path = Path(file_path)
    if path.suffix.lower() != ".wav":
        yield from _av_pcm_chunks(path, chunk_ms)
        return
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        state = None
        target_bytes = max(320, DEFAULT_SAMPLE_RATE * 2 * chunk_ms // 1000)
        pending = bytearray()
        while True:
            raw = source.readframes(max(1, rate * chunk_ms // 1000))
            if not raw:
                break
            if width != 2:
                raw = audioop.lin2lin(raw, width, 2)
            if channels > 1:
                raw = audioop.tomono(raw, 2, 0.5, 0.5)
            if rate != DEFAULT_SAMPLE_RATE:
                raw, state = audioop.ratecv(raw, 2, 1, rate, DEFAULT_SAMPLE_RATE, state)
            pending.extend(raw)
            while len(pending) >= target_bytes:
                yield bytes(pending[:target_bytes])
                del pending[:target_bytes]
        if pending:
            yield bytes(pending)


def _av_pcm_chunks(path: Path, chunk_ms: int) -> Iterator[bytes]:
    """Decode MediaRecorder WebM/Opus and other containers through PyAV."""
    try:
        import av
    except ImportError as exc:
        raise RuntimeError(
            f"PyAV is required to decode Hermes audio format {path.suffix or '<unknown>'}"
        ) from exc

    target_bytes = max(320, DEFAULT_SAMPLE_RATE * 2 * chunk_ms // 1000)
    pending = bytearray()
    try:
        with av.open(str(path), mode="r") as container:
            audio_stream = next((stream for stream in container.streams if stream.type == "audio"), None)
            if audio_stream is None:
                raise RuntimeError("Hermes recording contains no audio stream")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=DEFAULT_SAMPLE_RATE)

            def append_frame(frame: Any) -> Iterator[bytes]:
                pending.extend(frame.to_ndarray().tobytes())
                while len(pending) >= target_bytes:
                    yield bytes(pending[:target_bytes])
                    del pending[:target_bytes]

            for decoded in container.decode(audio_stream):
                converted = resampler.resample(decoded)
                for frame in converted if isinstance(converted, list) else [converted]:
                    if frame is not None:
                        yield from append_frame(frame)
            flushed = resampler.resample(None)
            for frame in flushed if isinstance(flushed, list) else [flushed]:
                if frame is not None:
                    yield from append_frame(frame)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Failed to decode Hermes audio {path.suffix or '<unknown>'}: {exc}") from exc
    if pending:
        yield bytes(pending)


def _decoded_pcm(file_path: str, chunk_ms: int) -> bytes:
    """Decode once so the silence gate and Qwen upload inspect identical PCM."""
    return b"".join(_pcm_chunks(file_path, chunk_ms))


def _bytes_chunks(pcm: bytes, chunk_ms: int) -> Iterator[bytes]:
    target_bytes = max(320, DEFAULT_SAMPLE_RATE * 2 * chunk_ms // 1000)
    for offset in range(0, len(pcm), target_bytes):
        yield pcm[offset:offset + target_bytes]


def _as_bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off"}


def _silence_metrics(pcm: bytes, config: Dict[str, Any]) -> Dict[str, Any]:
    """Classify a whole recording without trimming any speech samples."""
    frame_ms = int(config.get("silence_frame_ms", DEFAULT_SILENCE_FRAME_MS))
    rms_threshold = int(config.get("silence_rms_threshold", DEFAULT_SILENCE_RMS_THRESHOLD))
    peak_threshold = int(config.get("silence_peak_threshold", DEFAULT_SILENCE_PEAK_THRESHOLD))
    recording_rms_threshold = int(
        config.get(
            "silence_recording_rms_threshold",
            DEFAULT_SILENCE_RECORDING_RMS_THRESHOLD,
        )
    )
    min_voiced_ms = int(
        config.get("silence_min_voiced_ms", DEFAULT_SILENCE_MIN_VOICED_MS)
    )
    min_consecutive_ms = int(
        config.get("silence_min_consecutive_ms", DEFAULT_SILENCE_MIN_CONSECUTIVE_MS)
    )
    if (
        frame_ms <= 0
        or rms_threshold < 0
        or peak_threshold < 0
        or recording_rms_threshold < 0
        or min_voiced_ms < 0
        or min_consecutive_ms < 0
    ):
        raise RuntimeError("Qwen ASR silence-gate settings must be non-negative")

    frame_bytes = max(2, DEFAULT_SAMPLE_RATE * 2 * frame_ms // 1000)
    voiced_frames = 0
    consecutive_frames = 0
    longest_consecutive_frames = 0
    for offset in range(0, len(pcm), frame_bytes):
        frame = pcm[offset:offset + frame_bytes]
        if len(frame) < 2:
            continue
        frame_rms = audioop.rms(frame, 2)
        frame_peak = audioop.max(frame, 2)
        voiced = frame_rms >= rms_threshold and frame_peak >= peak_threshold
        if voiced:
            voiced_frames += 1
            consecutive_frames += 1
            longest_consecutive_frames = max(longest_consecutive_frames, consecutive_frames)
        else:
            consecutive_frames = 0

    rms = audioop.rms(pcm, 2) if len(pcm) >= 2 else 0
    peak = audioop.max(pcm, 2) if len(pcm) >= 2 else 0
    pcm_ms = len(pcm) * 1000 / (DEFAULT_SAMPLE_RATE * 2)
    voiced_ms = voiced_frames * frame_ms
    longest_voiced_ms = longest_consecutive_frames * frame_ms
    gate_enabled = _as_bool(config.get("silence_gate_enabled"), True)
    return {
        "pcm_ms": pcm_ms,
        "rms": rms,
        "peak": peak,
        "voiced_ms": voiced_ms,
        "longest_voiced_ms": longest_voiced_ms,
        "local_silence": gate_enabled
        and rms < recording_rms_threshold
        and voiced_ms < min_voiced_ms
        and longest_voiced_ms <= min_consecutive_ms,
    }


def _event(message: Any) -> Dict[str, Any]:
    if isinstance(message, bytes):
        return {}
    try:
        return json.loads(message)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Qwen ASR returned invalid JSON") from exc


def _error(event: Dict[str, Any]) -> str:
    header = event.get("header") or {}
    payload = event.get("payload") or {}
    return str(header.get("error_message") or payload.get("message") or "Qwen ASR task failed")


def transcribe(file_path: str, config: Dict[str, Any]) -> Dict[str, Any]:
    model = str(config.get("model") or QWEN_ASR_MODEL)
    if model not in SUPPORTED_QWEN_ASR_MODELS:
        raise ValueError(f"Unsupported Qwen streaming ASR model: {model}")
    task_id = str(uuid4())
    timeout = float(config.get("timeout_seconds", 60))
    chunk_ms = int(config.get("chunk_ms", 100))
    pace_realtime = bool(config.get("pace_realtime", False))
    vocabulary = config.get("vocabulary") or config.get("hotwords") or {}
    parameters: Dict[str, Any] = {"format": "pcm", "sample_rate": DEFAULT_SAMPLE_RATE}
    if vocabulary:
        parameters["vocabulary"] = vocabulary
    input_payload: Dict[str, Any] = {}
    context = config.get("context")
    if context:
        input_payload["context"] = context
    run_task = {
        "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": model,
            "parameters": parameters,
            "input": input_payload,
        },
    }
    started = time.perf_counter()
    decode_started = time.perf_counter()
    pcm = _decoded_pcm(file_path, chunk_ms)
    decode_ms = (time.perf_counter() - decode_started) * 1000
    metrics = _silence_metrics(pcm, config)
    container_bytes = Path(file_path).stat().st_size
    logger.info(
        "stt_audio_gate request_id=%s container_bytes=%d pcm_ms=%.1f rms=%d peak=%d "
        "voiced_ms=%d longest_voiced_ms=%d local_silence=%s decode_ms=%.2f",
        task_id, container_bytes, metrics["pcm_ms"], metrics["rms"], metrics["peak"],
        metrics["voiced_ms"], metrics["longest_voiced_ms"], metrics["local_silence"],
        decode_ms,
    )
    if metrics["local_silence"]:
        return {
            "transcript": "",
            "request_id": task_id,
            "model": model,
            "first_result_ms": None,
            "elapsed_ms": (time.perf_counter() - started) * 1000,
            "local_silence": True,
            "audio_metrics": metrics,
        }
    final_segments: Dict[int, str] = {}
    partial_segments: Dict[int, str] = {}
    fallback_text = ""
    first_result_ms: Optional[float] = None
    lease = _POOL.acquire(config, websocket_url(config), _api_key(config), connect)
    socket = lease.socket
    terminal = False
    try:
        socket.send(json.dumps(run_task, ensure_ascii=False))
        while True:
            event = _event(socket.recv(timeout=timeout))
            if (event.get("header") or {}).get("task_id") != task_id:
                raise RuntimeError("Qwen ASR task identity mismatch")
            name = str((event.get("header") or {}).get("event", ""))
            if name == "task-started":
                break
            if name == "task-failed":
                raise RuntimeError(_error(event))
        for chunk in _bytes_chunks(pcm, chunk_ms):
            socket.send(chunk)
            if pace_realtime:
                time.sleep(chunk_ms / 1000)
        socket.send(json.dumps({
            "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
            "payload": {"input": {}},
        }))
        while True:
            event = _event(socket.recv(timeout=timeout))
            header = event.get("header") or {}
            if header.get("task_id") != task_id:
                raise RuntimeError("Qwen ASR task identity mismatch")
            name = str(header.get("event", ""))
            if name == "task-failed":
                raise RuntimeError(_error(event))
            if name == "result-generated":
                sentence = (((event.get("payload") or {}).get("output") or {}).get("sentence") or {})
                if sentence.get("heartbeat"):
                    continue
                text = str(sentence.get("text") or "").strip()
                if text:
                    if first_result_ms is None:
                        first_result_ms = (time.perf_counter() - started) * 1000
                    sentence_id = int(sentence.get("sentence_id") or 0)
                    if sentence.get("sentence_end") is True or sentence.get("end_time") is not None:
                        final_segments[sentence_id] = text
                        partial_segments.pop(sentence_id, None)
                    else:
                        partial_segments[sentence_id] = text
                    fallback_text = text
            if name == "task-finished":
                terminal = True
                break
    finally:
        _POOL.put(lease, config, terminal)
    completed = dict(partial_segments)
    completed.update(final_segments)
    transcript = "".join(text for _, text in sorted(completed.items())).strip() or fallback_text
    return {
        "transcript": transcript,
        "request_id": task_id,
        "model": model,
        "first_result_ms": first_result_ms,
        "elapsed_ms": (time.perf_counter() - started) * 1000,
        "connection_id": lease.connection_id,
        "connection_reused": lease.reused,
        "handshake_ms": lease.handshake_ms,
        "local_silence": False,
        "audio_metrics": metrics,
    }

