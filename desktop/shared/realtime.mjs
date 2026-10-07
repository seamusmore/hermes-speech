import {SpeechEventPublisher} from './events.mjs';
const REALTIME_MODEL = 'qwen-audio-3.1-realtime-plus'
const TOOL_NAME = 'delegate_to_hermes'
const ADAPTER = Symbol('qwen-realtime-adapter')
function eventId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
function parse(raw) {
  try { return JSON.parse(String(raw)) } catch { return null }
}
export function createQwenAdapter(channel, options = {}) {
  let transmit = channel.send.bind(channel)
  const deliver = new Set()
  const transcripts = new Map()
  let activeCallId = null
  let responseActive = false
  let firstOutputSent = false
  let queuedOutput = ''
  let closed = false
  let qwenSession = false
  let sessionStarted = false
  let sessionId = null
  let streamOwned = false
  let inputFinished = true
  let pendingDelegation = null
  let currentResponseId = null
  let speaking = false
  const cancelledResponses = new Set()
  const seenCalls = new Set()
  const suppressOutput = () => options.setPlaybackEnabled?.(false)
  const interrupt = () => {
    if (currentResponseId) cancelledResponses.add(currentResponseId)
    if (responseActive) send({ event_id: eventId('cancel'), type: 'response.cancel' })
    pendingDelegation = null
    options.onInterrupt?.(activeCallId)
    streamOwned = false
    activeCallId = null
    queuedOutput = ''
    firstOutputSent = false
    responseActive = false
    suppressOutput()
  }
  const sendRaw = value => transmit(value)
  const send = value => sendRaw(JSON.stringify(value))
  const emit = value => {
    const event = new MessageEvent('message', { data: JSON.stringify(value) })
    for (const listener of deliver) {
      if (typeof listener === 'function') listener.call(channel, event)
      else listener?.handleEvent?.(event)
    }
  }
  const sessionUpdate = () => send({
    event_id: eventId('session'),
    type: 'session.update',
    session: {
      modalities: ['audio', 'text'],
      voice: options.voice || 'longanqian',
      instructions: options.instructions || [
        'You are the realtime voice frontend for Hermes.',
        `Call ${TOOL_NAME} whenever the request needs tools, files, current information, memory, code, or an external action.`,
        'Answer casual conversation directly.',
        'After Hermes returns a result, speak it promptly and faithfully in the user language.'
      ].join(' '),
      turn_detection: { type: 'smart_turn' },
      tools: [{
        type: 'function',
        function: {
          name: TOOL_NAME,
          description: 'Delegate work to Hermes, which has tools, files, memory, and external integrations.',
          parameters: {
            type: 'object',
            properties: { request: { type: 'string', description: 'The complete user request.' } },
            required: ['request']
          }
        }
      }],
      tool_choice: 'auto'
    }
  })
  const triggerSpeech = output => {
    if (closed || speaking || !activeCallId || !output.trim()) return
    if (!firstOutputSent) {
      firstOutputSent = true
      send({
        event_id: eventId('tool_output'),
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: activeCallId, output: output.trim() }
      })
    } else {
      send({
        event_id: eventId('continuation'),
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{
            type: 'input_text',
            text: `Continue speaking this additional Hermes result faithfully: ${output.trim()}`
          }]
        }
      })
    }
    send({
      event_id: eventId('respond'),
      type: 'response.create',
      response: { modalities: ['audio', 'text'] }
    })
    responseActive = true
  }
  const appendHermesOutput = content => {
    const text = String(content || '').replace(/\s+/g, ' ').trim()
    if (closed || speaking || !text || !activeCallId) return
    if (!firstOutputSent && !responseActive) {
      console.info('[qwen-realtime-bridge] hermes_first_speakable', { callId: activeCallId, chars: text.length, at: performance.now() })
    }
    if (responseActive) {
      queuedOutput = queuedOutput ? `${queuedOutput} ${text}` : text
      return
    }
    triggerSpeech(text)
  }
  const handleQwen = raw => {
    const event = parse(raw)
    if (!event || closed) return
    if (event.type === 'session.created' && String(event.session?.model || '').startsWith('qwen-audio-')) {
      qwenSession = true
    }
    if (!qwenSession) { options.resumeInput?.(); emit(event); return }
    const responseId = event.response_id || event.response?.id
    if (responseId && cancelledResponses.has(responseId)) return
    switch (event.type) {
      case 'session.created':
        console.info('[qwen-realtime-bridge] session_created', { model: event.session?.model || REALTIME_MODEL, at: performance.now() })
        sessionUpdate()
        sessionId = event.session?.id
        break
      case 'session.updated':
        if (!sessionStarted) {
          sessionStarted = true
          options.resumeInput?.()
          emit({ type: 'session.started', session: { id: sessionId } })
        }
        break
      // Qwen revises text/stash hypotheses. Hermes accepts append-only fragments,
      // so publish the final utterance once and wait for it before delegation.
      case 'conversation.item.input_audio_transcription.delta':
        break
      case 'conversation.item.input_audio_transcription.completed': {
        const key = event.item_id || 'input'
        const finalText = String(event.transcript || '')
        if (!transcripts.has(key)) {
          transcripts.set(key, finalText)
          if (finalText) emit({ type: 'session.input_transcript.delta', delta: finalText, start_ms: 0, end_ms: Date.now() })
        }
        inputFinished = true
        if (pendingDelegation) {
          const pending = pendingDelegation
          pendingDelegation = null
          handleQwen(JSON.stringify(pending))
        }
        break
      }
      case 'response.audio_transcript.delta':
        if (event.delta) emit({ type: 'session.output_transcript.delta', delta: event.delta, start_ms: 0, end_ms: Date.now() })
        break
      case 'input_audio_buffer.speech_started':
        inputFinished = false
        speaking = true
        interrupt()
        break
      case 'input_audio_buffer.speech_stopped':
        speaking = false
        break
      case 'response.function_call_arguments.done':
        if (!inputFinished) { pendingDelegation = event; break }
        if (event.name === TOOL_NAME && event.call_id && !seenCalls.has(event.call_id) && !speaking) {
          seenCalls.add(event.call_id)
          activeCallId = event.call_id
          firstOutputSent = false
          queuedOutput = ''
          streamOwned = false
          const id = activeCallId
          const dispatch = () => {
            if (closed || speaking || activeCallId !== id) return
            console.info('[qwen-realtime-bridge] delegation_created', {callId:id, at:performance.now()})
            emit({type:'session.delegation.created',delegation:{id,type:'client',target:'hermes'}})
          }
          const ready = options.onDelegation?.(id)
          if (ready?.then) ready.then(dispatch).catch(error => {
            closed = true
            suppressOutput()
            emit({type:'error',error:{message:`Hermes cancellation was not confirmed; voice session closed: ${error.message}`}})
            emit({type:'session.closed',reason:'hermes_cancel_unconfirmed'})
          })
          else dispatch()
        }
        break
      case 'response.created':
        currentResponseId = event.response?.id || null
        if (speaking) { interrupt(); break }
        options.setPlaybackEnabled?.(true)
        responseActive = true
        console.info('[qwen-realtime-bridge] response_created', { callId: activeCallId, at: performance.now() })
        break
      case 'response.done': {
        if (currentResponseId && responseId && responseId !== currentResponseId) break
        if (event.response?.status && event.response.status !== 'completed') {
          responseActive = false
          interrupt()
          currentResponseId = null
          break
        }
        currentResponseId = null
        responseActive = false
        console.info('[qwen-realtime-bridge] response_done', { callId: activeCallId, at: performance.now() })
        const pending = queuedOutput
        queuedOutput = ''
        if (pending) triggerSpeech(pending)
        break
      }
      case 'error':
        if (speaking && ['response.create', 'response.cancel'].includes(event.error?.param)) break
        emit({ type: 'error', error: event.error || { message: 'Qwen Realtime error' } })
        break
    }
  }
  return {
    addHermesMessageListener(listener) { deliver.add(listener) },
    removeHermesMessageListener(listener) { deliver.delete(listener) },
    streamStarted(id) { if (id === activeCallId) streamOwned = true },
    streamAppend(id, content) { if (id === activeCallId) appendHermesOutput(content) },
    bindTransport(next) {
      transmit = next.send.bind(next)
      // Qwen opens its own txt channel. Hermes checks the original oai-events
      // readyState before sending or reporting connected, so mirror the live transport.
      if (next !== channel) Object.defineProperty(channel, 'readyState', { configurable: true, get: () => next.readyState })
    },
    onQwenMessage: handleQwen,
    sendHermes(raw) {
      if (closed) return
      if (!qwenSession) return sendRaw(raw)
      const event = parse(raw)
      if (!event) return sendRaw(raw)
      switch (event.type) {
        case 'session.commentary.append':
          if (streamOwned) return
          if (!activeCallId || event.delegation_id !== activeCallId) return
          appendHermesOutput(event.content)
          return
        case 'session.thinking.append':
          return
        case 'session.instructions.append':
          send({
            event_id: eventId('instructions'),
            type: 'session.update',
            session: { instructions: String(event.content || '') }
          })
          return
        case 'session.input_audio.mute':
        case 'session.input_audio.unmute':
          return
        case 'session.close':
          interrupt()
          closed = true
          emit({ type: 'session.closed', reason: 'close_requested' })
          return
        default:
          sendRaw(raw)
      }
    }
  }
}
// Recompute only a stable prefix. Ambiguous markup stays buffered across deltas.
export function speechPrefix(raw, final = false) {
  const lines = String(raw || '').split('\n')
  const safeLines = []
  let table = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (table && line.includes('|')) continue
    table = false
    if (line.includes('|')) {
      if (i + 1 === lines.length && !final) break
      const next = lines[i + 1]
      if (next === undefined || (!final && i + 2 === lines.length && !next.endsWith(' '))) {
        // Table header versus prose is settled by the complete following line.
        if (!final) break
      }
      if (next !== undefined && /^\s*\|?\s*:?-{3,}/.test(next)) {
        safeLines.push(line.replace(/^\s*\||\|\s*$/g, '').replace(/\|/g, ', ') + '.')
        table = true; i++; continue
      }
    }
    safeLines.push(line)
  }
  const text = safeLines.join('\n')
  let out = '', i = 0
  while (i < text.length) {
    const tail = text.slice(i)
    if (text[i] === '`' || tail.startsWith('~~~')) {
      const marker = text[i] === '`' ? '`' : '~'
      const run = tail.match(marker === '`' ? /^`+/ : /^~+/)[0]
      if (run.length >= 3) {
        const end = text.indexOf(run, i + run.length)
        if (end < 0) break
        i = end + run.length; continue
      }
      const end = text.indexOf(run, i + run.length)
      if (end < 0) break
      out += text.slice(i + run.length, end); i = end + run.length; continue
    }
    if (text[i] === '<') {
      const end = text.indexOf('>', i)
      if (end < 0) break
      const tag = text.slice(i + 1, end).split(/\s/)[0].toLowerCase()
      if (['think','thinking','reasoning','thought','reasoning_scratchpad','思考','反思','推理','分析'].includes(tag)) {
        const close = text.toLowerCase().indexOf(`</${tag}>`, end + 1)
        if (close < 0) break
        i = close + tag.length + 3; continue
      }
      i = end + 1; continue
    }
    if (text[i] === '[' || tail.startsWith('![')) {
      const begin = text[i] === '!' ? i + 1 : i
      const end = text.indexOf(']', begin)
      if (end < 0 || (end + 1 === text.length && !final)) break
      if (text[end + 1] === '(') {
        const close = text.indexOf(')', end + 2)
        if (close < 0) break
        if (text[i] !== '!') out += text.slice(begin + 1, end)
        i = close + 1; continue
      }
    }
    if (/^https?:\/\//i.test(tail) || /^MEDIA:/i.test(tail)) {
      const end = tail.search(/\s/)
      if (end < 0) break
      i += end; continue
    }
    out += text[i++]
  }
  return out.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*(?:[-*+] |\d+[.)] )/gm, '')
    .replace(/[*_~]/g, '').replace(/\p{Extended_Pictographic}/gu, '')
}

// SDK events have no guaranteed turn_id. One start arms this lease; another revokes it.
export function createHermesStream(adapter, delegationId, owner, request = null) {
  let started = false, ended = false, segmentSeen = false, raw = '', emitted = 0, lastSeq = -1
  let replayEpoch = null
  let cancelled = false, cancelPromise = null, cancelResolve, cancelReject, cancelTimer, rpcDone = false, terminal = false
  const settle = () => {
    if (cancelled && rpcDone && terminal) { clearTimeout(cancelTimer); ended = true; cancelResolve?.() }
  }
  const sendCancel = () => {
    if (!request) { rpcDone = true; settle(); return }
    Promise.resolve(request('session.interrupt', {session_id: owner.sessionId})).then(result => {
      if (result?.status === 'not_interrupted') throw new Error('Hermes cancellation was not accepted')
      rpcDone = true; settle()
    }).catch(error => { clearTimeout(cancelTimer); ended = true; cancelReject?.(error) })
  }
  const flush = final => {
    const safe = speechPrefix(raw, final)
    const matches = [...safe.matchAll(/[。！？!?](?:[”’"']|\s)*|\.(?:\s|$)/g)]
    const end = final ? safe.length : (matches.length ? matches.at(-1).index + matches.at(-1)[0].length : 0)
    if (end > emitted) {
      const text = safe.slice(emitted, end).trim(); emitted = end
      if (text) adapter.streamAppend(delegationId, text)
    }
  }
  const listener = event => {
    if (ended || event.replayed || event.session_id !== owner.sessionId) return
    if ((event.connectionId || 'local') !== (owner.connectionId || 'local')) return
    if (event.profile && owner.profile && event.profile !== owner.profile) return
    if (event.replayEpoch !== undefined) {
      if (replayEpoch !== null && replayEpoch !== event.replayEpoch) {
        ended = true; clearTimeout(cancelTimer)
        cancelReject?.(new Error('Hermes event connection changed'))
        return
      }
      replayEpoch = event.replayEpoch
    }
    if (typeof event.seq === 'number') {
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
    }
    if (event.type === 'message.start') {
      if (started) {
        ended = true; clearTimeout(cancelTimer)
        cancelReject?.(new Error('A newer Hermes turn superseded the bound delegation'))
        return
      }
      started = true
      if (cancelled) sendCancel()
      else adapter.streamStarted(delegationId)
      return
    }
    if (!started) return
    const payload = event.payload || {}
    if (cancelled) {
      if (event.type === 'message.complete') { terminal = true; settle() }
      return
    }
    if (event.type === 'message.delta') { segmentSeen = true; raw += payload.text || ''; flush(false) }
    if (event.type === 'message.interim') {
      if (!payload.already_streamed) raw += payload.text || ''
      flush(true); raw = ''; emitted = 0; segmentSeen = false
    }
    if (event.type === 'message.complete') {
      if (!segmentSeen) raw += typeof payload.text === 'string' ? payload.text : ''
      if (payload.status !== 'interrupted' && payload.status !== 'error') flush(true)
      ended = true
    }
  }
  listener.cancel = id => {
    if (id !== delegationId || ended) return null
    if (cancelPromise) return cancelPromise
    cancelled = true
    cancelPromise = new Promise((resolve, reject) => { cancelResolve = resolve; cancelReject = reject })
    // Observe the pending start; do not lose a stop between submit and message.start.
    cancelTimer = setTimeout(() => { ended = true; cancelReject(new Error('Hermes cancellation confirmation timed out')) }, 10000)
    cancelPromise.catch(() => {})
    if (started) sendCancel()
    return cancelPromise
  }

  return listener
}

export function isQwenBridgeConfig(result) {
  const voice = result?.config?.voice
  const live = voice?.gpt_live
  if (voice?.voice_chat_mode !== 'gpt-live' || live?.model !== REALTIME_MODEL) return false
  try {
    const url = new URL(live.base_url)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '8765' && url.pathname.replace(/\/$/, '') === '/v1'
  } catch { return false }
}
function adaptChannel(channel, options) {
  const nativeAdd = channel.addEventListener.bind(channel)
  const nativeRemove = channel.removeEventListener.bind(channel)
  const adapter = createQwenAdapter(channel, options)
  nativeAdd('message', event => adapter.onQwenMessage(event.data))
  channel.send = value => adapter.sendHermes(value)
  channel.addEventListener = (type, listener, settings) => {
    if (type === 'message') adapter.addHermesMessageListener(listener)
    else nativeAdd(type, listener, settings)
  }
  channel.removeEventListener = (type, listener, settings) => {
    if (type === 'message') adapter.removeHermesMessageListener(listener)
    else nativeRemove(type, listener, settings)
  }
  channel[ADAPTER] = adapter
  return channel
}
export function createBridgeReadiness(rest, timeoutMs = 15000) {
  let pending = null
  return () => {
    if (pending) return pending
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Qwen bridge readiness timed out. Check hermes-speech/runtime/bridge-8765.log.')), timeoutMs)
    })
    pending = Promise.race([
      Promise.resolve().then(() => rest('/ensure', { method: 'POST', timeoutMs })).then(result => {
        if (!result?.ok) throw new Error('Qwen bridge health check failed')
        return result
      }), timeout
    ]).catch(error => {
      throw new Error(`Qwen bridge startup failed: ${error?.message || error}. After first installation, restart Hermes once to load its backend plugin.`)
    }).finally(() => { clearTimeout(timer); pending = null })
    return pending
  }
}
export function installChainedTransport(ctx, host) {
  const Native = globalThis.WebSocket
  if (!Native) return () => {}
  const playbackObservers = new Set()
  const bounded = async promise => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error('scope timeout')),2000)})]) }
    finally {clearTimeout(timer)}
  }
  class ScopedSocket extends EventTarget {
    constructor(url, protocols, owner) {
      super()
      this.url = String(url); this.readyState = Native.CONNECTING; this.binaryType = 'blob'
      this.bufferedAmount = 0; this.extensions = ''; this.protocol = ''; this.socket = null
      this.open(url, protocols, owner)
    }
    notify(event) {
      const dispatch = () => {
        this.dispatchEvent(event)
        this[`on${event.type}`]?.call(this,event)
      }
      if (event.type === 'message' && this.playbackObserver) this.playbackObserver.capture(dispatch)
      else dispatch()
    }
    async open(original, protocols, owner) {
      let destination = String(original)
      try {
        const url = new URL(original)
        const routes = await bounded(host.profileRoutes())
        const route = routes.find(r => r.mode === 'local' && (r.connectionId || 'local') === (owner.connectionId || 'local') && r.profile === owner.profile)
        const requestedProfile = url.searchParams.get('profile') || 'default'
        if (route && requestedProfile === (route.targetProfile || route.profile)) {
          const response = await bounded(host.requestProfile(route, 'config.get', {key:'full'}, 2000))
          const cfg = response?.config
          const activeMatches = () => (host.state.connectionId?.get() || 'local') === (owner.connectionId || 'local') && host.state.profile?.get() === owner.profile
          if (cfg?.tts?.provider === 'http_tts' && cfg.tts.http_tts?.backend === 'qwen' && cfg.tts.http_tts.streaming !== false && cfg.tts.streaming !== false && cfg.tts.streaming?.enabled !== false && [undefined,'','http_tts'].includes(cfg.tts.streaming?.provider) && (cfg.voice?.voice_chat_mode || 'chained') === 'chained' && activeMatches() && ctx.rest) {
            const scope = await bounded(ctx.rest('/transport-scope', {timeoutMs:2000}))
            if (!activeMatches() || !scope?.qwen_enabled || !['127.0.0.1','localhost'].includes(scope.host) || Number(url.port || 80) !== scope.port || url.pathname !== scope.path || requestedProfile !== scope.profile) throw new Error('unrelated WebSocket owner')
            url.pathname = url.pathname.replace(/\/api\/audio\/speak-stream$/, '/api/plugins/hermes-speech/speak-stream')
            destination = url.toString()
            this.playbackObserver = createSpeechPlaybackObserver({ WebSocket: Native, onDispose: observer => playbackObservers.delete(observer) })
            if (this.playbackObserver) playbackObservers.add(this.playbackObserver)
          }
        }
      } catch { /* Unknown scope stays on the original transport. */ }
      if (this.readyState !== Native.CONNECTING) return
      const socket = protocols === undefined ? new Native(destination) : new Native(destination, protocols)
      this.socket = socket; socket.binaryType = this.binaryType
      socket.addEventListener('open', () => {
        this.readyState = Native.OPEN; this.protocol = socket.protocol; this.extensions = socket.extensions
        this.notify(new Event('open'))
      })
      socket.addEventListener('message', e => this.notify(new MessageEvent('message',{data:e.data,origin:e.origin})))
      socket.addEventListener('error', () => this.notify(new Event('error')))
      socket.addEventListener('close', e => {
        this.readyState = Native.CLOSED
        this.playbackObserver?.finishInput()
        this.notify(new CloseEvent('close',{code:e.code,reason:e.reason,wasClean:e.wasClean}))
      })
    }
    send(data) {
      if (this.readyState !== Native.OPEN) throw new DOMException('WebSocket is not open','InvalidStateError')
      this.socket.binaryType = this.binaryType
      this.socket.send(data)
      this.bufferedAmount = this.socket.bufferedAmount
    }
    close(code, reason) {
      this.playbackObserver?.interrupt()
      if (this.socket) {this.readyState=Native.CLOSING;this.socket.close(code,reason)}
      else if(this.readyState !== Native.CLOSED) {
        this.readyState=Native.CLOSED
        queueMicrotask(()=>this.notify(new CloseEvent('close',{code:code||1000,reason:reason||'',wasClean:true})))
      }
    }
  }
  const Wrapped = new Proxy(Native, {construct(Target,args) {
    let url
    try {url=new URL(String(args[0]))} catch {return Reflect.construct(Target,args)}
    const owner = host?.state?.focusedSessionOwner?.get()
    if (!owner || !host?.profileRoutes || !host?.requestProfile || !['127.0.0.1','localhost'].includes(url.hostname) || !url.pathname.endsWith('/api/audio/speak-stream')) {
      return Reflect.construct(Target,args)
    }
    return new ScopedSocket(args[0],args[1],{...owner})
  }})
  globalThis.WebSocket = Wrapped
  const dispose = () => {
    if(globalThis.WebSocket === Wrapped)globalThis.WebSocket = Native
    for (const observer of playbackObservers) observer.dispose()
    playbackObservers.clear()
  }
  ctx.onDispose(dispose)
  return dispose
}

// Observe only AudioBufferSourceNodes created synchronously by the scoped Qwen
// PCM socket's message callback. Keep original audio routing and scheduling.
export function createSpeechPlaybackObserver(options = {}) {
  const Context = options.AudioContext || globalThis.AudioContext
  if (!Context?.prototype?.createBufferSource) return null
  const sources = new Set()
  const id = `playback-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let stopped = false, inputDone = false, sample = null, offsetMs = 0, api
  const publisher = new SpeechEventPublisher(() => sample, () => inputDone && sources.size === 0 ? 'idle' : 'thinking', {
    Socket: options.WebSocket || globalThis.WebSocket, pending: () => !inputDone || sources.size > 0
  })
  const dispose = () => {
    if (stopped) return
    stopped = true; clearInterval(timer); sources.clear(); publisher.stop()
    try { options.onDispose?.(api) } catch {}
  }
  const interrupt = () => { if (!stopped) { publisher.interrupt('idle'); dispose() } }
  const tick = () => {
    if (stopped) return
    try {
      let square = 0, samples = 0, positionMs = sample?.positionMs || 0, paused = false
      for (const item of sources) {
        const context = item.source.context
        if (context.state === 'closed') { sources.delete(item); continue }
        if (context.state !== 'running') { paused = true; continue }
        const stamp = context.getOutputTimestamp?.()
        const clock = stamp?.contextTime > 0 ? stamp.contextTime : Math.max(0, context.currentTime - (context.outputLatency || 0))
        if (clock < item.at) continue
        if (clock >= item.at + item.duration) { positionMs = Math.max(positionMs, item.base + item.duration * 1000); sources.delete(item); continue }
        positionMs = Math.max(positionMs, item.base + (clock - item.at) * 1000)
        const buffer = item.source.buffer
        const begin = Math.max(0, Math.floor((clock - item.at + item.offset) * buffer.sampleRate))
        const end = Math.min(buffer.length, begin + Math.max(1, Math.round(buffer.sampleRate * .02)))
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const pcm = buffer.getChannelData(channel)
          for (let index = begin; index < end; index++) { square += pcm[index] * pcm[index]; samples++ }
        }
      }
      if (samples || (paused && sample)) sample = {turn:id,positionMs:Math.round(positionMs),rms:paused?0:Math.min(1,Math.sqrt(square/Math.max(1,samples))),paused,clock:'output_timestamp_or_latency_fallback'}
      else if (sample && sources.size) sample = {...sample,positionMs:Math.round(positionMs),rms:0,paused}
      else sample = null
      publisher.tick()
      if (inputDone && sources.size === 0) dispose()
    } catch { publisher.pause() }
  }
  const capture = dispatch => {
    if (stopped) return dispatch()
    const prototype = Context.prototype
    const original = prototype.createBufferSource
    const wrapped = function (...args) {
      const source = original.apply(this, args)
      const start = source.start, stop = source.stop
      source.start = function (when = 0, offset = 0, duration) {
        const result = start.apply(this, arguments)
        try {
          if (source.buffer && source.playbackRate?.value === 1 && !stopped) {
            const span = duration ?? Math.max(0, source.buffer.duration - offset)
            sources.add({source,at:Math.max(when,source.context.currentTime),offset,duration:span,base:offsetMs})
            offsetMs += span * 1000
          }
        } catch { /* Metadata failure cannot fail an audio start. */ }
        return result
      }
      source.stop = function () { const result = stop.apply(this, arguments); interrupt(); return result }
      return source
    }
    try { prototype.createBufferSource = wrapped; return dispatch() }
    finally { if (prototype.createBufferSource === wrapped) prototype.createBufferSource = original }
  }
  const timer = setInterval(tick, 40)
  api = {capture,tick,interrupt,dispose,publisher,finishInput() { inputDone=true;tick() }}
  publisher.start()
  return api
}

export const RealtimeCompatibility = {
  id: 'qwen-realtime-bridge',
  name: 'Qwen Realtime Bridge',
  description: `Adapts Hermes GPT-Live to ${REALTIME_MODEL}`,
  register(ctx, bridgeHost = null) {
    const NativePeerConnection = globalThis.RTCPeerConnection
    if (!NativePeerConnection) throw new Error('RTCPeerConnection is unavailable')
    const undoChainedTransport = installChainedTransport(ctx, bridgeHost)
    const voice = ctx.storage.get('voice', 'longanqian')
    const ensureReady = createBridgeReadiness((...args) => ctx.rest(...args))

    class QwenPeerConnection extends NativePeerConnection {
      constructor(...args) {
        super(...args)
        this.qwenAdapter = null
        this.qwenPausedSenders = []
        this.qwenAudioTracks = new Set()
        this.qwenStreamDispose = null
        this.qwenStream = null
        this.qwenPendingChannel = null
        const owner = bridgeHost?.state.focusedSessionOwner.get()
        this.qwenOwner = owner ? { ...owner, sessionId: bridgeHost.state.focusedSessionId.get() } : null
        this.qwenRequest = null
        this.qwenScope = null
        this.qwenHandoff = null
        super.addEventListener('track', event => {
          if (event.track?.kind === 'audio') this.qwenAudioTracks.add(event.track)
        })
        super.addEventListener('datachannel', event => {
          if (!this.qwenAdapter || event.channel?.label !== 'txt') return
          this.qwenAdapter.bindTransport(event.channel)
          event.channel.addEventListener('message', message => this.qwenAdapter?.onQwenMessage(message.data))
          event.channel.addEventListener('close', () => this.qwenEventsChannel?.dispatchEvent(new Event('close')))
        })
      }
      close() {
        const pending = this.qwenStream?.cancel(this.qwenDelegationId)
        if (pending) pending.finally(() => this.qwenStreamDispose?.()).catch(() => {})
        else this.qwenStreamDispose?.()
        return super.close()
      }
      async createOffer(options) {
        await this.qwenConfigure()
        if (this.qwenAdapter) await ensureReady()
        return super.createOffer(options)
      }
      async setRemoteDescription(description) {
        await this.qwenConfigure()
        if (this.qwenAdapter) {
          this.qwenPausedSenders = this.getSenders()
            .filter(sender => sender.track?.kind === 'audio')
            .map(sender => ({ sender, track: sender.track }))
          await Promise.all(this.qwenPausedSenders.map(({ sender }) => sender.replaceTrack(null)))
        }
        return super.setRemoteDescription(description)
      }
      createDataChannel(label, options) {
        const channel = super.createDataChannel(label, options)
        if (label !== 'oai-events') return channel
        const listeners = new Map()
        const add = channel.addEventListener.bind(channel), remove = channel.removeEventListener.bind(channel)
        channel.addEventListener = (type, listener, settings) => {
          if (type === 'message') listeners.set(listener, settings)
          add(type, listener, settings)
        }
        channel.removeEventListener = (type, listener, settings) => {
          if (type === 'message') listeners.delete(listener)
          remove(type, listener, settings)
        }
        this.qwenPendingChannel = {channel, listeners, add, remove}
        return channel
      }
      async qwenConfigure() {
        if (!this.qwenPendingChannel) return
        if (!this.qwenScope) this.qwenScope = this.qwenResolveScope()
        await this.qwenScope
      }
      async qwenResolveScope() {
        const pending = this.qwenPendingChannel
        const {channel, listeners, add, remove} = pending
        const restore = () => {channel.addEventListener = add; channel.removeEventListener = remove}
        try {
          const owner = this.qwenOwner
          if (!owner || !bridgeHost?.profileRoutes || !bridgeHost?.requestProfile) { restore(); return }
          const bounded = async promise => {
            let timer
            try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('config scope timeout')), 2000) })]) }
            finally { clearTimeout(timer) }
          }
          const routes = await bounded(bridgeHost.profileRoutes())
          const route = routes.find(r => (r.connectionId || 'local') === (owner.connectionId || 'local') && r.profile === owner.profile)
          if (!route) { restore(); return }
          const request = (method, params) => bridgeHost.requestProfile(route, method, params, 2000)
          const config = await bounded(request('config.get', {key:'full'}))
          if (!isQwenBridgeConfig(config)) { restore(); return }
          this.qwenRequest = request
          this.qwenVoice = config.config.voice.gpt_live.voice
        } catch { restore(); return }
        restore()
        for (const [listener, settings] of listeners) remove('message', listener, settings)
        const adapted = adaptChannel(channel, {
          voice: this.qwenVoice || voice,
          onInterrupt: id => {
            this.qwenHandoff = this.qwenStream?.cancel(id) || this.qwenHandoff
            this.qwenHandoff?.catch(error => console.warn('[qwen-realtime-bridge] cancel_confirmation_failed', error.message))
          },
          onDelegation: id => {
            const bind = () => {
            this.qwenStreamDispose?.()
            this.qwenDelegationId = id
            const owner = this.qwenOwner
            if (owner && !owner.sessionId) {
              const current = bridgeHost?.state.focusedSessionOwner.get()
              if (current?.connectionId === owner.connectionId && current?.profile === owner.profile) {
                owner.sessionId = bridgeHost.state.focusedSessionId.get()
              }
            }
            if (owner?.sessionId && ctx.onEvent) {
              this.qwenStream = createHermesStream(this.qwenAdapter, id, {...owner}, this.qwenRequest)
              this.qwenStreamDispose = ctx.onEvent('*', this.qwenStream)
            }
            }
            if (this.qwenHandoff) return this.qwenHandoff.then(bind)
            bind()
          },
          resumeInput: () => {
            const paused = this.qwenPausedSenders.splice(0)
            for (const { sender, track } of paused) {
              sender.replaceTrack(track).catch(error => console.error('[qwen-realtime-bridge] resume_input_failed', error))
            }
          },
          setPlaybackEnabled: enabled => {
            for (const track of this.qwenAudioTracks) track.enabled = enabled
          }
        })
        this.qwenEventsChannel = adapted
        this.qwenAdapter = adapted[ADAPTER]
        for (const listener of listeners.keys()) this.qwenAdapter.addHermesMessageListener(listener)
      }
    }
    globalThis.RTCPeerConnection = QwenPeerConnection
    ctx.onDispose(() => {
      undoChainedTransport()
      if (globalThis.RTCPeerConnection === QwenPeerConnection) {
        globalThis.RTCPeerConnection = NativePeerConnection
      }
    })
  }
}

