"""Child entry: config over stdin; EOF closes the bridge even if its parent crashes."""
import json
from pathlib import Path
import sys
import threading
from http.server import ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_speech_plugin.signal_bridge import BridgeConfig, create_handler

def main():
    payload = json.loads(sys.stdin.readline())
    config = BridgeConfig(**payload["config"])
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), create_handler(config, instance_id=payload["instance"]))
    server.daemon_threads = True
    def parent_watch():
        sys.stdin.buffer.read()
        server.shutdown()
    threading.Thread(target=parent_watch, name="bridge-parent-watch", daemon=True).start()
    print("managed bridge ready on loopback", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()

if __name__ == "__main__":
    main()
