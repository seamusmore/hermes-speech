# hermes-speech

Speech plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Provides transcription, speech synthesis, and desktop voice through Qwen APIs or an independently deployed Hermes Speech Service.

## Features

- **Independent providers**: Select Qwen or Hermes Speech Service separately for STT and TTS.
- **Desktop voice**: Chained conversations, GPT-live compatibility, and a dedicated voice entry.
- **Streaming playback**: Incremental synthesis, cancellation, and recovery on the next turn.
- **Client interfaces**: Shared backend protocol with interfaces reserved for web and standalone clients.

## Requirements

- Hermes Agent with backend plugin support. Desktop voice also requires the Hermes desktop app.
- Python dependencies are declared in `plugin.yaml` and installed by Hermes PM during plugin installation or enablement: `audioop-lts==0.2.2` on Python 3.13+ and `av==18.1.0`.
- A Qwen API account or a reachable Hermes Speech Service deployment. Model weights and inference environments are managed by that service.

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

### 1. API credentials

For Qwen, add your key to the active Hermes profile's secret store or `.env`:

```dotenv
DASHSCOPE_API_KEY=your_api_key
```

Keep credentials outside the repository. Shared examples should use placeholders.

### 2. Select providers

Merge the following settings into the active profile's `config.yaml`:

```yaml
stt:
  enabled: true
  provider: http_stt
tts:
  provider: http_tts
plugins:
  entries:
    hermes-speech:
      settings:
        stt:
          provider: qwen
        tts:
          provider: qwen
```

Each capability accepts `qwen` or `service`. Existing `stt.http_stt` and `tts.http_tts` options remain compatible. Qwen model and voice overrides belong under the corresponding capability's `qwen` mapping.

### 3. Optional local service

Use this plugin settings block for an independently running service:

```yaml
stt:
  provider: service
tts:
  provider: service
service:
  url: http://127.0.0.1:8000
  managed: false
  token_env: HERMES_SPEECH_SERVICE_TOKEN
```

Place it under `plugins.entries.hermes-speech.settings`. Set `HERMES_SPEECH_SERVICE_TOKEN` in the active profile's environment when authentication is enabled. Remote service URLs require HTTPS. For optional process management, configure `service.managed`, `service.path`, and `service.python` for your own deployment.

### 4. Optional realtime bridge

The Qwen realtime bridge uses these environment variables:

```dotenv
DASHSCOPE_WORKSPACE_ID=your_workspace_id
HERMES_SPEECH_BRIDGE_TOKEN=your_local_bridge_token
QWEN_REGION=beijing
```

Supply the workspace required by your Qwen realtime deployment, or configure its endpoint with `QWEN_WEBRTC_ENDPOINT`. `bridge.environment_file` can point to a separate local environment file. Select the supported Qwen realtime model in the Hermes voice settings.

## Desktop and Cloud

The backend and desktop component share this repository. The backend publishes `desktop/plugin.js` to the Hermes desktop plugin directory when a desktop installation is present. Cloud-only installations use the backend API. Web and standalone client interfaces are reserved; their applications are not implemented here.

See [CLIENT_API.md](CLIENT_API.md) for HTTP/WebSocket contracts and `desktop/client-contracts.d.ts` for host interfaces.

## How It Works

The backend registers transcription and speech providers named `http_stt` and `http_tts`. Qwen requests go directly to Qwen APIs. Service requests use the configured Hermes Speech Service URL. The desktop component captures audio, submits recognized text through Hermes, and plays synthesized assistant responses.

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

`install.py` retains historical migration and rollback support. Use the official Hermes CLI for regular installation and updates.

## License

[MIT](LICENSE). The bundled Silero model retains its [third-party license](assets/LICENSE).
