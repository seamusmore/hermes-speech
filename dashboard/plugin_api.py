"""One authenticated Hermes namespace for desktop and future clients."""
from pathlib import Path
import sys
root = str(Path(__file__).resolve().parents[1])
if root not in sys.path:
    sys.path.insert(0, root)
from fastapi import APIRouter, HTTPException
from hermes_speech_plugin.duplex import router as duplex_router
from hermes_speech_plugin.chained_stream import router as stream_router
from hermes_speech_plugin.plugin_runtime import ensure
from hermes_speech_plugin.lifecycle import BridgeStartupError
from hermes_speech_plugin.config import provider_config

router = APIRouter()
router.include_router(duplex_router)
router.include_router(stream_router)

@router.get("/capabilities")
def capabilities(profile: str = None):
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(profile):
        selected = {kind: provider_config(kind)["backend"] for kind in ("stt", "tts")}
    return {"protocol": 1, **selected, "clients": ["desktop"],
            "reserved_clients": ["web", "standalone"]}

@router.post("/ensure")
def ensure_bridge():
    try:
        return ensure()
    except BridgeStartupError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
