"""Authenticated plugin PCM endpoint with an explicit per-WebSocket stop token."""
import asyncio
import contextlib
import importlib
import json
import logging
import queue
import threading
from fastapi import APIRouter, WebSocket, Request
from hermes_cli.web_server_chat import _ws_auth_ok, _ws_request_is_allowed
from hermes_cli.web_server_profiles import _config_profile_scope

logger = logging.getLogger(__name__)
router = APIRouter()

def resolve_stream(profile):
    from .providers import tts
    from tools.tts_tool_delivery import _resolve_max_text_length
    from hermes_cli.config import load_config
    with _config_profile_scope(profile):
        full = load_config()
        cfg = full.get("tts") or {}
        section = tts._load_http_tts_config()
        if section.get("backend") == "qwen":
            from .providers.tts.providers import qwen_tts
            return qwen_tts.stream_pcm, tts._qwen_tts_config(section), cfg, _resolve_max_text_length(cfg.get("provider") or "http-speech", cfg)
        def local_stream(text, config, stop_event=None):
            data = {"text": text, "voice": config.get("voice", ""),
                    "model": config.get("model", ""), "language": config.get("language", "zh")}
            with contextlib.closing(tts._cancellable_pcm(config["service_url"], data)) as blocks:
                for block in blocks:
                    if stop_event and stop_event.is_set():
                        return
                    yield block
        return local_stream, section, cfg, _resolve_max_text_length(cfg.get("provider") or "http-speech", cfg)

@router.get('/transport-scope')
def transport_scope(request: Request, profile: str = None):
    from hermes_cli.config import load_config
    with _config_profile_scope(profile):
        full = load_config()
        cfg = full.get('tts') or {}
        from .config import provider_config
        section = provider_config('tts', full)
        streaming = cfg.get('streaming') if isinstance(cfg.get('streaming'), dict) else {}
        enabled = (cfg.get('provider') == 'http-speech' and section.get('backend') == 'qwen'
                   and section.get('streaming') is not False and cfg.get('streaming') is not False
                   and streaming.get('enabled') is not False and streaming.get('provider') in (None, '', 'http-speech')
                   and (full.get('voice') or {}).get('voice_chat_mode', 'chained') == 'chained')
    return {'host': request.url.hostname, 'port': request.url.port or 80,
            'path': request.url.path.replace('/api/plugins/hermes-speech/transport-scope', '/api/audio/speak-stream'),
            'profile': profile or 'default', 'qwen_enabled': enabled}

@router.websocket('/speak-stream')
async def speak_stream(ws: WebSocket):
    if not _ws_auth_ok(ws):
        await ws.close(code=4401); return
    if not _ws_request_is_allowed(ws):
        await ws.close(code=4403); return
    await ws.accept()
    profile = (ws.query_params.get('profile') or '').strip() or None
    stop = threading.Event()
    text_queue = queue.SimpleQueue()
    audio_queue = asyncio.Queue(maxsize=16)
    loop = asyncio.get_running_loop()
    failed = []
    def produce():
        try:
            from tools.tts_streaming import SentenceChunker
            from tools.tts_text_normalize import _strip_markdown_for_tts
            from hermes_cli.web_server_gateway import _split_text_for_speak_stream
            with _config_profile_scope(profile):
                stream, config, cfg, cap = resolve_stream(profile)
                chunker = SentenceChunker.from_config(cfg)
                idle = 0
                finished = False
                while not stop.is_set() and not finished:
                    try:
                        item = text_queue.get(timeout=.1)
                        idle = 0
                        if item is None: sentences = chunker.flush(); finished = True
                        else:
                            parts = [item]
                            while not text_queue.empty():
                                next_item = text_queue.get_nowait()
                                if next_item is None: finished = True; break
                                parts.append(next_item)
                            sentences = chunker.feed(''.join(parts))
                            if finished: sentences += chunker.flush()
                    except queue.Empty:
                        idle += 1
                        tail = chunker.buf.strip()
                        sentences = chunker.flush() if tail and (idle >= 20 or (idle >= 5 and tail.endswith(('.', '!', '?', '。', '！', '？', ':')))) else []
                    for sentence in sentences:
                        clean = _strip_markdown_for_tts(sentence)
                        for piece in _split_text_for_speak_stream(clean, cap):
                            if not piece or stop.is_set(): break
                            with contextlib.closing(stream(piece, config, stop_event=stop)) as blocks:
                                for block in blocks:
                                    if stop.is_set(): break
                                    if not block: continue
                                    pending = asyncio.run_coroutine_threadsafe(audio_queue.put(block), loop)
                                    while not stop.is_set():
                                        try: pending.result(timeout=.05); break
                                        except TimeoutError: pass
                                    if stop.is_set(): pending.cancel()
        except Exception as exc:
            if not stop.is_set():
                failed.append(type(exc).__name__)
                logger.warning('Qwen Chained synthesis failed: %s', type(exc).__name__)
        finally:
            # A separate completion event cannot be lost behind a full PCM queue.
            loop.call_soon_threadsafe(done.set)
    done = asyncio.Event()
    worker = asyncio.create_task(asyncio.to_thread(produce))
    async def receive():
        total_chars = 0
        try:
            while not stop.is_set():
                frame = json.loads(await ws.receive_text())
                if frame.get('stop'): break
                if frame.get('text'):
                    text = str(frame['text']); total_chars += len(text)
                    if total_chars > 4 * 1024 * 1024:
                        await ws.close(code=1009, reason='Speech text exceeds 4 MiB session limit')
                        break
                    text_queue.put(text)
                if frame.get('done'): text_queue.put_nowait(None)
        except Exception: pass
        finally: stop.set()
    receiver = asyncio.create_task(receive())
    produced = False
    try:
        while not stop.is_set():
            if done.is_set() and audio_queue.empty(): break
            try: block = await asyncio.wait_for(audio_queue.get(), .05)
            except TimeoutError: continue
            if stop.is_set(): break
            if not produced:
                await ws.send_json({'type':'start','sample_rate':24000,'channels':1})
                produced = True
            await ws.send_bytes(block)
        if not stop.is_set():
            await ws.send_json({'type':'fallback' if failed and not produced else 'end'})
    except Exception: pass
    finally:
        stop.set()
        receiver.cancel()
        with contextlib.suppress(asyncio.CancelledError): await receiver
        # The provider drains matching cancel acknowledgement, or discards its socket.
        with contextlib.suppress(Exception): await asyncio.wait_for(asyncio.shield(worker), 6)
        with contextlib.suppress(Exception): await ws.close()
