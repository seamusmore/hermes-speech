"""STT adapter: Qwen API and local service HTTP API are peer providers."""
import logging
import os
import sys
import time
import threading
import base64
import json as _json
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional
from agent.transcription_provider import TranscriptionProvider
logger = logging.getLogger(__name__)

def _load_http_stt_config():
    from ...config import provider_config
    return provider_config("stt")


def _stt_backend(config: Optional[dict] = None) -> str:
    return str((config or _load_http_stt_config()).get("backend", "local")).strip().lower()


class LocalHttpSTTProvider(TranscriptionProvider):
    """Speech-to-text via a local HTTP /transcribe endpoint."""

    def __init__(self, provider_name="http-speech"):
        self._provider_name = provider_name

    @property
    def name(self) -> str:
        return self._provider_name

    @property
    def display_name(self) -> str:
        return self.name

    def is_available(self) -> bool:
        cfg = _load_http_stt_config()
        if _stt_backend(cfg) == "qwen":
            from .providers.qwen_streaming import credentials_available
            return credentials_available(dict(cfg.get("qwen") or {}))
        url = cfg.get("service_url", "").strip()
        return bool(url)

    def list_models(self) -> List[Dict[str, Any]]:
        if _stt_backend() == "qwen":
            from .providers.qwen_streaming import SUPPORTED_QWEN_ASR_MODELS
            return [{"id": model, "display": model} for model in SUPPORTED_QWEN_ASR_MODELS]
        return []

    def default_model(self) -> Optional[str]:
        cfg = _load_http_stt_config()
        if _stt_backend(cfg) == "qwen":
            from .providers.qwen_streaming import QWEN_ASR_MODEL
            return str((cfg.get("qwen") or {}).get("model") or QWEN_ASR_MODEL)
        return cfg.get("model")

    def transcribe(
        self,
        file_path: str,
        *,
        model: Optional[str] = None,
        language: Optional[str] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        cfg = _load_http_stt_config()
        if _stt_backend(cfg) == "qwen":
            from .providers.qwen_streaming import QWEN_ASR_MODEL, transcribe as qwen_transcribe
            qwen_cfg = _qwen_config(cfg)
            qwen_cfg["model"] = model or qwen_cfg.get("model") or QWEN_ASR_MODEL
            started = time.perf_counter()
            try:
                result = qwen_transcribe(file_path, qwen_cfg)
                transcript = str(result.get("transcript") or "").strip()
                if result.get("local_silence"):
                    logger.info(
                        "stt_return backend=qwen request_id=%s local_silence=true elapsed_ms=%.2f",
                        result.get("request_id"), (time.perf_counter() - started) * 1000,
                    )
                    return {"success": True, "transcript": "", "provider": self.name}
                if not transcript:
                    raise RuntimeError("Qwen ASR returned an empty transcript")
                logger.info(
                    "stt_delivered backend=qwen request_id=%s model=%s chars=%d "
                    "first_result_ms=%s elapsed_ms=%.2f",
                    result.get("request_id"), qwen_cfg["model"], len(transcript),
                    result.get("first_result_ms"),
                    (time.perf_counter() - started) * 1000,
                )
                logger.info(
                    "stt_return backend=qwen request_id=%s local_silence=false elapsed_ms=%.2f",
                    result.get("request_id"), (time.perf_counter() - started) * 1000,
                )
                return {"success": True, "transcript": transcript, "provider": self.name}
            except Exception as exc:
                logger.error("Qwen streaming ASR failed: %s", exc, exc_info=True)
                return {
                    "success": False,
                    "transcript": "",
                    "error": f"Qwen streaming ASR failed: {exc}",
                    "provider": self.name,
                }
        service_url = str(cfg.get("service_url", "")).strip().rstrip("/")
        if not service_url:
            return {
                "success": False,
                "transcript": "",
                "error": "http_stt STT is not configured (stt.http_stt.service_url)",
                "provider": self.name,
            }
        lang = language or cfg.get("language", "auto")
        model_name = model or cfg.get("model")
        from uuid import uuid4
        request_id = uuid4().hex
        started = time.perf_counter()

        try:
            from ... import http_client as requests

            data: Dict[str, str] = {"language": lang, "request_id": request_id}
            if model_name:
                data["model"] = model_name
            with open(file_path, "rb") as audio_file:
                logger.info("stt_submit request_id=%s bytes=%d", request_id,
                            os.fstat(audio_file.fileno()).st_size)
                response = requests.post(
                    f"{service_url}/transcribe",
                    data=data,
                    files={"file": (Path(file_path).name, audio_file)},
                    timeout=300,
                )

            if response.status_code != 200:
                logger.warning("stt_http_error request_id=%s status=%s", request_id, response.status_code)
                return {
                    "success": False,
                    "transcript": "",
                    "error": (
                        f"Local HTTP STT error (HTTP {response.status_code}): "
                        f"{response.text[:300]}"
                    ),
                    "provider": self.name,
                }

            result = response.json()
            if result.get("success") is False:
                raise RuntimeError(result.get("error") or "STT service failed")
            transcript = (
                result.get("transcript") or result.get("text") or ""
            ).strip()
            if not transcript:
                logger.warning("stt_empty request_id=%s", request_id)
                return {
                    "success": False,
                    "transcript": "",
                    "error": "Local HTTP STT returned empty transcript",
                    "provider": self.name,
                }

            logger.info(
                "Transcribed %s via http_stt (%s, %d chars)",
                Path(file_path).name,
                model_name,
                len(transcript),
            )
            logger.info("stt_delivered request_id=%s chars=%d elapsed_ms=%.2f timings=%s",
                        request_id, len(transcript), (time.perf_counter() - started) * 1000,
                        result.get("timings"))
            return {
                "success": True,
                "transcript": transcript,
                "provider": self.name,
            }

        except Exception as exc:
            logger.error("Local HTTP STT failed request_id=%s: %s", request_id, exc, exc_info=True)
            return {
                "success": False,
                "transcript": "",
                "error": f"Local HTTP STT failed: {exc}",
                "provider": self.name,
            }


def _qwen_config(cfg):
    from hermes_constants import get_hermes_home
    from .providers.qwen_streaming import QWEN_ASR_MODEL
    result = dict(cfg.get('qwen') or {})
    result.setdefault('model', QWEN_ASR_MODEL)
    result['_profile_scope'] = str(get_hermes_home())
    return result


def _prepare_qwen(ctx):
    from agent.memory_provider import spawn_context_thread
    from .providers.qwen_streaming import retain_warm, release
    def prepare(**kwargs):
        def connect_idle():
            cfg = _load_http_stt_config()
            if _stt_backend(cfg) == 'qwen':
                try: retain_warm(_qwen_config(cfg))
                except Exception as exc: logger.warning('Qwen ASR preconnect failed: %s', exc)
        spawn_context_thread(connect_idle, name='qwen-asr-preconnect').start()
    ctx.on_unload(release)
    ctx.register_hook('on_session_start', prepare)
    prepare()
