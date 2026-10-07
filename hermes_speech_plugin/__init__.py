"""Unified Hermes speech plugin. Qwen and the local HTTP service are peers."""
REALTIME_MODEL = "qwen-audio-3.0-realtime-flash"
ASR_MODEL = "qwen-audio-3.0-asr-flash-streaming"
TTS_MODEL = "qwen-audio-3.0-tts-flash"


def register(ctx):
    from .providers import stt, tts
    from .local_service import activate as activate_local
    from .desktop_assets import publish
    from .plugin_runtime import activate as activate_bridge
    stt_provider = stt.LocalHttpSTTProvider()
    tts_provider = tts.LocalHttpTTSProvider()
    ctx.register_transcription_provider(stt_provider)
    ctx.register_tts_provider(tts_provider)
    from .config import load_full
    full = load_full()
    if (full.get("stt") or {}).get("provider") == "http_stt":
        ctx.register_transcription_provider(stt.LocalHttpSTTProvider("http_stt"))
    if (full.get("tts") or {}).get("provider") == "http_tts":
        ctx.register_tts_provider(tts.LocalHttpTTSProvider("http_tts"))
    ctx.on_unload(tts_provider.release)
    if stt._stt_backend() == "qwen":
        stt._prepare_qwen(ctx)
    ctx.on_unload(tts._enable_cjk_streaming_sentence_boundaries())
    ctx.on_unload(tts._register_streamer())
    tts._register_timing_hooks(ctx)
    activate_local(ctx)
    # Signaling transport is lazy: cloud/backend-only installs create no desktop assets.
    manager, unload = activate_bridge()
    ctx.on_unload(unload)
    publish(ctx.manifest.path)
    from .events_runtime import activate as activate_events
    activate_events(ctx)
