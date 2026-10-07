import concurrent.futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from hermes_speech_plugin.lifecycle import BridgeManager, BridgeStartupError
from hermes_speech_plugin.signal_bridge import BridgeConfig, create_handler

SRC = Path(__file__).resolve().parents[1]
CONFIG = BridgeConfig("fake-cloud-key", "workspace-test", local_token="test-local-secret", model="qwen-audio-3.1-realtime-plus")

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0)); return s.getsockname()[1]

def listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=.1): return True
    except OSError: return False

def wait_closed(port):
    deadline=time.monotonic()+5
    while listening(port) and time.monotonic()<deadline: time.sleep(.05)
    return not listening(port)

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.port=free_port();self.managers=[]
    def tearDown(self):
        for manager in self.managers: manager.close()
        self.temp.cleanup()
    def manager(self, **kwargs):
        manager=BridgeManager(kwargs.pop("config",CONFIG),root=self.root,port=self.port,**kwargs)
        self.managers.append(manager);return manager
    def test_cold_start_concurrent_reuse_ownership_and_exit(self):
        owner=self.manager()
        with concurrent.futures.ThreadPoolExecutor(6) as pool:
            results=list(pool.map(lambda _: owner.ensure(),range(6)))
        self.assertEqual(len({r["instance"] for r in results}),1)
        child=owner.child
        external=self.manager();self.assertEqual(external.ensure()["ownership"],"external")
        external.close();self.assertIsNone(child.poll());self.assertTrue(listening(self.port))
        owner.close();self.assertIsNotNone(child.poll());self.assertTrue(wait_closed(self.port))
    def test_child_crash_recovered_at_next_ensure(self):
        manager=self.manager();first=manager.ensure();child=manager.child
        child.kill();child.wait()
        # Windows venv launchers can exit before their interpreter closes the socket.
        self.assertTrue(wait_closed(self.port))
        second=manager.ensure()
        self.assertNotEqual(first["instance"],second["instance"])
        self.assertIsNone(manager.child.poll())
    def test_unrelated_port_is_not_killed_or_claimed(self):
        class Other(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200);self.end_headers();self.wfile.write(b'{"ok":true}')
            def log_message(self,*args):pass
        server=ThreadingHTTPServer(("127.0.0.1",self.port),Other)
        t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        try:
            manager=self.manager()
            with self.assertRaisesRegex(BridgeStartupError,"occupied"):manager.ensure()
            self.assertIsNone(manager.child);manager.close();self.assertTrue(listening(self.port))
        finally:server.shutdown();server.server_close();t.join()
    def test_matching_service_with_wrong_config_is_rejected(self):
        owner=self.manager();owner.ensure()
        wrong=self.manager(config=BridgeConfig("other-key","workspace-test",local_token="test-local-secret",model=CONFIG.model))
        with self.assertRaisesRegex(BridgeStartupError,"occupied"):wrong.ensure()
        self.assertIsNone(wrong.child);self.assertIsNone(owner.child.poll())
    def test_start_failure_and_timeout_reap_owned_child(self):
        fail=self.manager(command=[sys.executable,"-I","-c","raise SystemExit(7)"],timeout=2)
        with self.assertRaisesRegex(BridgeStartupError,"code 7"):fail.ensure()
        self.assertIsNone(fail.child)
        slow=self.manager(command=[sys.executable,"-I","-c","import time;time.sleep(30)"],timeout=.3)
        start=time.monotonic()
        with self.assertRaisesRegex(BridgeStartupError,"timed out"):slow.ensure()
        self.assertLess(time.monotonic()-start,4);self.assertIsNone(slow.child)
    def test_legacy_service_reused_and_never_reaped(self):
        class Legacy(BaseHTTPRequestHandler):
            server_version="HermesQwenBridge/0.1"
            def send_json(self,status,payload):
                self.send_response(status);self.end_headers();self.wfile.write(json.dumps(payload).encode())
            def do_GET(self):
                self.send_json(200,{"ok":True,"model":CONFIG.model}) if self.path=='/health' else self.send_json(404,{})
            def do_POST(self):
                if self.headers.get('Authorization')!='Bearer '+CONFIG.local_token:self.send_json(401,{})
                else:self.send_json(400,{"error":"missing_sdp"})
            def log_message(self,*args):pass
        server=ThreadingHTTPServer(("127.0.0.1",self.port),Legacy)
        t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        try:
            manager=self.manager();result=manager.ensure()
            self.assertEqual(result['identity'],'legacy-authenticated')
            self.assertEqual(result['ownership'],'external')
            manager.close();self.assertTrue(listening(self.port))
        finally:server.shutdown();server.server_close();t.join()
    def test_unload_during_start_wait_reaps_owned_child(self):
        manager=self.manager(command=[sys.executable,"-I","-c","import time;time.sleep(30)"],timeout=4)
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            future=pool.submit(manager.ensure)
            deadline=time.monotonic()+2
            while manager.child is None and time.monotonic()<deadline:time.sleep(.02)
            child=manager.child;self.assertIsNotNone(child)
            manager.close()
            with self.assertRaises(BridgeStartupError):future.result(timeout=3)
            self.assertIsNotNone(child.poll());self.assertIsNone(manager.child)
    def test_missing_credentials_fail_before_spawn(self):
        manager=self.manager(config=BridgeConfig("",workspace_id="x",local_token="local"))
        with self.assertRaisesRegex(BridgeStartupError,"DASHSCOPE_API_KEY is required"):manager.ensure()
        self.assertIsNone(manager.child)
    def worker(self):
        script=self.root/'owner.py'
        script.write_text("import sys,json\nfrom pathlib import Path\nsys.path.insert(0,"+repr(str(SRC))+ ")\nfrom hermes_speech_plugin.lifecycle import BridgeManager\nfrom hermes_speech_plugin.signal_bridge import BridgeConfig\nm=BridgeManager(BridgeConfig('fake-cloud-key','workspace-test',local_token='test-local-secret',model='qwen-audio-3.1-realtime-plus'),root=Path(sys.argv[1]),port=int(sys.argv[2]))\nr=m.ensure();print(json.dumps(r),flush=True)\nsys.stdin.readline()\nm.close()\n",encoding='utf-8')
        return subprocess.Popen([sys.executable,'-I','-B',str(script),str(self.root),str(self.port)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    def test_process_start_lock_and_foreign_release(self):
        a=self.worker();b=self.worker()
        try:
            ar=json.loads(a.stdout.readline());br=json.loads(b.stdout.readline())
            self.assertEqual(ar['instance'],br['instance'])
            self.assertEqual({ar['ownership'],br['ownership']},{'owned','external'})
            owner,other=(a,b) if ar['ownership']=='owned' else (b,a)
            other.stdin.close();other.wait(timeout=8);self.assertTrue(listening(self.port))
            owner.stdin.close();owner.wait(timeout=8);self.assertTrue(wait_closed(self.port))
        finally:
            for p in (a,b):
                if p.poll() is None:p.kill();p.wait()
                for stream in (p.stdin,p.stdout,p.stderr):stream.close()
    def test_abrupt_parent_exit_closes_child_stdin_and_listener(self):
        parent=self.worker()
        try:
            result=json.loads(parent.stdout.readline());self.assertEqual(result['ownership'],'owned')
            parent.kill();parent.wait(timeout=5)
            self.assertTrue(wait_closed(self.port))
        finally:
            if parent.poll() is None:parent.kill();parent.wait()
            for stream in (parent.stdin,parent.stdout,parent.stderr):stream.close()

if __name__=='__main__':unittest.main()
