# hermes-speech

Speech plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Provides transcription, speech synthesis, and desktop voice through Qwen APIs or an independently deployed Hermes Speech Service.

**Local speech requires [Hermes Speech Service](https://github.com/seamusmore/hermes-speech-service).** Deploy that service with its models and inference dependencies before selecting `service` for STT or TTS. Qwen-only configurations use Qwen APIs directly.

## Features

- **Independent providers**: Select Qwen or Hermes Speech Service separately for STT and TTS.
- **Desktop voice**: Chained conversations, GPT-live compatibility, and a dedicated voice entry.
- **Streaming playback**: Incremental synthesis, cancellation, and recovery on the next turn.
- **Client interfaces**: Shared backend protocol with interfaces reserved for web and standalone clients.

## Requirements

- Hermes Agent with backend plugin support. Desktop voice also requires the Hermes desktop app.
- Python dependencies are declared in `plugin.yaml` and installed by Hermes PM during plugin installation or enablement: `audioop-lts==0.2.2` on Python 3.13+ and `av==18.1.0`.
- A Qwen API account or a reachable [Hermes Speech Service](https://github.com/seamusmore/hermes-speech-service) deployment. For local speech, follow the service repository's installation instructions first; it manages the model weights and inference environment.

## Installation

### Recommended (via Hermes CLI)

```bash
hermes plugins install https://github.com/seamusmore/hermes-speech.git
hermes plugins enable hermes-speech
```

Then restart the gateway for the plugin to take effect. For desktop voice, enable the desktop component in Hermes plugin settings and restart the desktop app.

### Manual (alternative)

```bash
mkdir -p ~/.hermes/plugins/
git clone https://github.com/seamusmore/hermes-speech.git \
  ~/.hermes/plugins/hermes-speech
hermes plugins enable hermes-speech
```

The enable command synchronizes declared dependencies. Then configure and restart. Replace `~/.hermes` with your Hermes home when using a custom installation or profile.

## Configuration

Use the active Hermes profile's `config.yaml` for parameters and Hermes' standard secret store/environment for cloud credentials. The plugin uses Hermes' profile-scoped secret API. It does not open its own `.env` files or read speech parameters from `plugins.entries.hermes-speech.settings`.

### Qwen STT and TTS

Put `DASHSCOPE_API_KEY` in the active profile's Hermes environment or secret store. Then merge this example into `config.yaml`:

```yaml
stt:
  enabled: true
  provider: http-speech
  http-speech:
    backend: qwen
    qwen:
      model: qwen-audio-3.1-asr-flash-streaming
      region: beijing
      api_key_env: DASHSCOPE_API_KEY
      chunk_ms: 100
      pace_realtime: false
tts:
  provider: http-speech
  http-speech:
    backend: qwen
    qwen:
      model: qwen-audio-3.1-tts-flash
      region: beijing
      api_key_env: DASHSCOPE_API_KEY
      voice: your_supported_voice_id
      sample_rate: 24000
      rate: 1.0
```

`stt.provider` selects `stt.http-speech`; `tts.provider` selects `tts.http-speech`. Each `backend` accepts `qwen` or `service` (default: `service`). Both capabilities can select their backend independently.

The following options go inside each capability's `http-speech.qwen` mapping:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `model` | STT: `qwen-audio-3.0-asr-flash-streaming`; TTS: `qwen-audio-3.1-tts-flash` | Supported STT models: 3.0/3.1 `asr-flash-streaming`; supported TTS models: 3.0/3.1 `tts-flash`. Examples explicitly select 3.1. |
| `region` | `beijing` | `beijing` / `cn-beijing` or `singapore` / `ap-southeast-1`. |
| `api_key_env` | `DASHSCOPE_API_KEY` | Name resolved through Hermes' secret API. |
| `api_key` | unset | Optional explicit credential or `${SECRET_NAME}` reference; prefer `api_key_env`. |
| `workspace_id` | Hermes `DASHSCOPE_WORKSPACE_ID`, otherwise empty | Optional workspace-specific endpoint. |
| `websocket_url` | Derived from region/workspace | Explicit WebSocket endpoint; otherwise checks the Hermes secret API for `QWEN_ASR_WEBSOCKET_URL` / `QWEN_TTS_WEBSOCKET_URL`. |
| `timeout_seconds` | `60` | Request timeout in seconds. |
| `connect_timeout_seconds` | `3` | Connection timeout; capped at 5 seconds. |
| `idle_seconds` | `30` | Warm connection idle lifetime; capped at 50 seconds. |

Additional STT options under `stt.http-speech.qwen`:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `chunk_ms` | `100` | Audio upload chunk duration. |
| `pace_realtime` | `false` | Pace file uploads at audio playback speed. |
| `vocabulary` | `{}` | Qwen vocabulary/hotword request object. `hotwords` is an alternate input name. |
| `context` | unset | Qwen recognition context passed in the request. |
| `silence_gate_enabled` | `true` | Reject recordings without sufficient speech evidence. |
| `silence_frame_ms` | `20` | Evidence frame duration. |
| `silence_rms_threshold` | `180` | Frame RMS threshold. |
| `silence_peak_threshold` | `1000` | Frame peak threshold. |
| `silence_recording_rms_threshold` | `350` | Whole-recording RMS threshold. |
| `silence_min_voiced_ms` | `200` | Minimum cumulative voiced duration. |
| `silence_min_consecutive_ms` | `80` | Minimum consecutive voiced duration. |

Additional TTS options under `tts.http-speech.qwen`:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `voice` | required | Voice ID supported by the selected Qwen model. |
| `sample_rate` | `24000` | Streaming playback requires 24000 Hz. |
| `rate` | `1.0` | Speech rate, supported range 0.5–2.0. |
| `volume` | `50` | Volume passed to Qwen. |
| `pitch` | `1` | Pitch multiplier passed to Qwen. |

Qwen streaming audio is fixed to PCM; a `qwen.format` setting does not change that transport. Hermes controls final file/output formats. To opt out of the plugin's Chained transport, set `tts.http-speech.streaming: false`; Hermes' `tts.streaming` controls also apply.

### Local speech service

Deploy [Hermes Speech Service](https://github.com/seamusmore/hermes-speech-service#快速启动), then select `backend: service`. All service settings live under the matching provider:

```yaml
stt:
  enabled: true
  provider: http-speech
  http-speech:
    backend: service
    language: auto
    service:
      url: http://127.0.0.1:8000
      token_env: HERMES_SPEECH_SERVICE_TOKEN
      managed: false
tts:
  provider: http-speech
  http-speech:
    backend: service
    model: cosyvoice3
    voice: your_service_voice_id
    language: zh
    service:
      url: http://127.0.0.1:8000
      token_env: HERMES_SPEECH_SERVICE_TOKEN
      managed: false
```

| Location / parameter | Default | Meaning |
| --- | --- | --- |
| `http-speech.service.url` | `http://127.0.0.1:8000` | Service root. The plugin appends `/stt` or `/tts`. Remote services require HTTPS. |
| `http-speech.service.token_env` | `HERMES_SPEECH_SERVICE_TOKEN` | Hermes secret name for service authentication; empty/unset secret sends no bearer token. Credentials are restricted to the configured service origin and path. |
| `http-speech.service.managed` | `false` | Start/stop a local service process with the plugin. Only a loopback root URL is supported. |
| `http-speech.service.path` | required when managed | Service checkout directory containing `run.py`. |
| `http-speech.service.python` | required when managed | Absolute service Python executable, e.g. `/srv/hermes-speech-service/venv/bin/python`. |
| `http-speech.service.environment` | `{}` | Additional environment variables for the managed child process. |
| `stt.http-speech.model` | service default | Optional service recognition model. |
| `stt.http-speech.language` | `auto` | Recognition language hint. |
| `tts.http-speech.model` | `cosyvoice3` | Service synthesis engine. |
| `tts.http-speech.voice` | endpoint-dependent | Service voice ID; set explicitly for predictable synthesis. |
| `tts.http-speech.language` | `zh` | Synthesis language. |

When STT and TTS share one managed service, use matching `url`, `path`, `python`, credentials and `environment`; the plugin shares ownership of the process. `service` settings are inactive while that capability selects `backend: qwen`. Keep an alternative service block commented out if you want a ready-to-use template. Reference-audio cloning options are configured in the service; this plugin does not forward arbitrary `prompt_wav`/`prompt_text` settings.

### GPT-Live / Qwen realtime

All realtime parameters belong under `voice.gpt_live`. The local signaling bridge reads the same model and local token as the Hermes client:

```yaml
voice:
  voice_chat_mode: gpt-live
  gpt_live:
    model: qwen-audio-3.1-realtime-plus
    voice: your_supported_realtime_voice_id
    base_url: http://127.0.0.1:8765/v1
    api_key: your_random_local_bridge_token
    qwen:
      api_key_env: DASHSCOPE_API_KEY
      workspace_id: your_qwen_workspace_id
      region: beijing
      timeout_seconds: 30
      # endpoint_url: https://your-workspace-host/api/v1/webrtc/realtime
```

| Parameter under `voice.gpt_live` | Default / requirement | Meaning |
| --- | --- | --- |
| `model` | `qwen-audio-3.0-realtime-flash` when absent | Supports this model and `qwen-audio-3.1-realtime-plus`; set explicitly for both client and bridge. |
| `voice` | Choose a model-supported voice | Passed by the Hermes client in the realtime session request. |
| `base_url` | Use `http://127.0.0.1:8765/v1` | Local signaling bridge. The current desktop integration uses port 8765. |
| `api_key` | Set a random local token | Authenticates Hermes to the local bridge. The bridge reads this exact value for validation. |
| `qwen.api_key_env` | `DASHSCOPE_API_KEY` | Hermes secret name for the cloud Qwen API key. |
| `qwen.workspace_id` | Hermes `DASHSCOPE_WORKSPACE_ID` | Workspace for the WebRTC API host; required unless `endpoint_url` is supplied. |
| `qwen.region` | `beijing` | Beijing or Singapore, using the same region aliases as STT/TTS. |
| `qwen.endpoint_url` | Derived from workspace/region | Explicit WebRTC signaling endpoint. |
| `qwen.timeout_seconds` | `30` | Upstream signaling timeout. |

There are two credentials: `voice.gpt_live.api_key` protects the local bridge, and the secret named by `qwen.api_key_env` authenticates cloud requests. Only the cloud credential is sent upstream. Generate a local token with `python -c "import secrets; print(secrets.token_urlsafe(32))"` and paste it into `voice.gpt_live.api_key`.

Other `voice` fields such as `record_key`, `max_recording_seconds`, `auto_tts`, `beep_enabled`, `silence_threshold`, `silence_duration`, `barge_in`, `stop_phrases`, and `thinking_sound` belong to Hermes. They control recording, playback and interaction according to the active voice mode; retain your existing values. They are separate from the Qwen signaling parameters above.

## Desktop and Cloud

The backend and desktop component share this repository. The backend publishes `desktop/plugin.js` to the Hermes desktop plugin directory when a desktop installation is present. Cloud-only installations use the backend API. Web and standalone client interfaces are reserved; their applications are not implemented here.

See [CLIENT_API.md](CLIENT_API.md) for HTTP/WebSocket contracts and `desktop/client-contracts.d.ts` for host interfaces.

## How It Works

The plugin registers `http-speech` in both the transcription and speech synthesis registries. Qwen requests go directly to Qwen APIs. Service requests use the configured Hermes Speech Service URL. The desktop component captures audio, submits recognized text through Hermes, and plays synthesized assistant responses.

## Speech Service Example

See [hermes-speech-service](https://github.com/seamusmore/hermes-speech-service) for the independently deployable STT/TTS service, engine setup, and HTTP endpoints.

## Updates

```bash
hermes plugins update hermes-speech
```

Restart the gateway after updating. To replace an existing manually copied installation, back it up and use the official install command with `--force`.

## Troubleshooting

### Plugin fails to load after an upgrade

Run `hermes plugins enable hermes-speech` to synchronize managed dependencies, then restart the gateway so it uses the updated environment.

### Desktop voice entry is missing

Confirm that both the backend plugin and desktop component are enabled, then restart the desktop app.

### Service requests fail

Verify the configured URL, token, and service `/health`, `/capabilities`, and `/ready` responses. Review logs locally and redact credentials, conversation text, and session identifiers before sharing them.

## Development

Backend source is in `hermes_speech_plugin/`; desktop source is in `desktop/`. Rebuild the renderer with `python desktop/build.py`. Tests are under `tests/` and require the Hermes development environment for backend integration checks.

Use the official Hermes CLI for installation and updates.

## License

[MIT](LICENSE). The bundled Silero model retains its [third-party license](assets/LICENSE).
