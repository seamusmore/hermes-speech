import contextlib
import json
import threading
import time
import unittest
from unittest.mock import patch
from hermes_speech_plugin.cloud_pool import TaskPool
from test_qwen_protocols import TTS

class Socket:
    def __init__(self): self.closed=False
    def ping(self):
        ready=threading.Event()
        if not self.closed: ready.set()
        return ready
    def close(self): self.closed=True

class PoolTests(unittest.TestCase):
    def setUp(self): self.pool=TaskPool();self.created=[]
    def tearDown(self): self.pool.release()
    def connect(self,*a,**kw):
        socket=Socket();self.created.append(socket);return socket
    def get(self,cfg=None,key='k'):
        return self.pool.acquire(cfg or {},'wss://test',key,self.connect)
    def test_reuse_and_auth_profile_model_isolation(self):
        for cfg,key in [({},'k'),({},'other'),({'_profile_scope':'p'},'k'),({'model':'other'},'k')]:
            lease=self.get(cfg,key);self.pool.put(lease,cfg,True)
        self.assertEqual(len(self.created),4)
        lease=self.get();self.assertTrue(lease.reused);self.pool.put(lease,{},True)
    def test_old_timer_cannot_close_reborrowed_lease(self):
        lease=self.get();self.pool.put(lease,{},True);old=lease.timer.function
        self.assertIs(self.get(),lease);self.pool.put(lease,{},True)
        old();self.assertFalse(lease.socket.closed)
        lease.timer.function();self.assertTrue(lease.socket.closed)
    def test_stale_ping_and_vendor_age_reconnect(self):
        lease=self.get();self.pool.put(lease,{},True);lease.socket.close()
        replacement=self.get();self.assertIsNot(replacement,lease)
        replacement.born-=61;self.pool.put(replacement,{},True)
        next_lease=self.get();self.assertIsNot(next_lease,replacement)
        self.pool.put(next_lease,{},False)
    def test_active_leases_exclusive_and_release_retires_busy(self):
        a=self.get();b=self.get();self.assertIsNot(a.socket,b.socket)
        self.pool.release();self.assertFalse(a.socket.closed)
        self.pool.put(a,{},True);self.pool.put(b,{},True)
        self.assertTrue(a.socket.closed);self.assertTrue(b.socket.closed)
    def test_idle_expiry(self):
        lease=self.get({'idle_seconds':.05});self.pool.put(lease,{'idle_seconds':.05},True)
        time.sleep(.1);self.assertTrue(lease.socket.closed)

    def test_credential_rotation_retires_only_the_same_profile(self):
        a={'_profile_scope':'a'};b={'_profile_scope':'b'}
        self.pool.retain_warm(a,'wss://test','old',self.connect)
        self.pool.retain_warm(b,'wss://test','other',self.connect)
        time.sleep(.03)
        old_key=self.pool.key(a,'wss://test','old')
        old_socket=self.pool.idle[old_key][0].socket
        self.pool.retain_warm(a,'wss://test','new',self.connect)
        time.sleep(.03)
        self.assertTrue(old_socket.closed)
        self.assertNotIn(old_key,self.pool.warmers)
        self.assertIn(self.pool.key(b,'wss://test','other'),self.pool.warmers)
        self.assertEqual(len(self.pool.warmers),2)

class TaskSocket(Socket):
    def __init__(self,ack=True,fail=False,complete=False):
        super().__init__();self.messages=[];self.sent=[];self.ack=ack;self.fail=fail;self.complete=complete
    def send(self,value):
        obj=json.loads(value);self.sent.append(obj);h=obj['header'];self.task_id=h['task_id']
        if h['action']=='run-task': self.messages.append(self.event('task-failed' if self.fail else 'task-started'))
        if h['action']=='continue-task':self.messages.append(b'\x01\x00'*32)
        # Normal-completion path (complete=True): finish-task without a cancel directive
        # answers task-finished so a fully played sentence completes. Default OFF:
        # legacy cancellation tests rely on no terminal reply to keep `not completed`.
        if self.complete and h['action']=='finish-task' and obj.get('payload',{}).get('input',{}).get('directive')!='cancel':
            self.messages.append(self.event('task-failed' if self.fail else 'task-finished'))
        if obj.get('payload',{}).get('input',{}).get('directive')=='cancel' and self.ack:
            self.messages.extend([b'OLD',self.event('task-finished')])
    def event(self,name): return json.dumps({'header':{'event':name,'task_id':self.task_id}})
    def recv(self,timeout):
        if self.messages:return self.messages.pop(0)
        time.sleep(min(timeout,.01));raise TimeoutError()

class CancellationTests(unittest.TestCase):
    def tearDown(self):TTS.release()
    def config(self):return {'api_key':'test','websocket_url':'wss://test','voice':'test'}
    def test_cancel_ack_reuses_and_does_not_leak_pcm(self):
        socket=TaskSocket()
        with patch.object(TTS,'connect',return_value=socket) as connect:
            stream=TTS.stream_pcm('one',self.config());self.assertTrue(next(stream));t=time.perf_counter();stream.close()
            self.assertLess(time.perf_counter()-t,.3)
            self.assertTrue(any(x['payload'].get('input',{}).get('directive')=='cancel' for x in socket.sent))
            stream=TTS.stream_pcm('two',self.config());self.assertNotEqual(next(stream),b'OLD');stream.close()
            self.assertEqual(connect.call_count,1)
    def test_missing_ack_discards_with_bounded_close(self):
        socket=TaskSocket(ack=False)
        with patch.object(TTS,'connect',return_value=socket):
            stream=TTS.stream_pcm('one',self.config());next(stream);t=time.perf_counter();stream.close()
            self.assertLess(time.perf_counter()-t,1.2);self.assertTrue(socket.closed)
    def test_first_audio_failure_yields_no_fake_pcm(self):
        socket=TaskSocket(fail=True)
        with patch.object(TTS,'connect',return_value=socket):
            blocks=[]
            with self.assertRaises(RuntimeError):
                for block in TTS.stream_pcm('one',self.config()):blocks.append(block)
            self.assertEqual(blocks,[]);self.assertTrue(socket.closed)

    def test_explicit_stop_cancels_before_first_audio_without_heartbeat(self):
        class DelayedSocket(TaskSocket):
            def send(self,value):
                super().send(value)
                self.messages=[m for m in self.messages if not isinstance(m,bytes)]
        socket=DelayedSocket();stop=threading.Event();blocks=[]
        with patch.object(TTS,'connect',return_value=socket):
            stream=TTS.stream_pcm('one',self.config(),stop_event=stop)
            thread=threading.Thread(target=lambda:blocks.extend(stream));thread.start()
            deadline=time.monotonic()+1
            while not socket.sent and time.monotonic()<deadline:time.sleep(.001)
            start=time.perf_counter();stop.set();thread.join(1)
            self.assertFalse(thread.is_alive());self.assertLess(time.perf_counter()-start,.2)
            self.assertEqual(blocks,[])
            self.assertTrue(any(x['payload'].get('input',{}).get('directive')=='cancel' for x in socket.sent))

    def test_worker_keeps_official_profile_secret_context(self):
        from agent.secret_scope import set_secret_scope,reset_secret_scope
        token=set_secret_scope({'DASHSCOPE_API_KEY':'profile-only'})
        socket=TaskSocket(fail=True)
        try:
            with patch.object(TTS,'connect',return_value=socket) as connect,patch.dict('os.environ',{'DASHSCOPE_API_KEY':'ambient-wrong'}):
                with self.assertRaises(RuntimeError):list(TTS.stream_pcm('one',{'voice':'test'}))
                self.assertEqual(connect.call_args.kwargs['additional_headers']['Authorization'],'bearer profile-only')
        finally:reset_secret_scope(token)


class MultiSentenceSessionTests(unittest.TestCase):
    """组合回归：一个会话事件贯穿多句，provider 只读它。

    每个用例走真实 TTS.stream_pcm（模拟云端 socket），不用替身省略 provider 的
    finally——正是那个 finally 毒化了会话事件（review 发现 1）。
    """
    def tearDown(self):TTS.release()
    def config(self):return {'api_key':'test','websocket_url':'wss://test','voice':'test','timeout_seconds':10}
    def sentences(self,n=3):
        """顺序合成 n 句，每句独立 stream_pcm，共用一个会话事件，立即消费每个块。"""
        session=threading.Event();collected=[]
        def connector(*a,**k):
            s=TaskSocket(complete=True);created.append(s);return s
        created=[]
        with patch.object(TTS,'connect',side_effect=connector):
            for i in range(n):
                with contextlib.closing(TTS.stream_pcm(f'句{i}。',self.config(),stop_event=session)) as blocks:
                    pcm=b''.join(b for b in blocks if b)
                    collected.append(pcm)
        return session,collected

    def test_session_event_not_poisoned_across_sentences(self):
        """3 句全部出 PCM；每句结束会话事件仍未置位（修复前第 2 句起 0 字节）。"""
        session,collected=self.sentences(3)
        self.assertTrue(all(pcm for pcm in collected))
        self.assertFalse(session.is_set(),'single-sentence completion poisoned the session stop')

    def test_long_sentence_multi_piece_via_cap(self):
        """同一句超 cap 被切成多 piece 的路径也不毒化（chained 端点 _split_text_for_speak_stream）。"""
        session=threading.Event();collected=[]
        def connector(*a,**k):
            s=TaskSocket(complete=True);created.append(s);return s
        created=[]
        long='很长的句子'*400+'. '
        with patch.object(TTS,'connect',side_effect=connector):
            for piece in [long[i:i+400] for i in range(0,len(long),400)]:
                with contextlib.closing(TTS.stream_pcm(piece,self.config(),stop_event=session)) as blocks:
                    collected.append(b''.join(b for b in blocks if b))
        self.assertTrue(all(pcm for pcm in collected));self.assertFalse(session.is_set())

    def test_session_stop_before_first_pcm_of_second_sentence(self):
        """第 2 句等待首 PCM 时置会话事件：有界时间 cancel、第 3 句不启动、旧 PCM 不入下一轮。"""
        class NoAudioSocket(TaskSocket):
            """第二句的云端：吞掉音频，只留事件——制造「已启动、未出音」的首音前窗口。"""
            def send(self,value):
                super().send(value)
                self.messages=[m for m in self.messages if not isinstance(m,bytes)]
        session=threading.Event();blocks=[];sockets=[]
        def connector(*a,**k):
            # 第 1 个 socket 正常出音出终态；之后每个都是 NoAudio（第二句窗口）
            s=TaskSocket(complete=True) if not sockets else NoAudioSocket()
            sockets.append(s);return s
        with patch.object(TTS,'connect',side_effect=connector):
            with contextlib.closing(TTS.stream_pcm('第一句。',self.config(),stop_event=session)) as first:
                blocks.append(b''.join(b for b in first if b))
            stop_at=time.perf_counter()
            # 第二句用不同 voice → 池 identity 不同 → 新连接（NoAudio）。复用路径下
            # 第二句会被池里的旧连接秒答完，构不出「已启动、未出音」窗口。
            second_cfg=dict(self.config(),voice='other')
            second=TTS.stream_pcm('第二句。',second_cfg,stop_event=session)
            thread=threading.Thread(target=lambda:blocks.append(b''.join(b for b in second if b)))
            thread.start()
            # 等到第 2 句 run-task 已发（首音前）再置位。
            deadline=time.monotonic()+2
            run_tasks=[x for s in sockets for x in s.sent]
            while len([x for x in run_tasks if x.get('header',{}).get('action')=='run-task'])<2 and time.monotonic()<deadline:
                time.sleep(.001);run_tasks=[x for s in sockets for x in s.sent]
            session.set();thread.join(1)
            self.assertFalse(thread.is_alive(),'session cancel was not bounded')
            self.assertLess(time.perf_counter()-stop_at,1,'session cancel was not bounded')
            second.close()
            self.assertTrue(any(x['payload'].get('input',{}).get('directive')=='cancel' for x in sockets[-1].sent),
                            'cancel directive not sent to the cloud')
            # 第 3 句不启动：会话已停，静默空返回（不抛错、不发 run-task）
            run_before=[x for x in [y for s in sockets for y in s.sent] if x.get('header',{}).get('action')=='run-task']
            with contextlib.closing(TTS.stream_pcm('第三句。',self.config(),stop_event=session)) as third:
                self.assertEqual(b''.join(b for b in third if b),b'')
            run_after=[x for x in [y for s in sockets for y in s.sent] if x.get('header',{}).get('action')=='run-task']
            self.assertEqual(len(run_after),len(run_before),'third sentence started a cloud task after session stop')

    def test_cancel_during_pcm_backpressure(self):
        """背压（output 队列满 8 块）期间会话取消：worker 从 put 循环退出并发 cancel。"""
        class FloodSocket(TaskSocket):
            def send(self,value):
                super().send(value)
                if json.loads(value).get('header',{}).get('action')=='continue-task':
                    self.messages.extend([b'X'*64]*200+[self.event('task-finished')])
        session=threading.Event();received=[];sockets=[]
        def connector(*a,**k):
            s=FloodSocket();sockets.append(s);return s
        with patch.object(TTS,'connect',side_effect=connector):
            gen=TTS.stream_pcm('一句。',self.config(),stop_event=session)
            for block in gen:
                received.append(block)
                if len(received)>=2: session.set()
                # 不再消费：模拟下游停摆，制造背压
                if len(received)>=3: break
            gen.close()
        self.assertTrue(any(x['payload'].get('input',{}).get('directive')=='cancel' for x in sockets[-1].sent),
                        'cancel not sent while the PCM queue was saturated')

    def test_failed_connection_discarded_next_session_recovers(self):
        """句 1 云端 task-failed：连接淘汰；句 2 拿新连接正常合成（发现 1 的超时恢复面）。"""
        session=threading.Event()
        bad=TaskSocket(fail=True)
        good=TaskSocket(complete=True)
        sockets=iter([bad,good])
        with patch.object(TTS,'connect',side_effect=lambda *a,**k: next(sockets)):
            with self.assertRaises(RuntimeError):
                b''.join(b for b in TTS.stream_pcm('第一句。',self.config(),stop_event=session) if b)
            self.assertTrue(bad.closed)
            with contextlib.closing(TTS.stream_pcm('第二句。',self.config(),stop_event=session)) as second:
                self.assertTrue(b''.join(b for b in second if b))
        self.assertFalse(session.is_set(),'a failed sentence must not stop the session')

    def test_caller_without_stop_event_unaffected(self):
        """无外部 stop_event 的调用方（文件合成 synthesize、普通 streamer）行为不变。"""
        socket=TaskSocket(complete=True)
        with patch.object(TTS,'connect',return_value=socket):
            pcm=b''.join(b for b in TTS.stream_pcm('one',self.config()) if b)
            self.assertTrue(pcm)
            self.assertFalse(socket.closed,'completed lease returns to idle, not closed')

    def test_normal_completion_returns_lease_to_pool_for_next_sentence(self):
        """句 1 正常完成后租约回池；句 2 复用同一连接（连接复用不被修复破坏）。"""
        session=threading.Event();created=[]
        def connector(*a,**k):
            s=TaskSocket(complete=True);created.append(s);return s
        with patch.object(TTS,'connect',side_effect=connector):
            with contextlib.closing(TTS.stream_pcm('一。',self.config(),stop_event=session)) as one:
                b''.join(b for b in one if b)
            with contextlib.closing(TTS.stream_pcm('二。',self.config(),stop_event=session)) as two:
                b''.join(b for b in two if b)
        self.assertEqual(len(created),1,'second sentence should reuse the acknowledged connection')


class CancellationBoundaryTests(unittest.TestCase):
    def tearDown(self): TTS.release()

    def test_stop_at_receive_or_continue_skips_remaining_submission(self):
        for boundary in ('task-started', 'continue-task'):
            with self.subTest(boundary=boundary):
                session = threading.Event()
                class BoundarySocket(TaskSocket):
                    def recv(self, timeout):
                        value = super().recv(timeout)
                        if boundary == 'task-started' and isinstance(value, str):
                            if json.loads(value)['header']['event'] == 'task-started':
                                session.set()
                        return value
                    def send(self, value):
                        super().send(value)
                        if boundary == 'continue-task' and json.loads(value)['header']['action'] == boundary:
                            session.set()
                socket = BoundarySocket()
                with patch.object(TTS, 'connect', return_value=socket):
                    self.assertEqual(list(TTS.stream_pcm('text', {'api_key':'test','voice':'test'}, stop_event=session)), [])
                actions = [x['header']['action'] for x in socket.sent]
                self.assertEqual(actions, ['run-task', 'finish-task'] if boundary == 'task-started'
                                 else ['run-task', 'continue-task', 'finish-task'])
                self.assertEqual(socket.sent[-1]['payload']['input']['directive'], 'cancel')
                TTS.release()

    def test_stop_after_pool_acquire_never_sends_run_task(self):
        session = threading.Event()
        socket = TaskSocket()
        acquire = TTS._POOL.acquire
        def stopped_acquire(*args, **kwargs):
            lease = acquire(*args, **kwargs)
            session.set()
            return lease
        with patch.object(TTS, 'connect', return_value=socket), patch.object(TTS._POOL, 'acquire', side_effect=stopped_acquire):
            self.assertEqual(list(TTS.stream_pcm('text', {'api_key':'test','voice':'test'}, stop_event=session)), [])
        self.assertEqual(socket.sent, [])
        self.assertTrue(socket.closed)
