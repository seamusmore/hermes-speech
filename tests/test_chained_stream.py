import contextlib
import json
import threading
import time
import unittest
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from hermes_speech_plugin import chained_stream as route
from test_cloud_pool import TaskSocket
from test_qwen_protocols import TTS

class ChainedEndpointTests(unittest.TestCase):
    def setUp(self):
        self.app=FastAPI();self.app.include_router(route.router,prefix='/api/plugins/hermes-speech')
        self.path='/api/plugins/hermes-speech/speak-stream?profile=isolated'
    def tearDown(self):TTS.release()
    def guards(self):
        stack=contextlib.ExitStack()
        stack.enter_context(patch.object(route,'_ws_auth_ok',return_value=True))
        stack.enter_context(patch.object(route,'_ws_request_is_allowed',return_value=True))
        stack.enter_context(patch.object(route,'_config_profile_scope',side_effect=lambda profile:contextlib.nullcontext()))
        return stack
    def test_auth_and_origin_rejected_before_provider(self):
        for auth,allowed,code in [(False,True,4401),(True,False,4403)]:
            with patch.object(route,'_ws_auth_ok',return_value=auth),patch.object(route,'_ws_request_is_allowed',return_value=allowed),patch.object(route,'resolve_stream') as resolve:
                with TestClient(self.app) as client:
                    with self.assertRaises(WebSocketDisconnect) as error:
                        with client.websocket_connect(self.path):pass
                    self.assertEqual(error.exception.code,code);resolve.assert_not_called()
    def test_stop_and_disconnect_before_pcm_reach_transport_cancel(self):
        for disconnect in [False,True]:
            class DelayedSocket(TaskSocket):
                def send(self,value):
                    super().send(value)
                    self.messages=[m for m in self.messages if not isinstance(m,bytes)]
            socket=DelayedSocket();socket.cancel_at=None
            original=socket.send
            def send(value):
                original(value)
                if '"directive": "cancel"' in value:socket.cancel_at=time.perf_counter()
            socket.send=send
            resolved=(TTS.stream_pcm,{'api_key':'test','voice':'test'}, {'streaming':{'min_len':1}},1000)
            with self.guards(),patch.object(route,'resolve_stream',return_value=resolved),patch.object(TTS,'connect',return_value=socket):
                with TestClient(self.app) as client:
                    with client.websocket_connect(self.path) as ws:
                        ws.send_json({'text':'first sentence. ','done':True})
                        deadline=time.monotonic()+1
                        while not socket.sent and time.monotonic()<deadline:time.sleep(.001)
                        self.assertTrue(socket.sent)
                        stopped=time.perf_counter()
                        if disconnect:ws.close()
                        else:ws.send_json({'stop':True})
                    deadline=time.monotonic()+1
                    while socket.cancel_at is None and time.monotonic()<deadline:time.sleep(.001)
                    self.assertIsNotNone(socket.cancel_at)
                    self.assertLess(socket.cancel_at-stopped,.2)
            TTS.release()
    def test_empty_heartbeat_then_failure_preserves_fallback(self):
        def stream(*args,**kwargs):yield b'';raise TimeoutError('before first PCM')
        with self.guards(),patch.object(route,'resolve_stream',return_value=(stream,{}, {'streaming':{'min_len':1}},1000)):
            with TestClient(self.app) as client,client.websocket_connect(self.path) as ws:
                ws.send_json({'text':'Hello. ','done':True})
                self.assertEqual(ws.receive_json(),{'type':'fallback'})
    def test_pcm_start_order_profile_and_end(self):
        def stream(*args,**kwargs):yield b'';yield b'\x00\x01';yield b''
        with self.guards(),patch.object(route,'resolve_stream',return_value=(stream,{}, {'streaming':{'min_len':1}},1000)) as resolve:
            with TestClient(self.app) as client,client.websocket_connect(self.path) as ws:
                ws.send_json({'text':'Hello. ','done':True})
                self.assertEqual(ws.receive_json()['type'],'start')
                self.assertEqual(ws.receive_bytes(),b'\x00\x01')
                self.assertEqual(ws.receive_json()['type'],'end')
                resolve.assert_called_once_with('isolated')

    def test_more_than_256_small_deltas_are_not_dropped(self):
        spoken=[]
        def stream(text,*args,**kwargs):spoken.append(text);yield b'xx'
        with self.guards(),patch.object(route,'resolve_stream',return_value=(stream,{}, {'streaming':{'min_len':1}},10000)):
            with TestClient(self.app) as client,client.websocket_connect(self.path) as ws:
                for _ in range(600):ws.send_json({'text':'x'})
                ws.send_json({'text':'.','done':True})
                while True:
                    message=ws.receive()
                    if message.get('text') and '"end"' in message['text']:break
                self.assertEqual(''.join(spoken),'x'*600+'.')
    def test_official_import_failure_finishes_with_fallback(self):
        import builtins
        original=builtins.__import__
        def importing(name,*args,**kwargs):
            if name=='tools.tts_text_normalize':raise ImportError('upgrade removed seam')
            return original(name,*args,**kwargs)
        with self.guards(),patch('builtins.__import__',side_effect=importing):
            with TestClient(self.app) as client,client.websocket_connect(self.path) as ws:
                ws.send_json({'text':'Hello. ','done':True})
                self.assertEqual(ws.receive_json(),{'type':'fallback'})


    def test_real_provider_three_sentences_and_end_order(self):
        socket = SequencedSocket()
        resolved = (TTS.stream_pcm, {'api_key':'test','voice':'test','timeout_seconds':2},
                    {'streaming':{'min_len':1}}, 1000)
        with self.guards(), patch.object(route,'resolve_stream',return_value=resolved), patch.object(TTS,'connect',return_value=socket):
            with TestClient(self.app) as client, client.websocket_connect(self.path) as ws:
                ws.send_json({'text':'First sentence. Second sentence. Third sentence. ', 'done':True})
                self.assertEqual(ws.receive_json()['type'], 'start')
                self.assertEqual([ws.receive_bytes() for _ in range(3)], [b'pcm1', b'pcm2', b'pcm3'])
                self.assertEqual(ws.receive_json(), {'type':'end'})
        self.assertEqual(socket.texts, ['First sentence.', 'Second sentence.', 'Third sentence.'])

    def test_real_provider_uses_official_cap_splitter(self):
        from hermes_cli import web_server_gateway as gateway
        socket = SequencedSocket()
        text = 'abcdefghijklmnopq.'
        resolved = (TTS.stream_pcm, {'api_key':'test','voice':'test','timeout_seconds':2},
                    {'streaming':{'min_len':1}}, 7)
        with self.guards(), patch.object(route,'resolve_stream',return_value=resolved), patch.object(TTS,'connect',return_value=socket), patch.object(gateway,'_split_text_for_speak_stream',wraps=gateway._split_text_for_speak_stream) as splitter:
            with TestClient(self.app) as client, client.websocket_connect(self.path) as ws:
                ws.send_json({'text':text, 'done':True})
                self.assertEqual(ws.receive_json()['type'], 'start')
                self.assertEqual([ws.receive_bytes() for _ in range(3)], [b'pcm1', b'pcm2', b'pcm3'])
                self.assertEqual(ws.receive_json(), {'type':'end'})
            splitter.assert_called_once_with(text, 7)
        self.assertEqual(socket.texts, ['abcdefg', 'hijklmn', 'opq.'])

    def test_second_sentence_pre_pcm_stop_disconnect_and_recovery(self):
        for disconnect in (False, True):
            with self.subTest(disconnect=disconnect):
                socket = SequencedSocket(delay_second=True)
                resolved = (TTS.stream_pcm, {'api_key':'test','voice':'test','timeout_seconds':2},
                            {'streaming':{'min_len':1}}, 1000)
                with self.guards(), patch.object(route,'resolve_stream',return_value=resolved), patch.object(TTS,'connect',return_value=socket) as connect:
                    with TestClient(self.app) as client:
                        with client.websocket_connect(self.path) as ws:
                            ws.send_json({'text':'First sentence. Second sentence. Third sentence. ', 'done':True})
                            self.assertEqual(ws.receive_json()['type'], 'start')
                            self.assertEqual(ws.receive_bytes(), b'pcm1')
                            self.assertTrue(socket.second_waiting.wait(1), 'second task never reached pre-PCM wait')
                            start = time.perf_counter()
                            if disconnect: ws.close()
                            else: ws.send_json({'stop':True})
                            self.assertTrue(socket.cancelled.wait(1), 'cloud cancellation missing')
                            self.assertLess(socket.cancel_at-start, .3)
                            if not disconnect:
                                self.assertEqual(ws.receive()['type'], 'websocket.close')
                        self.assertEqual(socket.texts, ['First sentence.', 'Second sentence.'])
                        # A new endpoint session reuses the confirmed socket; drained OLD must never arrive.
                        with client.websocket_connect(self.path) as ws:
                            ws.send_json({'text':'Recovery sentence. ', 'done':True})
                            self.assertEqual(ws.receive_json()['type'], 'start')
                            self.assertEqual(ws.receive_bytes(), b'pcm3')
                            self.assertEqual(ws.receive_json(), {'type':'end'})
                        self.assertEqual(connect.call_count, 1)
                TTS.release()


class SequencedSocket(TaskSocket):
    """Distinct PCM per task, with an optional second-task pre-audio barrier."""
    def __init__(self, delay_second=False):
        super().__init__()
        self.delay_second = delay_second
        self.number = 0
        self.texts = []
        self.second_waiting = threading.Event()
        self.cancelled = threading.Event()
        self.cancel_at = None

    def send(self, value):
        obj = json.loads(value)
        self.sent.append(obj)
        self.task_id = obj['header']['task_id']
        action = obj['header']['action']
        data = obj.get('payload', {}).get('input', {})
        if action == 'run-task':
            self.number += 1
            self.messages.append(self.event('task-started'))
        elif action == 'continue-task':
            self.texts.append(data['text'])
            if self.delay_second and self.number == 2:
                self.second_waiting.set()
            else:
                self.messages.append(('pcm'+str(self.number)).encode())
        elif data.get('directive') == 'cancel':
            self.messages.extend([b'OLD', self.event('task-finished')])
            self.cancel_at = time.perf_counter()
            self.cancelled.set()
        elif action == 'finish-task' and not (self.delay_second and self.number == 2):
            self.messages.append(self.event('task-finished'))

