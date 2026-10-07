"""Run the metadata broker with the parent's dependency directory and lifetime."""
import asyncio
from pathlib import Path
import site
import sys
site.addsitedir(sys.argv[1])
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiohttp import web
from hermes_speech_plugin.events_server import make_app


async def main():
    runner = web.AppRunner(make_app())
    await runner.setup()
    try:
        await web.TCPSite(runner, "127.0.0.1", 18794).start()
        await asyncio.to_thread(sys.stdin.buffer.read)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

