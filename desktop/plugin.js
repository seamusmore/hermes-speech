const WORKLET_SOURCE="class ContinuousPCM extends AudioWorkletProcessor {\n constructor(){super();this.buffer=new Int16Array(320);this.index=0;this.phase=0;this.sum=0;this.count=0;}\n process(inputs){const a=inputs[0]?.[0];if(!a)return true;\n  for(const x of a){this.sum+=x;this.count++;this.phase+=16000;\n   if(this.phase>=sampleRate){this.phase-=sampleRate;const v=Math.max(-1,Math.min(1,this.sum/this.count));this.buffer[this.index++]=Math.round(v*32767);this.sum=0;this.count=0;\n    if(this.index===320){this.port.postMessage(this.buffer.buffer,[this.buffer.buffer]);this.buffer=new Int16Array(320);this.index=0;}}}\n  return true;\n }\n}\nregisterProcessor('continuous-pcm',ContinuousPCM);\n\n";
// Pure state machines shared by the live plugin and offline acceptance tests.
class Journal {
  constructor(limit=3000) { this.limit=limit; this.rows=[]; this.started=Date.now(); }
  add(type, fields={}) { const row={at:Date.now(),ms:Date.now()-this.started,type,...fields};this.rows.push(row);if(this.rows.length>this.limit)this.rows.shift();try{globalThis.localStorage?.setItem('independent-voice-diagnostics-v1',JSON.stringify(this.rows.slice(-300)));}catch{}return row; }
  export() { return {schema:1,clock:'browser-wall-ms',audioClock:'AudioContext scheduled; physical audibility unmeasured',events:this.rows}; }
}
class CaptureGate {
  constructor(emit,{preFrames=30,onsetFrames=9,silenceFrames=35,maxFrames=1500}={}) {
    Object.assign(this,{emit,preFrames,onsetFrames,silenceFrames,maxFrames});this.ring=[];this.seq=0;this.active=null;this.above=0;this.quiet=0;this.frames=0;this.floor=.004;
  }
  push(pcm,playing=false) {
    const seq=this.seq++;let sum=0;for(const n of pcm)sum+=n*n;const rms=Math.sqrt(sum/Math.max(1,pcm.length))/32768;
    const threshold=playing?Math.max(.045,this.floor*4):Math.max(.012,this.floor*3);
    const voiced=rms>=threshold;
    if(!playing&&!voiced)this.floor=this.floor*.98+rms*.02;
    this.ring.push({pcm,seq});if(this.ring.length>this.preFrames)this.ring.shift();
    if(!this.active){
      this.above=voiced?this.above+1:0;
      if(this.above===4)this.emit({type:'candidate',seq,rms});
      if(this.above>=this.onsetFrames){this.active=`u-${seq}`;this.frames=this.ring.length;this.quiet=0;
        this.emit({type:'begin',id:this.active,seq:this.ring[0].seq});
        for(const f of this.ring)this.emit({type:'audio',id:this.active,...f});
      }else if(!voiced)this.emit({type:'candidate_clear',seq});
    }else{
      this.frames++;this.quiet=voiced?0:this.quiet+1;
      this.emit({type:'audio',id:this.active,pcm,seq});
      if(this.quiet>=this.silenceFrames||this.frames>=this.maxFrames){
        this.emit({type:'end',id:this.active,seq,speechSeq:seq-this.quiet,reason:this.frames>=this.maxFrames?'limit':'silence'});
        this.active=null;this.above=0;this.quiet=0;this.ring=[];
      }
    }
    return rms;
  }
}
function echoMatch(text,reference) {
  const norm=s=>String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const a=norm(text),b=norm(reference);if(!a||!b)return false;
  if(b.includes(a))return true;
  if(a.length<4)return false;
  const pairs=s=>new Set([...s].slice(1).map((v,i)=>s[i]+v));
  const aa=pairs(a);let best=0;
  for(let i=0;i<b.length;i+=Math.max(1,Math.floor(a.length/4))){const bb=pairs(b.slice(i,i+a.length+2));let shared=0;for(const x of aa)if(bb.has(x))shared++;best=Math.max(best,2*shared/(aa.size+bb.size||1));}
  return best>=.72;
}
class TurnText {
  constructor(emit){this.emit=emit;this.segment='';this.sent=0;this.closed=false;this.seen=false;}
  delta(text){if(this.closed)return;this.seen=true;this.segment+=text;this.flush(false);}
  flush(final){let end=this.sent;if(final)end=this.segment.length;else{const re=/[。！？!?\n]|\.(?=\s)/g;for(const m of this.segment.matchAll(re))if(m.index+1-this.sent>=8)end=m.index+1;}
    if(end>this.sent){const text=this.segment.slice(this.sent,end);this.sent=end;if(text.trim())this.emit(text);}}
  seal(text,already=false){if(this.closed)return;if(!already&&text){if(!this.segment)this.segment=text;else if(text.startsWith(this.segment))this.segment=text;else if(text!==this.segment)throw Error('Reply text changed after speech began');}this.flush(true);this.segment='';this.sent=0;this.seen=false;}
  finish(text=''){if(this.closed)return;if(text&&text.trim()===this.segment.trim())text=this.segment;if(text){if(!this.segment)this.segment=text;else if(text.startsWith(this.segment))this.segment=text;else if(!text.startsWith(this.segment.slice(0,this.sent)))throw Error('Final reply rewrote already spoken content');else this.segment=text;}this.flush(true);this.closed=true;}
}
class TurnLease {
  constructor(owner,emit,done){this.owner=owner;this.emit=emit;this.done=done;this.started=false;this.closed=false;this.seq=-1;this.epoch=null;this.text=new TurnText(emit);}
  event(e){if(this.closed||e.replayed||e.session_id!==this.owner.sessionId||(e.connectionId||'local')!==(this.owner.connectionId||'local')||(e.profile&&e.profile!==this.owner.profile))return;
    if(e.replayEpoch!==undefined){if(this.epoch!==null&&this.epoch!==e.replayEpoch)return this.close('connection_changed');this.epoch=e.replayEpoch;}
    if(typeof e.seq==='number'){if(e.seq<=this.seq)return;this.seq=e.seq;}
    const p=e.payload||{};
    if(e.type==='message.start'){if(this.started)return this.close('superseded');this.started=true;return;}
    if(!this.started)return;
    try{if(e.type==='message.delta')this.text.delta(p.text||'');
      if(e.type==='message.interim')this.text.seal(p.text||'',!!p.already_streamed);
      if(e.type==='message.complete'){if(['error','interrupted'].includes(p.status))return this.close(p.status);this.text.finish(p.response_previewed&&!p.response_transformed?'':p.text||'');this.close('complete');}}
    catch(err){this.close(e.type==='message.complete'?'final_text_changed':'text_changed');}
  }
  close(reason){if(this.closed)return;this.closed=true;this.done(reason);}
}
function percentile(values,q){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);return a[Math.max(0,Math.ceil(q*a.length)-1)];}


// Generic metadata publisher. Audio ownership never depends on this transport.
class SpeechEventPublisher {
 constructor(snapshot, activity=()=> 'listening', {Socket=globalThis.WebSocket, pending=()=>false}={}) {
  this.snapshot=snapshot;this.activity=activity;this.Socket=Socket;this.pending=pending;
  this.sourceId=`speech-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  this.segment=0;this.sampleTurn=null;this.stopped=true;this.last=null;this.lastActivity=null;this.ws=null;
 }
 start(){if(!this.stopped)return;this.stopped=false;this.connect();this.timer=setInterval(()=>this.tick(),40);}
 connect(){if(this.stopped)return;try{
  const ws=this.ws=new this.Socket('ws://127.0.0.1:18794/source');
  ws.onopen=()=>{if(this.ws!==ws||this.stopped)return;this.lastActivity=null;this.send({type:'publish',protocol:'speech-events',version:1});this.tick(true);};
  ws.onerror=()=>{};
  ws.onclose=()=>{if(this.ws!==ws)return;this.ws=null;if(!this.stopped)this.retry=setTimeout(()=>this.connect(),1500);};
 }catch{if(!this.stopped)this.retry=setTimeout(()=>this.connect(),1500);}}
 send(event){try{if(this.ws?.readyState===1&&this.ws.bufferedAmount<16384)this.ws.send(JSON.stringify(event));}catch{}}
 emitPlayback(playback){this.last=playback;this.send({type:'playback',playback});}
 tick(snapshot=false){if(this.stopped)return;try{
  let activity=this.activity();if(!['idle','listening','thinking'].includes(activity))activity='thinking';
  const sample=this.snapshot();let playback=this.last;
  if(sample?.turn){if(this.sampleTurn!==sample.turn||!playback||['ended','cancelled'].includes(playback.status)){this.segment++;this.sampleTurn=sample.turn;}playback={id:`${this.sourceId}:${this.segment}:${sample.turn}`,status:sample.paused?'paused':'playing',positionMs:Math.max(0,sample.positionMs||0),rms:sample.paused?0:Math.max(0,Math.min(1,sample.rms||0)),clock:sample.clock||'context_fallback'};}
  else if(playback&&['playing','paused'].includes(playback.status))playback={...playback,status:this.pending()?'playing':'ended',rms:0};
  this.last=playback;
  if(snapshot){this.send({type:'snapshot',activity,playback});this.lastActivity=activity;return;}
  if(activity!==this.lastActivity){this.lastActivity=activity;this.send({type:'activity',activity});}
  if(playback)this.send({type:'playback',playback});
 }catch{this.pause();}}
 pause(){if(this.last&&['playing','paused'].includes(this.last.status))this.emitPlayback({...this.last,status:'paused',rms:0});}
 interrupt(next='listening'){if(this.last&&['playing','paused'].includes(this.last.status))this.emitPlayback({...this.last,status:'cancelled',rms:0});this.lastActivity=next;this.send({type:'activity',activity:next});}
 stop(){if(this.stopped)return;this.interrupt('idle');this.stopped=true;clearInterval(this.timer);clearTimeout(this.retry);const ws=this.ws;this.ws=null;try{ws?.close();}catch{}}
}


class Playback {
  constructor(context,journal,change=()=>{}){this.ctx=context;this.journal=journal;this.change=change;this.nodes=new Set();this.cursor=0;this.paused=false;this.generation=0;this.total=0;this.completed=0;this.blocks=[];this.positions=new Map();this.lastSample=null;}
  get buffered(){return Math.max(0,this.cursor-this.ctx.currentTime);}
  get active(){return this.nodes.size>0;}
  get echoRisk(){return this.active||Date.now()-(this.lastOutputAt||0)<800;}
  enqueue(pcm,id,turnId=id){
    if(pcm.byteLength%2)throw Error('Invalid PCM block');
    if(this.buffered>60)throw Error('Playback exceeded 60 seconds; stopped to preserve bounded memory');
    const samples=new Int16Array(pcm.buffer,pcm.byteOffset,pcm.byteLength/2);
    const buffer=this.ctx.createBuffer(1,samples.length,24000),data=buffer.getChannelData(0);
    for(let i=0;i<samples.length;i++)data[i]=samples[i]/32768;
    const node=this.ctx.createBufferSource();node.buffer=buffer;node.connect(this.ctx.destination);
    const at=Math.max(this.ctx.currentTime+.025,this.cursor), generation=this.generation;
    this.cursor=at+buffer.duration;this.total+=buffer.duration;this.nodes.add(node);
    node.onended=()=>{this.lastOutputAt=Date.now();this.nodes.delete(node);node.disconnect();if(generation===this.generation)this.completed+=buffer.duration;this.change();};
    const offset=this.positions.get(turnId)||0;this.positions.set(turnId,offset+buffer.duration*1000);if(this.positions.size>100)this.positions.delete(this.positions.keys().next().value);
    this.blocks.push({turn:turnId,start:at,end:this.cursor,data,offset});node.start(at);return at;
  }
  snapshot(){
    if(this.paused)return this.lastSample?{...this.lastSample,rms:0,paused:true}:null;
    const stamp=this.ctx.getOutputTimestamp?.();const valid=stamp&&stamp.contextTime>0&&Number.isFinite(stamp.performanceTime);
    const clock=valid?Math.min(this.ctx.currentTime,stamp.contextTime+Math.max(0,performance.now()-stamp.performanceTime)/1000):this.ctx.currentTime;
    const block=this.blocks.find(b=>clock>=b.start&&clock<b.end);this.blocks=this.blocks.filter(b=>b.end>=clock-.1);
    if(!block)return null;
    const index=Math.floor((clock-block.start)*24000),end=Math.min(block.data.length,index+960);let sum=0;for(let i=index;i<end;i++)sum+=block.data[i]*block.data[i];
    const next={turn:block.turn,positionMs:Math.round(block.offset+(clock-block.start)*1000),rms:Math.min(1,Math.sqrt(sum/Math.max(1,end-index))),paused:false,clock:valid?'output_timestamp':'context_fallback'};
    if(this.lastSample?.turn===next.turn)next.positionMs=Math.max(this.lastSample.positionMs,next.positionMs);this.lastSample=next;return next;
  }
  async pause(){if(this.paused)return;this.paused=true;await this.ctx.suspend();this.journal.add('playback.pause',{buffered_ms:Math.round(this.buffered*1000)});this.change();}
  async resume(){if(!this.paused)return;this.paused=false;await this.ctx.resume();this.journal.add('playback.resume',{buffered_ms:Math.round(this.buffered*1000)});this.change();}
  cancel(){if(this.active)this.lastOutputAt=Date.now();this.blocks=[];this.positions.clear();this.lastSample=null;this.generation++;for(const node of this.nodes){node.onended=null;try{node.stop();node.disconnect();}catch{}}this.nodes.clear();this.cursor=this.ctx.currentTime;this.total=0;this.completed=0;this.journal.add('playback.cancel');this.change();}
}


const REALTIME_MODEL = 'qwen-audio-3.1-realtime-plus'
const TOOL_NAME = 'delegate_to_hermes'
const ADAPTER = Symbol('qwen-realtime-adapter')
function eventId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
function parse(raw) {
  try { return JSON.parse(String(raw)) } catch { return null }
}
function createQwenAdapter(channel, options = {}) {
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
function speechPrefix(raw, final = false) {
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
function createHermesStream(adapter, delegationId, owner, request = null) {
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

function isQwenBridgeConfig(result) {
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
function createBridgeReadiness(rest, timeoutMs = 15000) {
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
function installChainedTransport(ctx, host) {
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
          const speech = cfg?.plugins?.entries?.['hermes-speech']?.settings || {}
          const speechTts = {...(cfg?.tts?.http_tts || {}), ...(speech.tts || {})}
          const backend = speech.tts?.backend ?? speech.backend ?? speech.tts?.provider ?? speechTts.backend
          if (['http-speech','http_tts'].includes(cfg?.tts?.provider) && backend === 'qwen' && speechTts.streaming !== false && cfg.tts.streaming !== false && cfg.tts.streaming?.enabled !== false && [undefined,'','http-speech','http_tts'].includes(cfg.tts.streaming?.provider) && (cfg.voice?.voice_chat_mode || 'chained') === 'chained' && activeMatches() && ctx.rest) {
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
function createSpeechPlaybackObserver(options = {}) {
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

const RealtimeCompatibility = {
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

/** Desktop-only implementation of the documented SpeechHostPort contract. */
class DesktopHostAdapter {
  constructor(sdk) {
    this.sdk = sdk;
    this.state = sdk.state;
    this.composer = sdk.composer;
  }
  profileRoutes(...args) { return this.sdk.profileRoutes(...args); }
  requestProfile(...args) { return this.sdk.requestProfile(...args); }
  navigate(...args) { return this.sdk.navigate(...args); }
  locationKey() { return globalThis.location?.hash || ''; }
}


const uid=prefix=>`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const base64=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);};
const decode=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));
class ChainedController {
 constructor(ctx,host,workletSource){
   this.ctx=ctx;this.host=host;this.workletSource=workletSource;this.journal=new Journal();this.listeners=new Set();this.state='未连接';this.error='';this.running=false;this.starting=false;this.caption='';this.messages=[];this.turns=[];this.utterances=new Map();this.speechQueue=[];this.tts=null;this.turn=null;this.owner=null;this.frames=0;this.gaps=0;this.peak=0;this.candidate=false;this.disposed=false;this.chain=Promise.resolve();
   this.off=ctx.onEvent('*',e=>this.onGateway(e));
   this.selection=this.ownerNow();this.timer=setInterval(()=>{this.pump();this.checkOwner();this.changed();},150);
 }
 subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
 changed(){for(const fn of this.listeners)fn();}
 mark(type,fields={}){this.journal.add(type,fields);this.changed();}
 ownerNow(){
  const o=this.host.state.focusedSessionOwner.get(),sessionId=this.host.state.focusedSessionId.get();
  const stored=this.host.state.focusedStoredSessionId?.get();
  return o&&(sessionId||!stored)?{...o,sessionId:sessionId||null}:null;
 }
 checkOwner(){
  const now=this.ownerNow();this.selection=now;
  if(!(this.running||this.starting)||!this.owner)return;
  const changed=!now||now.profile!==this.owner.profile||now.connectionId!==this.owner.connectionId;
  const pending=this.draftBinding;
  if(changed||(pending&&now.sessionId&&pending.existing.has(now.sessionId))||
     (!pending&&now.sessionId!==this.owner.sessionId)||
     (!pending&&!now.sessionId&&this.draftLocation!==undefined&&this.draftLocation!==(this.host.locationKey())))this.fail('已切换聊天或配置，独立语音已停止。');
 }
 currentInput(input){return input.callGeneration===undefined||input.callGeneration===(this.startGeneration||0);}

 async probe(){
  try{this.error='';const profile=(this.ownerNow()||this.selection)?.profile||this.host.state.focusedSessionOwner.get()?.profile;const b=await this.ctx.rest(`/bootstrap?profile=${encodeURIComponent(profile||'default')}`,{method:'POST',timeoutMs:10000});if(b.protocol!==1)throw Error('协议不匹配');this.state='后端就绪';this.mark('transport.checked',{protocol:b.protocol,capture_rate:b.capture_rate,playback_rate:b.playback_rate});}catch(err){this.error=err.message;this.state='后端未就绪';this.changed();}
 }
 async start(){
  if(this.running||this.starting||this.stopping||this.failing||this.disposed)return;
  this.chain=Promise.resolve();this.starting=true;this.error='';this.state='连接中';this.changed();
  const generation=this.startGeneration=(this.startGeneration||0)+1;
  try{
   this.owner=this.ownerNow();if(!this.owner)throw Error('当前聊天尚在加载，请稍后开启语音。');
   this.draftLocation=globalThis.location?.hash||'';
   const focused=this.host.state.focusedSessionOwner.get();if(focused&&(focused.profile!==this.owner.profile||focused.connectionId!==this.owner.connectionId))throw Error('请重新选择当前配置下的会话。');
   if(this.owner.connectionId!=='local')throw Error('当前版本支持本机 Hermes 会话。');
   if(this.host.state.busyBySession.get()[this.owner.sessionId])throw Error('请等待当前回复完成后开启独立语音。');
   if(typeof this.host.composer?.submit!=='function')throw Error('桌面版缺少聊天发送接口。');
   const routes=await this.host.profileRoutes();this.route=routes.find(r=>r.profile===this.owner.profile&&(r.connectionId||'local')===this.owner.connectionId);
   if(!this.route||this.route.mode!=='local')throw Error('当前会话的本地连接尚未就绪。');
   const bootstrap=await this.ctx.rest(`/bootstrap?profile=${encodeURIComponent(this.owner.profile)}`,{method:'POST',timeoutMs:10000});
   if(bootstrap.speech_gate!==1)throw Error('语音后端需要重载：人声检测尚未启用。');
   this.checkOwner();if(generation!==this.startGeneration)return;
   const url=new URL(bootstrap.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.protocol!=='ws:')throw Error('独立音频通道要求本地回环连接。');
   this.playContext=new AudioContext({sampleRate:24000});await this.playContext.resume();
   this.player=new Playback(this.playContext,this.journal,()=>this.changed());
   await new Promise((resolve,reject)=>{
    const socket=this.socket=new WebSocket(url);let settled=false;
    const timer=setTimeout(()=>{socket.close();reject(Error('语音后端连接超时。'));},10000);
    socket.onmessage=e=>{if(generation!==this.startGeneration)return;try{const m=JSON.parse(e.data);if(m.type==='ready'){settled=true;clearTimeout(timer);resolve();}else this.onTransport(m);}catch(err){this.fail(err.message);}};
    socket.onerror=()=>{clearTimeout(timer);if(generation!==this.startGeneration)return;if(!settled)reject(Error('语音后端连接失败。'));else this.fail('语音通道出错。');};
    socket.onclose=()=>{clearTimeout(timer);if(generation!==this.startGeneration)return;if(!settled)reject(Error('语音后端关闭了连接。'));else if(this.running)this.fail('语音通道已断开，请重新连接。');};
   });
   if(generation!==this.startGeneration)return;
   const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   if(generation!==this.startGeneration){stream.getTracks().forEach(t=>t.stop());return;}
   this.media=stream;this.captureContext=new AudioContext();
   const workletURL=URL.createObjectURL(new Blob([this.workletSource],{type:'text/javascript'}));
   try{await this.captureContext.audioWorklet.addModule(workletURL);}finally{URL.revokeObjectURL(workletURL);}
   if(generation!==this.startGeneration)return;
   this.source=this.captureContext.createMediaStreamSource(stream);this.worklet=new AudioWorkletNode(this.captureContext,'continuous-pcm');
   this.silent=this.captureContext.createGain();this.silent.gain.value=0;this.source.connect(this.worklet);this.worklet.connect(this.silent);this.silent.connect(this.captureContext.destination);
   this.events=new SpeechEventPublisher(()=>this.player?.snapshot(),()=>this.turn&&!this.turn.terminal?'thinking':'listening',{pending:()=>!!(this.player?.active||this.tts||this.speechQueue.length)});
   this.events.start();this.gate=new CaptureGate(e=>this.onCapture(e));this.frames=0;this.gaps=0;this.started=Date.now();this.running=true;this.state='持续聆听';
   this.worklet.port.onmessage=e=>{if(!this.running)return;try{const pcm=new Int16Array(e.data);this.frames++;this.peak=this.gate.push(pcm,!!(this.player?.active||this.tts));}catch(err){this.fail(err.message);}};
   stream.getTracks().forEach(t=>t.onended=()=>{if(this.running)this.fail('麦克风已断开。');});
   await this.captureContext.resume();this.mark('capture.started',{rate:this.captureContext.sampleRate,frame_ms:20,preroll_ms:600,echo_cancellation:stream.getAudioTracks()[0].getSettings().echoCancellation===true});
  }catch(err){await this.stop();this.error=err.message;this.state='连接失败';}
  finally{this.starting=false;this.changed();}
 }
 send(message){if(this.socket?.readyState!==1)throw Error('Audio transport is closed');if(this.socket.bufferedAmount>256000)throw Error('Audio upload backlog exceeded limit');this.socket.send(JSON.stringify(message));}
 onCapture(e){
  if(e.type==='candidate'){
   this.candidate=true;if(this.player.active){this.events?.pause();this.player.pause().catch(err=>this.fail(err.message));this.state='确认是否为打断';this.mark('barge.candidate');}
  }else if(e.type==='candidate_clear'){
   if(this.candidate&&!this.gate.active){this.candidate=false;this.maybeResume('short_noise');}
  }else if(e.type==='begin'){
   const u={id:e.id,callGeneration:this.startGeneration||0,started:Date.now(),reference:this.reference(),wasPlaying:!!(this.player.echoRisk||this.tts||this.turn&&!this.turn.terminal),confirmed:false};
   this.utterances.set(e.id,u);this.send({type:'asr.begin',id:e.id,playing:u.wasPlaying});this.mark('speech.begin',{id:e.id,seq:e.seq});
  }else if(e.type==='audio'){
   this.send({type:'asr.audio',id:e.id,seq:e.seq,pcm:base64(new Uint8Array(e.pcm.buffer,e.pcm.byteOffset,e.pcm.byteLength))});
  }else if(e.type==='end'){
   const u=this.utterances.get(e.id);u.speechEnd=Date.now()-(e.seq-e.speechSeq)*20;u.captureEnd=Date.now();
   this.send({type:'asr.end',id:e.id});this.candidate=false;this.mark('speech.end',{id:e.id,speech_end_at:u.speechEnd,hangover_ms:u.captureEnd-u.speechEnd,seq:e.seq});
  }
 }
 reference(){return this.messages.filter(m=>m.role==='assistant').slice(-1).map(m=>m.text).join('');}
 maybeResume(reason){
  if([...this.utterances.values()].some(u=>!u.final))return;
  if(this.player?.paused){this.player.resume().catch(err=>this.fail(err.message));this.mark('barge.rejected',{reason});}
  if(this.running)this.state='持续聆听';
 }
 onTransport(m){
  if(m.type==='error'&&m.code==='tts_failed'&&this.tts?.id===m.id&&this.tts.cancelled)return;
  if(m.type==='error'){this.mark('transport.error',{id:m.id,code:m.code});this.fail(`语音服务错误：${m.code}`);return;}
  if(m.type==='asr.ready'){this.mark(m.type,{id:m.id,reused:m.reused,connection:m.connection,handshake_ms:m.handshake_ms});return;}
  if(m.type==='asr.partial'||m.type==='asr.final'){
   const u=this.utterances.get(m.id);if(!u)return;this.caption=m.text;const now=Date.now();
   if(!u.firstPartial&&m.text){u.firstPartial=now;this.mark('asr.first_partial',{id:m.id,from_onset_ms:now-u.started});}
   // Partials may update captions; only a speech-verified final can cancel or submit.
   if(m.type==='asr.final'){
    u.final=true;u.finalAt=now;this.mark('asr.final',{id:m.id,chars:m.text.length,after_speech_ms:now-(u.speechEnd||now)});
    const echo=u.wasPlaying&&echoMatch(m.text,this.reference()||u.reference);
    const verified=m.speech?.version===1&&m.speech.accepted===true;
    this.mark('asr.admission',{id:m.id,verified,echo,playing_at_onset:u.wasPlaying,speech_ms:m.speech?.speech_ms,peak_probability:m.speech?.peak_probability,reason:m.speech?.reason||'missing_speech_evidence'});
    if(!verified||!m.text.trim()||echo){const reason=!verified?'speech_gate':echo?'echo':'empty';this.mark('asr.filtered',{id:m.id,reason});this.utterances.delete(m.id);this.maybeResume(reason);}
    else {this.confirm(u);this.messages.push({role:'user',text:m.text,id:m.id});this.messages=this.messages.slice(-60);this.chain=this.chain.then(()=>this.currentInput(u)&&this.running?this.submit(m.text,u):undefined).catch(err=>{if(this.currentInput(u)&&this.running)this.fail(err.message);});}
   }
   this.changed();return;
  }
  if(m.type==='asr.closed')return;
  if(m.type==='tts.pcm'){
   const task=this.tts;if(!task||task.id!==m.id||task.cancelled)return;
   const turn=task.turn;if(turn.cancelled||turn.speechMuted)return;
   if(!turn.firstPCM){turn.firstPCM=Date.now();this.mark('tts.first_pcm',{id:turn.id,after_speech_ms:turn.firstPCM-turn.input.speechEnd});}
   const at=this.player.enqueue(decode(m.pcm),m.id,turn.id);
   if(!turn.firstScheduled){turn.firstScheduled=Date.now();turn.scheduledDelay=Math.round((at-this.player.ctx.currentTime)*1000);this.mark('playback.first_scheduled',{id:turn.id,after_speech_ms:turn.firstScheduled-turn.input.speechEnd,queue_delay_ms:turn.scheduledDelay,physical_audibility:'unmeasured'});}
   return;
  }
  if(m.type==='tts.done'&&this.tts?.id===m.id){this.tts.done=true;this.mark('tts.done',{id:m.id,bytes:m.bytes,elapsed_ms:m.elapsed_ms});}
  if(m.type==='tts.closed'&&this.tts?.id===m.id){const t=this.tts;this.tts=null;if(!t.done&&!t.cancelled)this.fail('合成任务提前结束。');else this.pump();}
 }
 confirm(u){
  if(!this.currentInput(u)||u.confirmed)return;u.confirmed=true;this.mark('barge.confirmed',{id:u.id});
  u.cancelReady=this.cancelTurn('speech');u.cancelReady.catch(err=>this.fail(err.message));
 }
 get canStopReading(){return !!(this.running&&this.turn&&!this.turn.speechMuted&&(!this.turn.terminal||this.tts||this.speechQueue.length||this.player?.active));}
 async stopReading(){
  const turn=this.turn;if(!this.canStopReading)return;
  turn.speechMuted=true;
  this.speechQueue=this.speechQueue.filter(task=>task.turn!==turn);
  if(this.tts?.turn===turn&&!this.tts.cancelled){this.tts.cancelled=true;this.send({type:'tts.cancel',id:this.tts.id});}
  this.player?.cancel();this.events?.interrupt('listening');
  this.mark('playback.user_stopped',{turn_id:turn.id});
  if(this.player?.paused)await this.player.resume();
  if(this.running)this.state='持续聆听';this.changed();
 }
 async cancelTurn(reason){
  const turn=this.turn;if(turn&&(!turn.terminal||this.tts||this.speechQueue.length||this.player?.active))turn.cancelled=true;this.events?.interrupt(reason==='stop'?'idle':'listening');
  this.speechQueue=[];
  if(this.tts&&!this.tts.cancelled){this.tts.cancelled=true;this.send({type:'tts.cancel',id:this.tts.id});}
  this.player?.cancel();if(this.player?.paused)await this.player.resume();
  if(!turn||turn.terminal)return;
  if(turn.cancelReady)return turn.cancelReady;
  turn.cancelled=true;this.mark('turn.cancel_requested',{id:turn.id,reason});
  turn.cancelReady=new Promise((resolve,reject)=>{turn.cancelResolve=resolve;turn.cancelReject=reject;turn.cancelTimer=setTimeout(()=>reject(Error('Hermes 尚未确认中断，本轮语音已停止。')),10000);});
  turn.cancelReady.catch(()=>{});
  if(turn.lease.started)this.sendInterrupt(turn);
  return turn.cancelReady;
 }
 sendInterrupt(turn){
  if(turn.interruptSent)return;turn.interruptSent=true;
  this.host.requestProfile(this.route,'session.interrupt',{session_id:this.owner.sessionId},10000).then(result=>{
   if(result?.status==='not_interrupted'&&!turn.terminal)throw Error('Hermes 未接受本轮中断。');
   turn.rpcStopped=true;this.settleCancel(turn);
  }).catch(err=>{clearTimeout(turn.cancelTimer);turn.cancelReject?.(err);});
 }
 settleCancel(turn){if(turn.rpcStopped&&turn.terminal){clearTimeout(turn.cancelTimer);this.mark('turn.cancel_confirmed',{id:turn.id});turn.cancelResolve?.();}}
 onGateway(e){
  if(this.draftBinding){const p=this.draftBinding;if(!e.replayed&&(e.connectionId||'local')===this.owner.connectionId&&(!e.profile||e.profile===this.owner.profile)){p.events.push(e);p.bytes+=JSON.stringify(e).length;if(p.events.length>1000||p.bytes>500000)this.fail('首句回复缓冲已满，请重新开启语音。');}return;}
  const turn=this.turn;if(!turn)return;
  turn.lease.event(e);
  if(turn.cancelled&&turn.lease.started&&!turn.terminal)this.sendInterrupt(turn);
 }
 async bindDraft(text,input){
  const generation=this.startGeneration||0;
  const valid=()=>this.running&&this.currentInput(input)&&generation===(this.startGeneration||0);
  const baseline=await this.host.requestProfile(this.route,'session.active_list',{},10000);
  if(!valid())return null;
  this.checkOwner();if(!valid()||this.ownerNow()?.sessionId)return null;
  const pending={existing:new Set((baseline.sessions||[]).map(s=>s.id)),events:[],bytes:0,sentAt:Date.now()/1000};
  this.draftBinding=pending;this.state='正在发送第一句话';
  try{
   // The exact visible blank composer owns creation, configuration and first send.
   if(!this.host.composer.submit('new',text))throw Error('当前新聊天未接收语音，请留在聊天页面重试。');
   this.mark('draft.first_submitted',{input_id:input.id});
   const deadline=Date.now()+30000;
   while(valid()&&Date.now()<deadline){
    this.checkOwner();if(!valid())return null;
    const now=this.ownerNow();
    if(now?.sessionId){
     const listing=await this.host.requestProfile(this.route,'session.active_list',{},10000);
     if(!valid())return null;
     const fresh=(listing.sessions||[]).filter(x=>!pending.existing.has(x.id)&&x.started_at>=pending.sentAt-1);
     // Require one newly created runtime and its first persisted user message.
     // Merely focusing a session can never establish ownership.
     if(fresh.length>1)throw Error('同时出现多个新聊天，语音已停止以避免串会话。');
     if(fresh.length===1&&fresh[0].id===now.sessionId){
      const history=await this.host.requestProfile(this.route,'session.history',{session_id:now.sessionId},10000);
      if(!valid())return null;
      this.checkOwner();const latest=this.ownerNow();if(!valid()||latest?.sessionId!==now.sessionId)throw Error('首句发送期间切换了聊天，语音已停止。');
      const users=(history.messages||[]).filter(m=>m.role==='user');
      if(users.length&&((users[0].content??users[0].text??'').trim()!==text.trim()||users[0].timestamp<pending.sentAt-1))throw Error('新聊天首句与本次语音不一致，已停止绑定。');
      if(users.length===1&&Number.isFinite(users[0].timestamp)&&users[0].timestamp>=pending.sentAt-1){
       this.owner={...now};this.mark('draft.bound',{session_id:now.sessionId,input_id:input.id});return pending.events;
      }
      if(users.length>1)throw Error('新聊天已有其他输入，已停止自动绑定。');
     }else if(!fresh.some(x=>x.id===now.sessionId))throw Error('当前聊天不属于本次语音新建，已停止绑定。');
    }
    await new Promise(r=>setTimeout(r,100));
   }
   if(valid())throw Error('等待新聊天确认超时；请检查首句是否已发送，语音不会重复发送。');
   return null;
  }finally{if(this.draftBinding===pending)this.draftBinding=null;}
 }
 async submit(text,input){
  if(!this.currentInput(input))return;
  await input.cancelReady;if(!this.running||!this.currentInput(input))return;
  await this.cancelTurn('next_input');if(!this.running||!this.currentInput(input))return;
  this.checkOwner();if(!this.running)return;
  const firstDraft=!this.owner.sessionId;
  const earlyEvents=firstDraft?await this.bindDraft(text,input):null;
  if(!this.running||!this.currentInput(input)||(firstDraft&&!earlyEvents))return;
  // A terminal event precedes the gateway clearing running by a small interval.
  const deadline=Date.now()+2000;
  while(!firstDraft&&this.host.state.busyBySession.get()[this.owner.sessionId]){if(Date.now()>deadline)throw Error('当前会话仍忙碌，请稍后重试。');await new Promise(r=>setTimeout(r,50));}
  if(!this.running||!this.currentInput(input))return;
  this.checkOwner();if(!this.running)return;
  const turn={id:uid('t'),input,submitted:Date.now(),cancelled:false,terminal:false};
  this.error='';this.turn=turn;this.turns.push(turn);this.turns=this.turns.slice(-100);
  const reply={role:'assistant',text:'',id:turn.id};this.messages.push(reply);
  turn.lease=new TurnLease(this.owner,sentence=>{if(turn.cancelled||turn.speechMuted)return;this.speechQueue.push({id:uid('s'),text:sentence,turn});if(this.speechQueue.length>100)this.fail('待播内容超过队列上限。');else this.pump();},reason=>{
   turn.terminal=true;this.mark('turn.terminal',{id:turn.id,reason});if(turn.cancelled&&!['complete','interrupted','error'].includes(reason)){clearTimeout(turn.cancelTimer);turn.cancelReject?.(Error('原回复的终止归属已失效。'));}else this.settleCancel(turn);
   if(!turn.cancelled&&reason!=='complete'){
    if(['error','interrupted','final_text_changed'].includes(reason)){
     // The gateway has ended this turn. Keep capture and the duplex transport owned by the call.
     this.error=`本轮回复已结束（${reason}），可以继续说话。`;
     this.mark('turn.recovered',{id:turn.id,reason});
     this.cancelTurn('reply_ended').catch(err=>this.fail(err.message));
    }else this.fail(`Hermes 回复结束：${reason}`);
   }
   if(this.running)this.state='持续聆听';
  });
  const leaseEvent=turn.lease.event.bind(turn.lease);
  turn.lease.event=e=>{
   const valid=!e.replayed&&e.session_id===this.owner.sessionId&&(e.connectionId||'local')===this.owner.connectionId&&(!e.profile||e.profile===this.owner.profile);
   if(valid&&!turn.cancelled){
    if(e.type==='message.delta'&&(!Number.isFinite(e.seq)||e.seq>turn.lease.seq)){
     if(!turn.firstText){turn.firstText=Date.now();this.mark('reply.first_text',{id:turn.id,after_speech_ms:turn.firstText-input.speechEnd});}
     reply.text+=e.payload?.text||'';
    }
    if(e.type==='message.complete'&&!reply.text)reply.text=e.payload?.text||'';
   }
   leaseEvent(e);this.changed();
  };
  this.utterances.delete(input.id);this.mark('turn.submitted',{id:turn.id,input_id:input.id});this.state='Hermes 回复中';
  if(firstDraft){for(const event of earlyEvents)this.onGateway(event);return;}
  // The dedicated plugin route has no mounted chat composer.
  const inVoicePage=(this.host.locationKey()).split('?')[0]==='#/speech';
  if(inVoicePage){
   const result=await this.host.requestProfile(this.route,'prompt.submit',{session_id:this.owner.sessionId,text,queued:true},15000);
   if(result?.status&&!['started','ok','accepted','submitted','running','streaming'].includes(result.status))throw Error(`Hermes 提交状态：${result.status}`);
   this.mark('turn.page_dispatched',{id:turn.id,input_id:input.id});return;
  }
  // The desktop send pipeline inserts the user row before starting the agent.
  const composerId=this.host.state.focusedStoredSessionId?.get();
  if(!composerId||!this.host.composer?.submit(composerId,text)){
   turn.terminal=true;turn.lease.closed=true;reply.failed=true;
   input.delivery='rejected';input.text=text;
   this.error='本句未发送：当前聊天输入框未就绪。语音保持开启，请回到聊天后重说。';
   this.state='持续聆听';this.mark('turn.dispatch_rejected',{id:turn.id,input_id:input.id});return;
  }
  this.mark('turn.composer_dispatched',{id:turn.id,input_id:input.id,composer_id:composerId});
 }
 pump(){
  if(!this.running||this.tts||!this.speechQueue.length||this.player?.paused||this.player?.buffered>12)return;
  const task=this.speechQueue.shift();if(task.turn.cancelled||task.turn.speechMuted)return this.pump();
  this.tts=task;try{this.send({type:'tts.begin',id:task.id,text:task.text});this.mark('tts.requested',{id:task.id,turn_id:task.turn.id,chars:task.text.length});}catch(err){this.fail(err.message);}
 }
 async stop(){
  if(this.stopping)return this.stopping;
  this.stopping=this.stopResources();
  try{await this.stopping;}finally{this.stopping=null;this.changed();}
 }
 async stopResources(){
  this.startGeneration=(this.startGeneration||0)+1;this.running=false;this.starting=false;this.draftBinding=null;
  this.events?.stop();this.events=null;
  this.media?.getTracks().forEach(t=>t.stop());this.media=null;
  if(this.worklet)this.worklet.port.onmessage=null;
  if(this.turn&&!this.turn.terminal){try{await this.cancelTurn('stop');}catch(err){this.error=err.message;}}
  this.source?.disconnect();this.worklet?.disconnect();this.silent?.disconnect();
  await this.captureContext?.close().catch(()=>{});this.captureContext=null;
  this.player?.cancel();await this.playContext?.close().catch(()=>{});this.playContext=null;this.player=null;
  if(this.socket){this.socket.onclose=null;this.socket.onerror=null;this.socket.onmessage=null;this.socket.close();this.socket=null;}
  this.speechQueue=[];this.tts=null;this.turn=null;this.utterances.clear();this.candidate=false;this.state='已停止';this.mark('capture.stopped',{frames:this.frames,capture_ms:this.frames*20});
 }
 fail(message){if(this.failing)return;this.failing=true;this.error=message;this.mark('session.error',{code:message});this.stop().finally(()=>{this.error=message;this.state='需要重新连接';this.failing=false;this.changed();});}
 async dispose(){this.disposed=true;clearInterval(this.timer);this.off?.();await this.stop();this.listeners.clear();}
 report(){return {...this.journal.export(),summary:{capture_frames:this.frames,capture_ms:this.frames*20,physical_audibility:'unmeasured',p95_speech_to_pcm_ms:percentile(this.turns.filter(t=>t.firstPCM&&t.input.speechEnd).map(t=>t.firstPCM-t.input.speechEnd),.95)},turns:this.turns.map(t=>({id:t.id,input_id:t.input.id,speech_end:t.input.speechEnd,asr_final:t.input.finalAt,first_text:t.firstText,first_pcm:t.firstPCM,first_scheduled:t.firstScheduled,queue_delay_ms:t.scheduledDelay,cancelled:t.cancelled}))};}
}


function runDemo(){
 const events=[],gate=new CaptureGate(e=>{if(e.type!=='audio'&&e.type!=='candidate_clear')events.push(e);});
 const silence=new Int16Array(320),voice=new Int16Array(320).fill(6000);
 for(let i=0;i<40;i++)gate.push(silence);
 for(let i=0;i<30;i++)gate.push(voice);
 for(let i=0;i<40;i++)gate.push(silence);
 const firstEnd=gate.seq;
 for(let i=0;i<30;i++)gate.push(voice);
 for(let i=0;i<40;i++)gate.push(silence);
 const spoken=[];let terminal;
 const owner={sessionId:'demo',profile:'default',connectionId:'local'};
 const lease=new TurnLease(owner,t=>spoken.push(t),r=>terminal=r);
 let seq=0;const send=(type,payload,id)=>lease.event({type,payload,session_id:'demo',connectionId:'local',profile:'default',seq:seq++,message_id:id});
 send('message.start',{},'live-row');
 send('message.delta',{text:'第一句话会进入播放队列。'},'live-row');
 send('message.delta',{text:'第二句话也会接着进入队列。'},'saved-row');
 send('message.delta',{text:'第三句话仍归属同一轮回复。'},'saved-row');
 send('message.complete',{text:'第一句话会进入播放队列。第二句话也会接着进入队列。第三句话仍归属同一轮回复。',status:'complete'},'saved-row');
 const nodes=[],context={currentTime:0,destination:{},createBuffer:(c,n,r)=>({duration:n/r,getChannelData:()=>new Float32Array(n)}),createBufferSource:()=>{const node={connect(){},disconnect(){},start(at){this.at=at;},stop(){this.stopped=true;}};nodes.push(node);return node;},suspend:()=>Promise.resolve(),resume:()=>Promise.resolve()};
 const playback=new Playback(context,new Journal());for(let i=0;i<3;i++)playback.enqueue(new Uint8Array(4800),String(i));const starts=nodes.map(n=>n.at);void playback.pause();const held=playback.nodes.size===3&&nodes.every(n=>!n.stopped);void playback.resume();const resumed=nodes.every((n,i)=>n.at===starts[i]);playback.cancel();
 const checks=[
  {name:'等待识别期间继续采集',ok:gate.seq===180&&events.filter(e=>e.type==='begin').length===2,detail:`连续处理 ${gate.seq} 帧；第二段起点 ${firstEnd} 帧`},
  {name:'句首环形预录',ok:events.find(e=>e.type==='begin')?.seq===19,detail:'触发时回送 600 ms 音频，覆盖触发前的句首'},
  {name:'回复换行 ID 后仍保留三句话',ok:spoken.length===3&&terminal==='complete',detail:`稳定回合收到 ${spoken.length} 个完整句段`},
  {name:'候选打断后原位续播',ok:held&&resumed,detail:'三段已排队音频保留原播放位置，短噪声排除后继续'},
  {name:'确认打断后清空旧音频',ok:playback.nodes.size===0&&nodes.every(n=>n.stopped),detail:'全部旧播放节点停止，旧回合音频保持隔离'},
  {name:'重放事件保持幂等',ok:(lease.event({type:'message.delta',session_id:'demo',replayed:true,payload:{text:'重复内容'}}),spoken.length===3),detail:'历史事件不会再次进入语音队列'}
 ];return {mode:'offline-simulation',checks,events,spoken};
}
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ms=v=>Number.isFinite(v)?`${Math.round(v)} ms`:'—';
const labels={'speech.begin':'检测到发言','speech.end':'发言结束','asr.ready':'识别通道就绪','asr.first_partial':'首个字幕','asr.final':'识别定稿','turn.submitted':'交给 Hermes','reply.first_text':'回复首字','tts.requested':'开始合成','tts.first_pcm':'收到首帧音频','playback.first_scheduled':'音频排入声卡','playback.pause':'暂时暂停','playback.resume':'原位续播','playback.cancel':'清除旧播放','barge.candidate':'候选打断','barge.rejected':'排除误触发','barge.confirmed':'确认发言','turn.cancel_requested':'请求中断','turn.cancel_confirmed':'中断已确认','turn.terminal':'回复结束','tts.done':'合成完成','session.error':'本轮错误','capture.started':'麦克风已开启','capture.stopped':'麦克风已关闭'};
function mountPanel(element,controller,{preview=false}={}){
 const root=element.shadowRoot||element.attachShadow({mode:'open'});let demo=null;let tab='live';let interacting=false;let lastHTML='';
 const style=`:host{display:block;height:100%;min-height:580px;color:#e8eef2;font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;background:#10161d}*{box-sizing:border-box}button{font:inherit;cursor:pointer;border:1px solid #35424d;background:#202c37;color:#e8eef2;padding:10px 16px;border-radius:10px}button:hover{background:#2d3e4d}button:disabled{opacity:.4;cursor:default}.primary{background:#8cdcc1;color:#12271f;border-color:#8cdcc1;font-weight:650}.wrap{max-width:1190px;margin:auto;padding:30px 32px 24px}.eyebrow{letter-spacing:2px;color:#8cdcc1;font-size:11px}.header{display:flex;align-items:center;justify-content:space-between;gap:18px}h1{margin:8px 0;font-size:30px;letter-spacing:-.7px;font-weight:600}p{margin:6px 0;color:#a3b2c0}.badge{padding:7px 13px;border:1px solid #39554d;border-radius:24px;color:#9ee3cb;background:#162b26;font-size:12px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:25px 0 20px}.card{padding:18px 20px;border:1px solid #2b3945;border-radius:14px;background:#18222c}.number{font-size:26px;letter-spacing:-.5px;margin:6px 0;color:#eef6f9}.small{font-size:12px;color:#90a3b2}.cardlabel{color:#b1c4d0;font-size:12px}.grid{display:grid;grid-template-columns:1.35fr 1fr;gap:18px}.box{border:1px solid #2c3a46;border-radius:15px;background:#151f29;overflow:hidden}.boxhead{display:flex;justify-content:space-between;align-items:center;padding:15px 19px;border-bottom:1px solid #2b3945;font-size:13px}.body{padding:18px 20px}.caption{font-size:19px;min-height:80px;color:#ccebdd;word-break:break-word}.muted{color:#7f93a3}.meter{height:4px;background:#2a3845;border-radius:8px;overflow:hidden;margin:12px 0}.fill{height:100%;background:#89d9c1;transition:width .1s}.messages{min-height:130px;max-height:280px;overflow:auto;scrollbar-width:thin}.message{padding:12px 0;border-top:1px solid #273743;white-space:pre-wrap;word-break:break-word}.role{display:block;margin-bottom:4px;font-size:11px;color:#7fab9b}.timeline{height:330px;overflow:auto;scrollbar-width:thin}.event{display:flex;gap:12px;margin:0 0 15px;font-size:12px}.dot{width:7px;height:7px;min-width:7px;background:#7fceb3;border-radius:100%;margin-top:6px}.time{font-variant-numeric:tabular-nums;color:#7e92a3;font-size:11px}.tools{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.footer{margin-top:18px;font-size:11px;color:#8397a8;display:flex;justify-content:space-between;gap:12px}.error{background:#482b2e;color:#ffc4c4;border-radius:10px;padding:12px;margin-top:15px}.tabs{display:flex;gap:20px;border-bottom:1px solid #2c3a46;margin-top:20px}.tabs button{padding:10px 0;background:none;border:0;border-radius:0;color:#95aabc}.tabs .selected{color:#a5e9d2;border-bottom:2px solid #89d9c1}.check{padding:16px 0;border-bottom:1px solid #2a3946;display:flex;gap:14px}.tick{color:#8cdcc1;font-size:18px}.detail{font-size:12px;color:#93a7b7;margin-top:5px}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:16px}td,th{padding:10px 7px;text-align:left;border-bottom:1px solid #2c3a46;font-weight:400}th{color:#91aaba}.notice{background:#21303a;border:1px solid #384d5a;border-radius:10px;padding:12px 15px;margin:14px 0;color:#bcd0dc;font-size:12px}@media(max-width:720px){.wrap{padding:20px 15px}.grid{grid-template-columns:1fr}.cards{gap:8px}.card{padding:12px}.number{font-size:21px}.header{align-items:flex-start}h1{font-size:24px}.footer{display:block}.timeline{height:220px}}`;
 root.innerHTML=`<style>${style}</style><div class="wrap"></div>`;
 const wrap=root.querySelector('.wrap');
 const render=()=>{
  if(interacting)return;
  const c=controller,last=c.turns?.at(-1),input=last?.input,report=c.report(),p95=report.summary.p95_speech_to_pcm_ms;
  const prev=wrap.querySelector('.timeline')?.scrollTop||0;
  const html=`<div class="header"><div><div class="eyebrow">HERMES · INDEPENDENT CHAINED</div><h1>说话，自然接上。</h1><p>持续收音 · 可恢复打断 · 每轮都有证据</p></div><span class="badge">${preview?'离线预览':escape(c.state)}</span></div>
  ${preview?'<div class="notice">此页面演示独立插件界面与本地状态机。真实麦克风、Hermes 回复和云端延迟请在桌面插件中验证。</div>':''}
  <div class="cards"><div class="card"><div class="cardlabel">01 / 持续采集</div><div class="number">${(c.frames*.02).toFixed(1)} <span class="small">秒</span></div><div class="small">600 ms 预录 · 麦克风与播放独立</div></div><div class="card"><div class="cardlabel">02 / 播放可恢复</div><div class="number">${c.player?.paused?'已暂停':c.player?.active?'播放中':'就绪'}</div><div class="small">剩余 ${((c.player?.buffered)||0).toFixed(1)} 秒 · 确认后打断</div></div><div class="card"><div class="cardlabel">03 / 发言结束 → 首帧音频</div><div class="number">${ms(last?.firstPCM&&input?.speechEnd?last.firstPCM-input.speechEnd:undefined)}</div><div class="small">P95 ${ms(p95)} · ${c.turns?.filter(t=>t.firstPCM).length||0} 轮样本</div></div></div>
  <div class="tabs"><button data-action="live" class="${tab==='live'?'selected':''}">实时对话</button><button data-action="metrics" class="${tab==='metrics'?'selected':''}">逐轮诊断</button><button data-action="demo" class="${tab==='demo'?'selected':''}">离线验证</button></div>
  ${tab==='live'?`<div class="grid" style="margin-top:20px"><div class="box"><div class="boxhead"><span>实时字幕</span><span class="small">16 kHz / PCM</span></div><div class="body"><div class="caption">${escape(c.caption)||'<span class="muted">点击开始，说完之前即可看到识别字幕。</span>'}</div><div class="meter"><div class="fill" style="width:${Math.min(100,(c.peak||0)*500)}%"></div></div><div class="small">${c.running?'麦克风持续采集中':'等待你开启麦克风'}</div><div class="messages">${c.messages.map(m=>`<div class="message"><span class="role">${m.role==='user'?'你':'Hermes'}</span>${escape(m.text)||'正在回复…'}</div>`).join('')}</div></div></div><div class="box"><div class="boxhead"><span>本轮时间线</span><span class="small">本机时间</span></div><div class="body timeline">${c.journal.rows.length?c.journal.rows.slice(-35).reverse().map(e=>`<div class="event"><span class="dot"></span><div>${escape(labels[e.type]||e.type)}<div class="time">+${(e.ms/1000).toFixed(2)} s ${e.after_speech_ms!==undefined?'· 发言结束后 '+e.after_speech_ms+' ms':''}${e.reason?' · '+escape(e.reason):''}</div></div></div>`).join(''):'<p class="small">字幕、首字、首帧、播放、暂停与续播会分别记录。</p>'}</div></div></div>`:''}
  ${tab==='metrics'?`<div class="notice">所有延迟使用同一浏览器时钟。首帧代表收到 PCM；排入声卡代表 AudioContext 调度。实际可听延迟待实机录音测量。</div><table><thead><tr><th>轮次</th><th>识别定稿</th><th>回复首字</th><th>首帧音频</th><th>播放排队</th></tr></thead><tbody>${c.turns.map((t,i)=>`<tr><td>${i+1}${t.cancelled?' / 已打断':''}</td><td>${ms(t.input.finalAt-t.input.speechEnd)}</td><td>${ms(t.firstText?t.firstText-t.input.speechEnd:undefined)}</td><td>${ms(t.firstPCM?t.firstPCM-t.input.speechEnd:undefined)}</td><td>${ms(t.scheduledDelay)}</td></tr>`).join('')||'<tr><td colspan="5">完成一次真实对话后显示测量结果。</td></tr>'}</tbody></table>`:''}
  ${tab==='demo'?`<div class="notice">使用合成帧和模拟回复事件验证控制逻辑；此处通过数与真实云端性能分别记录。</div><button data-action="run-demo">运行离线验证</button>${demo?demo.checks.map(x=>`<div class="check"><span class="tick">${x.ok?'✓':'×'}</span><div>${escape(x.name)}<div class="detail">${escape(x.detail)}</div></div></div>`).join(''):''}`:''}
  ${c.error?`<div class="error">${escape(c.error)}</div>`:''}
  <div class="tools"><button class="primary" data-action="start" ${preview||c.running||c.starting?'disabled':''}>${c.starting?'连接中…':'开始独立语音'}</button><button data-action="stop" ${!c.running&&!c.starting?'disabled':''}>结束语音</button><button data-action="interrupt" ${!c.running?'disabled':''}>立即打断</button><button data-action="probe" ${preview||c.running||c.starting?'disabled':''}>检查连接</button><button data-action="export">导出诊断</button></div>
  <div class="footer"><span>${(c.owner||c.selection)?`绑定会话 ${escape((c.owner||c.selection).sessionId.slice(0,12))} · ${escape((c.owner||c.selection).profile)}`:'先打开 Hermes 会话，再从右侧独立语音面板开始。'}</span><span>使用前请结束原生语音通话 · 日志导出省略对话正文</span></div>`;
  if(html===lastHTML)return;lastHTML=html;wrap.innerHTML=html;
  const cards=wrap.querySelector('.cards');wrap.insertBefore(wrap.querySelector('.tools'),cards);wrap.insertBefore(wrap.querySelector('.footer'),cards);
  const timeline=wrap.querySelector('.timeline');if(timeline)timeline.scrollTop=prev;
 };
 const handle=e=>{
  interacting=false;
  const action=e.target.closest('button')?.dataset.action;if(!action)return;
  if(['live','metrics','demo'].includes(action)){tab=action;render();return;}
  if(action==='run-demo'){demo=runDemo();render();return;}
  if(action==='probe')controller.probe();
  if(action==='start')controller.start();
  if(action==='stop')controller.stop();
  if(action==='interrupt')controller.cancelTurn('manual').catch(err=>controller.fail(err.message));
  if(action==='export'){const blob=new Blob([JSON.stringify({...controller.report(),offline_demo:demo},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`chained-diagnostics-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 };
 const hold=()=>{interacting=true;};const release=()=>setTimeout(()=>{interacting=false;},60);
 root.addEventListener('click',handle);root.addEventListener('pointerdown',hold);root.addEventListener('keydown',hold);window.addEventListener('pointerup',release);window.addEventListener('keyup',release);
 const unsubscribe=controller.subscribe(render);render();return()=>{unsubscribe();root.removeEventListener('click',handle);root.removeEventListener('pointerdown',hold);root.removeEventListener('keydown',hold);window.removeEventListener('pointerup',release);window.removeEventListener('keyup',release);root.innerHTML='';};
}

import React,{useEffect,useRef,useState} from 'react';
import {host as sdkHost,COMPOSER_AREAS,ROUTES_AREA,SIDEBAR_NAV_AREA,PALETTE_AREA} from '@hermes/plugin-sdk';
const host = new DesktopHostAdapter(sdkHost);
export default {
 id:'hermes-speech',name:'Hermes Speech',
 register(ctx){
  RealtimeCompatibility.register(ctx,host);
  const controller=new ChainedController(ctx,host,WORKLET_SOURCE);
  function Panel(){const ref=useRef(null);useEffect(()=>mountPanel(ref.current,controller),[]);return React.createElement('div',{ref,style:{height:'100%',overflow:'auto'}});}
  function VoiceButton(){
   const [,refresh]=useState(0);
   const mainRef=useRef(null),popupRef=useRef(null);
   const showStop=controller.canStopReading;
   useEffect(()=>{
    const popup=popupRef.current,anchor=mainRef.current;if(!showStop||!popup||!anchor)return;
    const place=()=>{const r=anchor.getBoundingClientRect();popup.style.left=`${r.left}px`;popup.style.top=`${Math.max(4,r.top-36)}px`;};
    place();popup.showPopover();
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    const observer=new ResizeObserver(place);observer.observe(anchor);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);if(popup.matches(':popover-open'))popup.hidePopover();};
   },[showStop]);
   useEffect(()=>controller.subscribe(()=>refresh(n=>n+1)),[]);
   const active=controller.running||controller.starting;
   const phase=controller.stopping?'stopping':controller.error&&!active?'error':controller.starting?'connecting':
    !controller.running?'idle':controller.player?.paused?'paused':controller.player?.active?'speaking':
    controller.draftBinding||controller.turn&&!controller.turn.terminal?'thinking':'listening';
   const labels={idle:'开始独立语音',connecting:'连接中',listening:'持续聆听',thinking:'等待回复',speaking:'正在朗读',paused:'确认打断',stopping:'正在结束',error:'重新连接独立语音'};
   const h=React.createElement;
   const paths={
    idle:['M3 12h2l2-6 3 12 3-12 3 12 2-6h3'],
    listening:['M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4'],
    speaking:['M4 9h4l5-4v14l-5-4H4Z','M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14'],
    paused:['M9 5v14M15 5v14'],
    error:['M12 8v5M12 16h.01','M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18'],
    stopping:['M7 7h10v10H7Z'],
    connecting:['M12 3a9 9 0 1 1-9 9'],
    thinking:['M5 12h.01M12 12h.01M19 12h.01']
   };
   const label=labels[phase]+(active&&!controller.stopping?'；点击结束独立语音':'');
   return h('span',{className:'speech-chained-controls'},
    h('style',null,`
     .speech-chained-controls{position:relative;display:inline-flex;width:28px;height:28px;flex:0 0 28px}
     .speech-chained-stop-reading{position:fixed;inset:auto;margin:0;box-shadow:0 2px 8px #0004}
     .speech-chained-stop-reading::backdrop{background:transparent;pointer-events:none}
     .speech-chained-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:0 0 28px;padding:5px;border:0;border-radius:50%;background:#b9b39d;color:#252c30;cursor:pointer;transition:background .15s,color .15s}
     .speech-chained-icon:hover{filter:brightness(1.1)}
     .speech-chained-icon:focus-visible{outline:2px solid currentColor;outline-offset:2px}
     .speech-chained-icon[data-active=true]{box-shadow:0 0 0 2px color-mix(in srgb,#b9b39d 30%,transparent)}
     .speech-chained-icon[data-phase=error]{color:#df8179}
     .speech-chained-icon:disabled{cursor:wait;opacity:.55}
     .speech-chained-icon[data-phase=connecting] svg{animation:speech-chained-spin 1s linear infinite}
     @keyframes speech-chained-spin{to{transform:rotate(360deg)}}
     @media(prefers-reduced-motion:reduce){.speech-chained-icon svg{animation:none!important}}
    `),
    showStop?h('button',{ref:popupRef,popover:'manual',type:'button',className:'speech-chained-icon speech-chained-stop-reading',
     'aria-label':'停止本轮朗读，继续聆听',title:'停止本轮朗读，继续聆听',
     onClick:()=>{void controller.stopReading().catch(err=>controller.fail(err.message));}},
     h('svg',{viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},
      h('path',{d:'M4 9h4l5-4v14l-5-4H4Z M17 9l5 6M22 9l-5 6'}))):null,
    h('button',{ref:mainRef,type:'button',className:'speech-chained-icon','data-active':!!active,'data-phase':phase,
     'aria-label':label,'aria-pressed':!!active,title:controller.error||label,disabled:!!controller.stopping,
     onClick:()=>{if(active)void controller.stop();else void controller.start();}},
     h('svg',{viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor',strokeWidth:phase==='thinking'?3:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},
      ...paths[phase].map((d,i)=>h('path',{key:i,d})))));

  }
  ctx.register({id:'composer-voice',area:COMPOSER_AREAS.actions,order:50,render:()=>React.createElement(VoiceButton)});
  ctx.register({id:'panel',area:'panes',title:'独立语音',data:{placement:'right',width:'720px'},render:()=>React.createElement(Panel)});
  ctx.register({id:'page',area:ROUTES_AREA,data:{path:'/speech'},render:()=>React.createElement(Panel)});
  ctx.register({id:'nav',area:SIDEBAR_NAV_AREA,data:{path:'/speech',label:'独立语音',codicon:'mic'}});
  ctx.register({id:'open',area:PALETTE_AREA,data:{id:'hermes-speech.open',label:'打开 Hermes 语音',run:()=>host.navigate('/speech')}});
  ctx.onDispose(()=>{void controller.dispose();});
 }
};

