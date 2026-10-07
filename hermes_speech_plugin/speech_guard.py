"""Local speech evidence for final ASR admission. No audio or transcript is persisted."""
from pathlib import Path
import os
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import threading
import time
import numpy as np
import onnxruntime as ort

MODEL = Path(os.environ.get('HERMES_SPEECH_VAD_MODEL', str(Path(__file__).resolve().parents[1] / 'assets/silero_vad.onnx')))
SHA256 = '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f'
_session = None
_lock = threading.Lock()
_log = None

def load_model():
    global _session
    with _lock:
        if _session is None:
            if hashlib.sha256(MODEL.read_bytes()).hexdigest() != SHA256:
                raise RuntimeError('Speech detector model checksum mismatch')
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            _session = ort.InferenceSession(str(MODEL), sess_options=options, providers=['CPUExecutionProvider'])
        return _session

def inspect_speech(pcm):
    started = time.perf_counter()
    audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    session = load_model()
    scores = []
    for offset in range(0, len(audio), 512):
        chunk = np.zeros((1, 512), dtype=np.float32)
        source = audio[offset:offset+512]
        chunk[0, :len(source)] = source
        combined = np.concatenate((context, chunk), axis=1)
        output, state = session.run(None, {'input':combined, 'state':state, 'sr':np.array(16000, dtype=np.int64)})
        scores.append(float(output.item()))
        context = chunk[:, -64:]
    voiced_ms = sum(min(512, len(audio)-i*512)/16 for i,p in enumerate(scores) if p >= .5)
    peak = max(scores, default=0)
    accepted = voiced_ms >= 128 and peak >= .7
    return {'version':1, 'accepted':accepted, 'reason':'speech' if accepted else 'insufficient_speech',
            'capture_ms':round(len(audio)/16), 'speech_ms':round(voiced_ms),
            'peak_probability':round(peak,4), 'rms':round(float(np.sqrt(np.mean(audio*audio))) if len(audio) else 0,5),
            'evaluation_ms':round((time.perf_counter()-started)*1000,2)}

def record_decision(uid, evidence, chars, playing):
    global _log
    try:
        with _lock:
            if _log is None:
                path = Path(os.environ.get('HERMES_HOME', str(Path.home()/'.hermes'))) / 'logs/speech-admission.jsonl'
                path.parent.mkdir(parents=True, exist_ok=True)
                _log = logging.getLogger('independent_voice.admission')
                _log.propagate = False
                _log.setLevel(logging.INFO)
                handler = RotatingFileHandler(path, maxBytes=1048576, backupCount=2, encoding='utf8')
                handler.setFormatter(logging.Formatter('%(message)s'))
                _log.addHandler(handler)
        _log.info(json.dumps({'at':time.time(), 'utterance_id':uid, 'recognized_chars':chars,
                             'playback_at_onset':bool(playing), **evidence}))
    except Exception:
        pass  # Diagnostics cannot interrupt a call.

