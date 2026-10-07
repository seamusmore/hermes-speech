---
name: hermes-speech
description: Install, configure, and troubleshoot the Hermes Speech API client and desktop voice integration.
---

# Hermes Speech

## When to Use

- Installing or updating the speech plugin.
- Selecting Qwen or Hermes Speech Service for transcription and synthesis.
- Troubleshooting desktop voice, dependency loading, or service connectivity.

## Installation

```bash
hermes plugins install https://github.com/seamusmore/hermes-speech.git
hermes plugins enable hermes-speech
```

Restart the gateway after installation. Enable the desktop component in the Hermes plugin settings when using desktop voice.

## Configuration

Follow README.md for provider settings. Keep API keys in the active Hermes profile's secret store or `.env`. Use placeholders in shared examples and redact credentials, transcripts, session identifiers, and local account paths from diagnostics.

Set both `stt.provider` and `tts.provider` to `http-speech`. Place provider parameters under `stt.http-speech` and `tts.http-speech`, each with `backend: qwen` or `backend: service`. Qwen options belong under the corresponding `qwen` mapping. Plugin settings hold service management, authentication and bridge options. Qwen and Hermes Speech Service are independent API providers. Local model weights and inference environments belong to the service deployment.

## Troubleshooting

- After a Python environment upgrade, run `hermes plugins enable hermes-speech` to synchronize declared dependencies, then restart the gateway.
- For local service failures, inspect `/health`, `/capabilities`, and `/ready` on the configured service URL.
- For a missing desktop entry, verify that the backend and desktop component are enabled.
- Test cancellation and the next conversation turn after changing voice settings.

## Key Files

- `plugin.yaml`: plugin identity and managed dependencies.
- `hermes_speech_plugin/`: backend providers and transport.
- `desktop/`: desktop source and bundled renderer.
- `CLIENT_API.md`: protocol and future client interfaces.
- `assets/LICENSE`: third-party model license.
