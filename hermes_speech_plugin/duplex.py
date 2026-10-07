"""Independent continuous capture transport; credentials stay in Hermes."""
import asyncio
import base64
import contextlib
import importlib
import json
import queue
import secrets
import sys
import threading
import time
from uuid import uuid4
from fastapi import APIRouter, Request, WebSocket, HTTPException

from hermes_cli.web_server_profiles import _config_profile_scope
from hermes_cli.web_server_chat import _ws_request_is_allowed
from .chained_stream import resolve_stream
from .speech_guard import inspect_speech, load_model, record_decision
router = APIRouter()
_tickets = {}
_ticket_lock = threading.Lock()


def resolve_asr(profile):
    with _config_profile_scope(profile):
        from agent.transcription_registry import get_provider
        from hermes_cli.plugins import _ensure_plugins_discovered
        _ensure_plugins_discovered()
        provider = get_provider('http_stt')
        if provider is None: raise RuntimeError('HTTP STT plugin is not loaded')
        module = type(provider).__module__
        plugin = importlib.import_module(module)
        raw = plugin._load_http_stt_config()
        if plugin._stt_backend(raw) != 'qwen':
            raise RuntimeError('Qwen streaming STT must be configured')
        config = plugin._qwen_config(raw)
        transport = importlib.import_module(module + '.providers.qwen_streaming')
        if config.get('model') not in transport.SUPPORTED_QWEN_ASR_MODELS:
            raise RuntimeError('Unsupported streaming ASR model')
        return transport, config


@router.post('/bootstrap')
def bootstrap(request: Request, profile: str = None):
    # ctx.rest supplies Hermes authentication; the ticket is one-use and profile-bound.
    try:
        with _config_profile_scope(profile):
            from .config import provider_config
            if provider_config("stt")["backend"] == "qwen":
                transport, config = resolve_asr(profile)
                transport._api_key(config)
            else:
                from . import http_client
                response = http_client.get(provider_config("stt")["service_url"] + "/health", timeout=3)
                response.raise_for_status()
            resolve_stream(profile)
    except Exception as exc:
        raise HTTPException(409, 'Configure the selected speech API providers in this profile') from exc
    load_model()
    now = time.monotonic()
    token = secrets.token_urlsafe(32)
    with _ticket_lock:
        for key in list(_tickets):
            if _tickets[key][0] < now: del _tickets[key]
        if len(_tickets) >= 128: raise HTTPException(429, 'Too many pending connections')
        _tickets[token] = (now + 30, profile)
    url = str(request.url.replace(scheme='wss' if request.url.scheme == 'https' else 'ws',
                                  path=request.url.path.removesuffix('/bootstrap') + '/duplex',
                                  query='ticket=' + token))
    return {'url': url, 'capture_rate': 16000, 'playback_rate': 24000, 'protocol': 1, 'speech_gate': 1}


class ASRTask:
    def __init__(self, uid, profile, emit, resolver=None):
        self.id, self.profile, self.emit, self.resolver = uid, profile, emit, resolver or resolve_asr
        self.stop = threading.Event()
        self.audio = queue.Queue(maxsize=1600)  # <=32 s; capture is bounded to30 s.
        self.socket = None
        self.ended = False
        self.last_seq = None
        self.total = 0
        self.pcm = bytearray()
        self.playing = False

    def feed(self, seq, pcm):
        if self.ended or len(pcm) != 640: raise ValueError('Invalid capture frame')
        if self.last_seq is not None and seq != self.last_seq + 1:
            raise ValueError('Capture frame gap')
        self.last_seq = seq
        self.total += 1
        if self.total > 1600: raise ValueError('Capture limit exceeded')
        self.pcm.extend(pcm)
        self.audio.put_nowait(pcm)

    def end(self):
        if self.ended: raise ValueError('Duplicate capture end')
        self.ended = True
        self.audio.put_nowait(None)

    def cancel(self):
        self.stop.set()
        if self.socket:
            with contextlib.suppress(Exception): self.socket.close()

    def run(self):
        lease = None
        terminal = False
        sender = None
        started = time.perf_counter()
        task_id = uuid4().hex
        send_error = []
        try:
            with _config_profile_scope(self.profile):
                transport, config = self.resolver(self.profile)
                lease = transport._POOL.acquire(config, transport.websocket_url(config),
                    transport._api_key(config), transport.connect, self.stop)
                self.socket = lease.socket
                parameters = {'format': 'pcm', 'sample_rate': 16000}
                vocabulary = config.get('vocabulary') or config.get('hotwords')
                if vocabulary: parameters['vocabulary'] = vocabulary
                inp = {'context': config['context']} if config.get('context') else {}
                self.socket.send(json.dumps({'header': {'action':'run-task', 'task_id':task_id, 'streaming':'duplex'},
                    'payload': {'task_group':'audio','task':'asr','function':'recognition','model':config['model'],
                                'parameters':parameters,'input':inp}}))
                def receive():
                    deadline = time.monotonic() + 45
                    while not self.stop.is_set():
                        try:
                            event = json.loads(self.socket.recv(timeout=.25))
                            if event.get('header', {}).get('task_id') != task_id:
                                raise RuntimeError('ASR task identity mismatch')
                            return event
                        except TimeoutError:
                            if time.monotonic() > deadline: raise TimeoutError('ASR stalled')
                    raise InterruptedError()
                first = receive()
                if first['header'].get('event') != 'task-started': raise RuntimeError('ASR start failed')
                self.emit({'type':'asr.ready','id':self.id,'reused':lease.reused,
                           'connection':lease.connection_id,'handshake_ms':lease.handshake_ms})
                def send_audio():
                    try:
                        deadline = time.monotonic() + 40
                        while not self.stop.is_set():
                            try: pcm = self.audio.get(timeout=.1)
                            except queue.Empty:
                                if time.monotonic() > deadline: raise TimeoutError('Capture end missing')
                                continue
                            if pcm is None:
                                self.socket.send(json.dumps({'header':{'action':'finish-task','task_id':task_id,'streaming':'duplex'},'payload':{'input':{}}}))
                                return
                            self.socket.send(pcm)
                    except Exception as exc:
                        send_error.append(exc)
                        self.cancel()
                sender = threading.Thread(target=send_audio, daemon=True, name='chained-asr-send')
                sender.start()
                parts = {}
                while not self.stop.is_set():
                    event = receive()
                    name = event['header'].get('event')
                    if name == 'task-failed': raise RuntimeError('ASR provider failed')
                    if name == 'result-generated':
                        sentence = event.get('payload', {}).get('output', {}).get('sentence', {})
                        if sentence.get('heartbeat'): continue
                        if sentence.get('text'):
                            parts[int(sentence.get('sentence_id') or 0)] = sentence['text']
                            self.emit({'type':'asr.partial','id':self.id,'text':''.join(v for _,v in sorted(parts.items())),
                                       'elapsed_ms':round((time.perf_counter()-started)*1000)})
                    if name == 'task-finished':
                        if not self.ended: raise RuntimeError('ASR ended before capture')
                        terminal = True
                        text = ''.join(v for _,v in sorted(parts.items()))
                        evidence = inspect_speech(bytes(self.pcm))
                        record_decision(self.id, evidence, len(text), self.playing)
                        self.emit({'type':'asr.final','id':self.id,'text':text if evidence['accepted'] else '',
                                   'speech':evidence, 'elapsed_ms':round((time.perf_counter()-started)*1000)})
                        break
                if send_error: raise RuntimeError('ASR send failed')
        except Exception:
            if not self.stop.is_set() or send_error:
                self.emit({'type':'error','id':self.id,'code':'asr_failed'})
        finally:
            self.stop.set()
            if sender: sender.join(.5)
            if lease: transport._POOL.put(lease, config, terminal and not send_error)
            self.emit({'type':'asr.closed','id':self.id})



class LocalASRTask(ASRTask):
    """Completed utterance via the peer service HTTP API; capture stays continuous."""
    def run(self):
        import tempfile
        import wave
        from pathlib import Path
        try:
            while not self.stop.is_set():
                try:
                    frame = self.audio.get(timeout=.1)
                except queue.Empty:
                    continue
                if frame is None:
                    break
            if self.stop.is_set():
                return
            evidence = inspect_speech(bytes(self.pcm))
            text = ""
            if evidence["accepted"]:
                with tempfile.TemporaryDirectory(prefix="hermes-speech-") as directory:
                    path = Path(directory) / "utterance.wav"
                    with wave.open(str(path), "wb") as output:
                        output.setnchannels(1)
                        output.setsampwidth(2)
                        output.setframerate(16000)
                        output.writeframes(self.pcm)
                    with _config_profile_scope(self.profile):
                        from .providers.stt import LocalHttpSTTProvider
                        result = LocalHttpSTTProvider().transcribe(str(path))
                    if not result.get("success"):
                        raise RuntimeError("Speech service transcription failed")
                    text = result.get("transcript", "")
            if not self.stop.is_set():
                record_decision(self.id, evidence, len(text), self.playing)
                self.emit({"type": "asr.final", "id": self.id, "text": text, "speech": evidence})
        except Exception:
            if not self.stop.is_set():
                self.emit({"type": "error", "id": self.id, "code": "asr_failed"})
        finally:
            self.emit({"type": "asr.closed", "id": self.id})

def run_tts(uid, text, profile, stop, emit, resolver=None):
    try:
        from tools.tts_text_normalize import _strip_markdown_for_tts
        from hermes_cli.web_server_gateway import _split_text_for_speak_stream
        with _config_profile_scope(profile):
            stream, config, _, cap = (resolver or resolve_stream)(profile)
            size = 0
            started = time.perf_counter()
            for piece in _split_text_for_speak_stream(_strip_markdown_for_tts(text), cap):
                if stop.is_set(): break
                with contextlib.closing(stream(piece, config, stop_event=stop)) as blocks:
                    for block in blocks:
                        if stop.is_set(): break
                        if not block: continue
                        size += len(block)
                        emit({'type':'tts.pcm','id':uid,'pcm':base64.b64encode(block).decode('ascii')})
            if not stop.is_set():
                emit({'type':'tts.done','id':uid,'bytes':size,'elapsed_ms':round((time.perf_counter()-started)*1000)})
    except Exception:
        if not stop.is_set(): emit({'type':'error','id':uid,'code':'tts_failed'})
    finally:
        emit({'type':'tts.closed','id':uid})


@router.websocket('/duplex')
async def duplex(ws: WebSocket):
    token = ws.query_params.get('ticket', '')
    with _ticket_lock: claim = _tickets.pop(token, None)
    if not claim or claim[0] < time.monotonic():
        await ws.close(code=4401); return
    if not _ws_request_is_allowed(ws):
        await ws.close(code=4403); return
    profile = claim[1]
    await ws.accept()
    outgoing = asyncio.Queue(maxsize=32)
    loop = asyncio.get_running_loop()
    closed = threading.Event()
    asr = {}
    tts = {}
    tasks = set()
    def emit(event):
        if closed.is_set(): return
        future = asyncio.run_coroutine_threadsafe(outgoing.put(event), loop)
        try: future.result(timeout=3)
        except Exception:
            future.cancel()
            closed.set()
            loop.call_soon_threadsafe(lambda: asyncio.create_task(ws.close(code=1013)))
            raise RuntimeError('Client playback backpressure')
    async def writer():
        while True:
            event = await outgoing.get()
            if event['type'] == 'asr.closed': asr.pop(event['id'], None)
            if event['type'] == 'tts.closed': tts.pop(event['id'], None)
            await ws.send_json(event)
    def launch(fn, *args):
        task = asyncio.create_task(asyncio.to_thread(fn, *args))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    writer_task = asyncio.create_task(writer())
    try:
        await ws.send_json({'type':'ready','protocol':1})
        while True:
            raw = await ws.receive_text()
            if len(raw) > 24000: raise ValueError('Frame too large')
            message = json.loads(raw)
            kind, uid = message.get('type'), message.get('id')
            if not isinstance(uid, str) or len(uid) > 100: raise ValueError('Invalid ID')
            if kind == 'asr.begin':
                if uid in asr or len(asr) >= 2: raise ValueError('ASR concurrency limit')
                with _config_profile_scope(profile):
                    from .config import provider_config
                    task_class = ASRTask if provider_config("stt")["backend"] == "qwen" else LocalASRTask
                asr[uid] = task_class(uid, profile, emit)
                asr[uid].playing = message.get('playing') is True
                launch(asr[uid].run)
            elif kind == 'asr.audio':
                asr[uid].feed(int(message['seq']), base64.b64decode(message['pcm'], validate=True))
            elif kind == 'asr.end': asr[uid].end()
            elif kind == 'tts.begin':
                if tts or not isinstance(message.get('text'), str) or len(message['text']) > 8000:
                    raise ValueError('TTS concurrency or text limit')
                stop = threading.Event()
                tts[uid] = stop
                launch(run_tts, uid, message['text'], profile, stop, emit)
            elif kind == 'tts.cancel':
                if uid in tts: tts[uid].set()
            else: raise ValueError('Unknown message')
    except Exception:
        with contextlib.suppress(Exception): await ws.close(code=1011, reason='Transport failed; reconnect explicitly')
    finally:
        closed.set()
        for item in list(asr.values()): item.cancel()
        for stop in tts.values(): stop.set()
        writer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception): await writer_task
        if tasks:
            done, pending = await asyncio.wait(tasks, timeout=6)
            for task in done:
                with contextlib.suppress(Exception): task.result()

