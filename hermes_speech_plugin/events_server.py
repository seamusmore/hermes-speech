"""Loopback speech metadata fan-out. No audio, model, or subscriber-specific logic."""
import argparse
import asyncio
import math
import uuid
from aiohttp import web, WSMsgType

PROTOCOL = "speech-events"

class Broker:
    def __init__(self):
        self.source = None
        self.activity = "idle"
        self.playback = None
        self.clients = {}

    def enqueue(self, client, event):
        ws, queue, stream, seq = client
        envelope = dict(event, protocol=PROTOCOL, version=1, streamId=stream, seq=seq)
        client[3] += 1
        try:
            queue.put_nowait(envelope)
        except asyncio.QueueFull:
            # Disconnect only this lagging consumer. Never await it on the source path.
            if not ws.closed:
                asyncio.create_task(ws.close(code=1013, message=b"Slow subscriber"))

    def broadcast(self, event):
        for client in tuple(self.clients.values()):
            self.enqueue(client, event)

    def reset(self):
        self.activity, self.playback = "idle", None
        self.broadcast({"type": "reset"})

    def validate(self, event):
        kind = event.get("type")
        if kind not in {"snapshot", "activity", "playback", "reset"}:
            raise ValueError("Unknown event")
        clean = {"type": kind}
        if kind in {"snapshot", "activity"}:
            activity = event.get("activity")
            if activity not in {"idle", "listening", "thinking"}:
                raise ValueError("Invalid activity")
            clean["activity"] = activity
        if kind in {"snapshot", "playback"}:
            playback = event.get("playback")
            if playback is not None:
                if not isinstance(playback, dict): raise ValueError("Invalid playback")
                if not isinstance(playback.get("id"), str) or not 0 < len(playback["id"]) <= 256: raise ValueError("Invalid id")
                if playback.get("status") not in {"playing", "paused", "ended", "cancelled"}: raise ValueError("Invalid status")
                for key in ("positionMs", "rms"):
                    value = playback.get(key)
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0: raise ValueError("Invalid sample")
                if playback["rms"] > 1: raise ValueError("Invalid rms")
                playback = {k: playback[k] for k in ("id", "status", "positionMs", "rms")}
                if playback["status"] != "playing": playback["rms"] = 0
            clean["playback"] = playback
        return clean

    async def handle(self, request):
        # Local desktop origins only; remote web pages cannot publish or subscribe.
        origin = request.headers.get("Origin")
        if origin and origin not in {"null", "file://"}:
            from urllib.parse import urlsplit
            parsed = urlsplit(origin)
            if parsed.hostname not in {"localhost", "127.0.0.1", "[::1]", "::1"}:
                raise web.HTTPForbidden()
        ws = web.WebSocketResponse(max_msg_size=8192, heartbeat=10)
        await ws.prepare(request)
        publisher = request.path == "/source"
        task = None
        try:
            hello = await asyncio.wait_for(ws.receive_json(), 5)
            expected = "publish" if publisher else "subscribe"
            if not isinstance(hello, dict) or hello.get("type") != expected or hello.get("protocol") != PROTOCOL or hello.get("version") != 1:
                await ws.close(code=1008, message=b"Protocol mismatch");return ws
            if publisher:
                if self.source is not None:
                    await ws.close(code=1008, message=b"Source busy");return ws
                self.source = ws
                self.reset()
                async for msg in ws:
                    if msg.type != WSMsgType.TEXT: break
                    try:
                        import json
                        event = self.validate(json.loads(msg.data))
                    except (ValueError, TypeError, AttributeError):
                        await ws.close(code=1008, message=b"Invalid event");break
                    if event["type"] == "reset": self.reset();continue
                    if "activity" in event: self.activity = event["activity"]
                    if "playback" in event: self.playback = event["playback"]
                    self.broadcast(event)
            else:
                queue = asyncio.Queue(maxsize=32)
                client = [ws, queue, uuid.uuid4().hex, 0]
                self.clients[ws] = client
                self.enqueue(client, {"type":"snapshot", "activity":self.activity, "playback":self.playback})
                async def writer():
                    while True:
                        event = await queue.get()
                        try: await asyncio.wait_for(ws.send_json(event), 1)
                        except (asyncio.TimeoutError, ConnectionError, RuntimeError):
                            await ws.close(code=1013, message=b"Subscriber unavailable");return
                task = asyncio.create_task(writer())
                async for msg in ws:
                    if msg.type == WSMsgType.TEXT:
                        await ws.close(code=1008, message=b"Read-only subscriber");break
        except (asyncio.TimeoutError, ValueError, TypeError):
            await ws.close(code=1008, message=b"Handshake required")
        finally:
            self.clients.pop(ws, None)
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if self.source is ws:
                self.source = None
                self.reset()
        return ws

    async def cleanup(self, app):
        sockets = list(self.clients)
        if self.source is not None: sockets.append(self.source)
        await asyncio.gather(*(ws.close(code=1001, message=b"Service shutdown") for ws in sockets), return_exceptions=True)


def make_app():
    broker = Broker()
    app = web.Application()
    app.router.add_get("/events", broker.handle)
    app.router.add_get("/source", broker.handle)
    async def health(request):
        return web.json_response({"protocol":PROTOCOL,"version":1,"sourceConnected":broker.source is not None,"subscribers":len(broker.clients)})
    app.router.add_get("/health", health)
    app.on_shutdown.append(broker.cleanup)
    return app

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18794)
    args = parser.parse_args()
    web.run_app(make_app(), host="127.0.0.1", port=args.port, print=None)

