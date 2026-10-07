import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from hermes_speech_plugin.signal_bridge import BridgeConfig, create_handler


def _request(url, body=None, token="local-secret"):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


class SignalBridgeTests(unittest.TestCase):
    def test_workspace_beijing_endpoint_keeps_flash_model(self):
        config = BridgeConfig("cloud-secret", workspace_id="workspace-test")
        self.assertEqual(
            config.upstream_url,
            "https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-flash",
        )

    def test_signaling_envelope_and_exact_model(self):
        seen = {}

        def exchange(url, offer, headers, timeout):
            seen.update(url=url, offer=offer, headers=headers, timeout=timeout)
            return 200, "v=0\r\na=answer\r\n"

        config = BridgeConfig("cloud-secret", "workspace-1", local_token="local-secret")
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(config, exchange))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            status, payload = _request(
                f"http://127.0.0.1:{server.server_port}/v1/live/sessions",
                {"transport": {"sdp": "v=0\r\na=offer\r\n"}},
            )
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(status, 200)
        self.assertTrue(payload["transport"]["sdp"].startswith("v=0"))
        self.assertIn("model=qwen-audio-3.0-realtime-flash", seen["url"])
        self.assertEqual(seen["headers"]["Authorization"], "Bearer cloud-secret")
        self.assertTrue(seen["offer"].endswith("a=offer\r\n"))

    def test_local_auth_is_enforced(self):
        config = BridgeConfig("cloud-secret", "workspace-1", local_token="local-secret")
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(config, lambda *args: (200, "answer")))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            status, payload = _request(
                f"http://127.0.0.1:{server.server_port}/v1/live/sessions",
                {"sdp": "offer"},
                token="wrong",
            )
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")


    def test_realtime31_model_is_reported_in_health_and_signaling(self):
        config = BridgeConfig("test-key", "workspace-test", model="qwen-audio-3.1-realtime-plus")
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(config, lambda *args: (200, "v=0\r\n")))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            _, health = _request(base + "/health")
            _, session = _request(base + "/v1/live/sessions", {"sdp": "offer"})
            self.assertEqual(health["model"], config.model)
            self.assertEqual(session["session"]["model"], config.model)
        finally:
            server.shutdown(); server.server_close()

    def test_public_domain_fails_before_cloud_request(self):
        with self.assertRaisesRegex(ValueError, "workspace|WORKSPACE"):
            BridgeConfig("test-key").validate()


if __name__ == "__main__":
    unittest.main()

