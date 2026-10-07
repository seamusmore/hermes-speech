"""TTS adapter: Qwen API and local service HTTP API are peer providers."""
import logging
import os
import sys
import time
import threading
import base64
import json as _json
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional
from agent.tts_provider import TTSProvider, DEFAULT_OUTPUT_FORMAT, resolve_output_format
logger = logging.getLogger(__name__)

def _load_http_tts_config():
    from ...config import provider_config
    return provider_config("tts")

def _configured_engine():
    return _load_http_tts_config().get("model") or "cosyvoice3"


def _tts_backend(config: Optional[dict] = None) -> str:
    return str((config or _load_http_tts_config()).get("backend", "local")).strip().lower()


def _qwen_tts_config(
    config: dict,
    *,
    voice: Optional[str] = None,
    model: Optional[str] = None,
    speed: Optional[float] = None,
) -> dict:
    """Build the one Qwen config shape used by sync and streaming paths."""
    from .providers.qwen_tts import QWEN_TTS_MODEL, resolve_rate

    qwen_config = dict(config.get("qwen") or {})
    from hermes_constants import get_hermes_home
    qwen_config["_profile_scope"] = str(get_hermes_home())
    qwen_config["model"] = model or qwen_config.get("model") or QWEN_TTS_MODEL
    qwen_config["voice"] = voice or qwen_config.get("voice")
    if speed is not None:
        qwen_config["rate"] = speed
    qwen_config["rate"] = resolve_rate(qwen_config)
    return qwen_config


class LocalHttpTTSProvider(TTSProvider):
    """Text-to-speech via a local HTTP /synthesize endpoint."""

    @property
    def name(self) -> str:
        return "http-speech"

    @property
    def display_name(self) -> str:
        return self.name

    def warm(self) -> None:
        cfg = _load_http_tts_config()
        if _tts_backend(cfg) == "qwen":
            from .providers.qwen_tts import retain_warm
            retain_warm(_qwen_tts_config(cfg))

    def release(self) -> None:
        from .providers.qwen_tts import release
        release()

    def is_available(self) -> bool:
        cfg = _load_http_tts_config()
        if _tts_backend(cfg) == "qwen":
            from .providers.qwen_tts import credentials_available
            return credentials_available(dict(cfg.get("qwen") or {}))
        url = cfg.get("service_url", "").strip()
        return bool(url)

    def list_voices(self) -> List[Dict[str, Any]]:
        cfg = _load_http_tts_config()
        if _tts_backend(cfg) == "qwen":
            voice = str((cfg.get("qwen") or {}).get("voice") or "").strip()
            return [{"id": voice, "display": voice}] if voice else []
        service_url = str(cfg.get("service_url", "")).strip().rstrip("/")
        if not service_url:
            return []
        try:
            from ... import http_client as requests
            r = requests.get(f"{service_url}/voices", timeout=5)
            if r.status_code == 200:
                voices = r.json().get("available", [])
                return [{"id": v, "display": v} for v in voices]
        except Exception:
            pass
        return []

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": "cosyvoice2", "display": "CosyVoice2-0.5B"},
                {"id": "cosyvoice3", "display": "Fun-CosyVoice3-0.5B-2512"},
                {"id": "qwen-audio-3.0-tts-flash", "display": "Qwen Audio 3.0 TTS Flash"},
                {"id": "qwen-audio-3.1-tts-flash", "display": "Qwen Audio 3.1 TTS Flash"}]

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": self.display_name,
            "badge": "free",
            "tag": "Local CosyVoice2 TTS via HTTP",
            "env_vars": [],
        }

    def default_voice(self) -> Optional[str]:
        cfg = _load_http_tts_config()
        if _tts_backend(cfg) == "qwen":
            return (cfg.get("qwen") or {}).get("voice")
        return cfg.get("voice", "中文女")

    def default_model(self) -> Optional[str]:
        cfg = _load_http_tts_config()
        if _tts_backend(cfg) == "qwen":
            from .providers.qwen_tts import QWEN_TTS_MODEL
            return (cfg.get("qwen") or {}).get("model") or QWEN_TTS_MODEL
        return cfg.get("model") or _configured_engine()

    @property
    def voice_compatible(self) -> bool:
        return True

    def synthesize(
        self,
        text: str,
        output_path: str,
        *,
        voice: Optional[str] = None,
        model: Optional[str] = None,
        speed: Optional[float] = None,
        format: str = DEFAULT_OUTPUT_FORMAT,
        **extra: Any,
    ) -> str:
        """Synthesize text by POSTing to the local TTS HTTP service.

        Returns the absolute path to the written audio file.
        """
        cfg = _load_http_tts_config()
        if _tts_backend(cfg) == "qwen":
            from .providers.audio_output import write_pcm_audio
            from .providers.qwen_tts import DEFAULT_SAMPLE_RATE, stream_pcm
            qwen_cfg = _qwen_tts_config(cfg, voice=voice, model=model, speed=speed)
            use_format = resolve_output_format(format)
            if use_format not in {"wav", "pcm", "mp3"}:
                raise ValueError("Qwen TTS synchronous output supports wav, pcm or mp3")
            pcm = b"".join(stream_pcm(text, qwen_cfg))
            return str(write_pcm_audio(pcm, Path(output_path), use_format, DEFAULT_SAMPLE_RATE))
        service_url = str(cfg.get("service_url", "")).strip().rstrip("/")
        if not service_url:
            raise RuntimeError(
                "http-speech TTS service URL is not configured (plugins.entries.hermes-speech.settings.service.url)"
            )

        use_voice = voice or cfg.get("voice", "中文女")
        use_model = model or cfg.get("model") or _configured_engine()
        use_language = cfg.get("language", "zh")
        use_format = resolve_output_format(format)

        try:
            from ... import http_client as requests

            data: Dict[str, str] = {
                "text": text,
                "voice": use_voice,
                "model": use_model,
                "language": use_language,
                "format": use_format,
            }
            if speed is not None:
                data["speed"] = str(speed)

            response = requests.post(
                f"{service_url}/synthesize",
                data=data,
                timeout=300,
            )

            if response.status_code != 200:
                error_text = response.text[:500] if response.text else "Unknown error"
                raise RuntimeError(
                    f"Local HTTP TTS error (HTTP {response.status_code}): {error_text}"
                )

            # Write audio bytes to output_path
            out = Path(output_path)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(response.content)

            logger.info(
                "Synthesized %d chars via http-speech (%s, %s, %d bytes)",
                len(text),
                use_voice,
                use_model,
                len(response.content),
            )
            return str(out)

        except Exception as exc:
            logger.error("Local HTTP TTS failed: %s", exc, exc_info=True)
            raise

    def stream(
        self,
        text: str,
        *,
        voice: Optional[str] = None,
        model: Optional[str] = None,
        format: str = "opus",
        **extra: Any,
    ) -> Iterator[bytes]:
        """Stream synthesized audio bytes by POSTing to the local TTS service.

        Yields raw audio bytes from the TTS service's /synthesize endpoint.
        """
        cfg = _load_http_tts_config()
        if _tts_backend(cfg) == "qwen":
            from .providers.qwen_tts import stream_pcm
            qwen_cfg = _qwen_tts_config(cfg, voice=voice, model=model)
            yield from stream_pcm(text, qwen_cfg)
            return
        service_url = str(cfg.get("service_url", "")).strip().rstrip("/")
        if not service_url:
            raise RuntimeError(
                "http-speech TTS service URL is not configured (plugins.entries.hermes-speech.settings.service.url)"
            )

        use_voice = voice or cfg.get("voice", "")
        use_model = model or cfg.get("model") or _configured_engine()
        use_language = cfg.get("language", "zh")
        use_format = resolve_output_format(format)

        try:
            from ... import http_client as requests

            data: Dict[str, str] = {
                "text": text,
                "voice": use_voice,
                "model": use_model,
                "language": use_language,
                "format": use_format,
            }

            response = requests.post(
                f"{service_url}/synthesize",
                data=data,
                timeout=300,
                stream=True,
            )

            if response.status_code != 200:
                error_text = response.text[:500] if response.text else "Unknown error"
                raise RuntimeError(
                    f"Local HTTP TTS stream error (HTTP {response.status_code}): {error_text}"
                )

            yield from response.iter_content(chunk_size=4096)

            logger.info(
                "Streamed %d chars via http-speech (%s, %s)",
                len(text),
                use_voice,
                use_model,
            )

        except Exception as exc:
            logger.error("Local HTTP TTS stream failed: %s", exc, exc_info=True)
            raise


def _enable_cjk_streaming_sentence_boundaries():
    from .providers import qwen_tts  # loads the shared external compatibility helpers
    from ...cjk_boundaries import acquire
    from tools import tts_streaming
    return acquire(tts_streaming)


def _register_timing_hooks(ctx):
    """Observe supported Hermes stream hooks without retaining response text.

    These are asynchronous observer timestamps, not the vendor's token clock.
    """
    if not hasattr(ctx, 'register_hook'):
        return
    from collections import OrderedDict
    seen = OrderedDict()
    lock = threading.Lock()

    def observe(phase, **event):
        key = (event.get('session_id'), event.get('turn_id'), event.get('iteration'))
        with lock:
            flags = seen.setdefault(key, set())
            if len(seen) > 128:
                seen.popitem(last=False)
            phases = [phase]
            if phase == 'delta':
                if event.get('kind') != 'text' or not event.get('delta'):
                    return
                phases = ['first_text']
                if any(c in event['delta'] for c in '。！？.!?'):
                    phases.append('first_punctuation')
            for name in phases:
                if name not in flags:
                    flags.add(name)
                    logger.info('voice_llm phase=%s turn=%s iteration=%s observed_ns=%d',
                                name, event.get('turn_id'), event.get('iteration'), time.perf_counter_ns())

    for hook, phase in [('on_stream_start', 'start'), ('on_stream_delta', 'delta'), ('on_stream_end', 'end')]:
        ctx.register_hook(hook, lambda _phase=phase, **event: observe(_phase, **event))


def _cancellable_pcm(service_url, data):
    """Return empty PCM heartbeats so Hermes can observe its own stop flag.

    The network reader owns its response; closing the consumer never waits on
    a blocked socket read. The request ID cancels generation at the service.
    """
    import queue
    from ... import http_client as requests
    from uuid import uuid4

    request_id = uuid4().hex
    started = time.perf_counter()
    logger.info('tts_submit request_id=%s chars=%d observed_ns=%d',
                request_id, len(data.get('text', '')), time.perf_counter_ns())
    data = dict(data, request_id=request_id)
    request_headers = requests.headers_for(service_url)
    cancelled = threading.Event()
    finished = threading.Event()
    pending = queue.Queue(maxsize=4)

    def cancel_remote():
        try:
            with requests.post(f"{service_url}/cancel/{request_id}", timeout=(2, 2), headers=request_headers) as response:
                response.raise_for_status()
        except Exception as exc:
            logger.warning("TTS cancel request_id=%s failed: %s", request_id, exc)

    def put(value):
        while not cancelled.is_set():
            try:
                pending.put(value, timeout=.1)
                return
            except queue.Full:
                pass

    def read():
        try:
            if cancelled.is_set():
                return
            with requests.post(f"{service_url}/synthesize-stream", data=data,
                               timeout=(5, 300), stream=True, headers=request_headers) as response:
                response.raise_for_status()
                # Close-before-headers race: repeat cancellation after registration.
                if cancelled.is_set():
                    cancel_remote()
                    return
                for line in response.iter_lines(chunk_size=1024, decode_unicode=True):
                    if cancelled.is_set():
                        return
                    if not line or not line.startswith("data: "):
                        continue
                    event = _json.loads(line[6:])
                    if event.get("type") == "audio" and event.get("b64"):
                        put(base64.b64decode(event["b64"], validate=True))
                    elif event.get("type") == "error":
                        raise RuntimeError(event.get("message") or "TTS stream failed")
                    elif event.get("type") == "done":
                        return
                if not cancelled.is_set():
                    raise RuntimeError("TTS stream ended before done")
        except Exception as exc:
            put(exc)
        finally:
            finished.set()

    threading.Thread(target=read, daemon=True, name='http-tts-reader').start()
    first_pcm = True
    try:
        while not finished.is_set() or not pending.empty():
            try:
                item = pending.get(timeout=.1)
            except queue.Empty:
                yield b''
                continue
            if isinstance(item, Exception):
                raise item
            if first_pcm and item:
                first_pcm = False
                logger.info('tts_first_pcm request_id=%s elapsed_ms=%.2f',
                            request_id, (time.perf_counter() - started) * 1000)
            yield item
    finally:
        cancelled.set()
        if not finished.is_set():
            threading.Thread(target=cancel_remote, daemon=True, name='http-tts-cancel').start()


def _register_streamer() -> None:
    """Dynamically register an http-speech StreamingTTSProvider into tts_streaming._REGISTRY.

    This lets the desktop speak-stream WebSocket use our local TTS service
    for per-sentence streaming (each sentence is POSTed to /synthesize-stream,
    with PCM audio and empty heartbeat blocks yielded to the caller).
    """
    try:
        from tools.tts_streaming import StreamingTTSProvider

        class HttpTTSStreamer(StreamingTTSProvider):
            """Local HTTP TTS streamer — per model chunk over /synthesize-stream SSE, yield PCM."""

            sample_rate = 24000
            channels = 1
            sample_width = 2

            @staticmethod
            def available() -> bool:
                cfg = _load_http_tts_config()
                if _tts_backend(cfg) == "qwen":
                    from .providers.qwen_tts import credentials_available
                    return credentials_available(dict(cfg.get("qwen") or {}))
                return bool(cfg.get("service_url", "").strip())

            def stream(self, text: str) -> Iterator[bytes]:
                cfg = _load_http_tts_config()
                if _tts_backend(cfg) == "qwen":
                    from .providers.qwen_tts import stream_pcm
                    qwen_cfg = _qwen_tts_config(cfg)
                    started = time.perf_counter()
                    active_model = qwen_cfg["model"]
                    logger.info("tts_submit backend=qwen model=%s chars=%d", active_model, len(text))
                    first = True
                    from contextlib import closing
                    with closing(stream_pcm(text, qwen_cfg)) as blocks:
                        for block in blocks:
                            if first and block:
                                first = False
                                logger.info("tts_first_pcm backend=qwen model=%s elapsed_ms=%.2f",
                                            active_model, (time.perf_counter() - started) * 1000)
                            yield block
                    return
                service_url = str(cfg.get("service_url", "")).strip().rstrip("/")
                if not service_url:
                    raise RuntimeError("http-speech service URL not configured")

                use_voice = cfg.get("voice", "")
                use_model = cfg.get("model") or _configured_engine()
                use_language = cfg.get("language", "zh")

                data: Dict[str, str] = {
                    "text": text,
                    "voice": use_voice,
                    "model": use_model,
                    "language": use_language,
                }

                yield from _cancellable_pcm(service_url, data)

        from tools.tts_streaming import _REGISTRY
        from ...cjk_boundaries import register_owned
        undo = register_owned(_REGISTRY, 'http-speech', HttpTTSStreamer)
        logger.info("Registered http-speech streaming provider")
        return undo
    except Exception as exc:
        logger.warning("Failed to register http-speech streaming provider: %s", exc, exc_info=True)
        return lambda: None
