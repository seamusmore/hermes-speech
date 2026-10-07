# 客户端协议 v1

后端根路径为 `/api/plugins/hermes-speech`。HTTP 使用 Hermes 现有认证，profile 通过 `?profile=<name>` 选择；云端调用复用相同协议。STT/TTS 服务商密钥仅在后端解析。

| 接口 | 用途 |
|---|---|
| GET /capabilities | 返回选定的 STT/TTS 后端、协议版本、已实现/预留的客户端 |
| POST /bootstrap | 预检 API 配置并创建 30 秒有效、单次使用、绑定 profile 的 WebSocket 票据 |
| WS /duplex?ticket=... | 连续采集、转写及合成音频传输 |
| WS /speak-stream?profile=... | 原有 Hermes 文字分段到 PCM 的适配接口 |
| GET /transport-scope | 供桌面桥校验会话路由和传输归属 |
| POST /ensure | 按需准备原有 Qwen WebRTC 信令适配器 |

bootstrap 返回 `url, capture_rate:16000, playback_rate:24000, protocol:1, speech_gate:1`。WS 成功连接先收到 `{type:"ready",protocol:1}`。

客户端向 duplex 发送：

- `asr.begin`：`id`、`playing`（录音开始时是否在播放）。
- `asr.audio`：`id, seq, pcm`，pcm 是 base64 单声道 PCM16 little-endian，每帧 320 样本/20 ms；seq 连续递增。
- `asr.end`：结束一段语音；每段最多 1600 帧。
- `tts.begin`：`id, text`；同时最多一个合成任务。
- `tts.cancel`：取消指定 id 的合成。

后端发送 `asr.partial`（Qwen 流式模式）、`asr.final`（text 和 speech 证据）、`asr.closed`、`tts.pcm`、`tts.done`、`tts.closed` 以及 `error`。本地 service STT 在语音段结束后返回 final。关闭连接取消本连接任务。任务 id、session/profile/connection 和回放代次共同用于拒绝过期音频与跨会话文本。

文本链路：用户音频经 STT 得到用户文字，宿主提交文字给 Hermes；宿主将 Hermes 的 message 事件交给 TurnLease/TurnText，得到待朗读文字，再请求 TTS。桌面聊天窗口显示 Hermes 原有用户/助手文字。TTS 音频直接播放。

`SpeechHostPort` 与 `SpeechContextPort` 位于 `desktop/client-contracts.d.ts`。DesktopHostAdapter 已实现；网页和独立客户端将提供自己的会话存储、事件订阅、认证请求、提交入口和媒体权限。预留接口保留宿主主动控制提交和会话归属的能力。

本轮保留原有录音、VAD、回声判定、暂停/恢复、停止朗读和下一轮恢复行为。动作指令协议与网页/独立客户端 UI 留在本轮之外。

