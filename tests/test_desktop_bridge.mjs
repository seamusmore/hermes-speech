import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeCompatibility as plugin, createQwenAdapter, createHermesStream, createBridgeReadiness, speechPrefix, isQwenBridgeConfig, installChainedTransport } from '../desktop/shared/realtime.mjs'
const qwenConfig = {config:{voice:{voice_chat_mode:'gpt-live',gpt_live:{model:'qwen-audio-3.1-realtime-plus',base_url:'http://127.0.0.1:8765/v1'}}}}
function scopedHost(config=qwenConfig) {
  return {state:{focusedSessionOwner:{get:()=>({connectionId:'local',profile:'default'})},focusedSessionId:{get:()=> 'bound'},connectionId:{get:()=> 'local'},profile:{get:()=> 'default'}},
    profileRoutes:async()=>[{connectionId:'local',profile:'default'}],requestProfile:async()=>config}
}
function setup() {
  const sent = [], delivered = [], playback = []
  const adapter = createQwenAdapter({ send: raw => sent.push(JSON.parse(raw)) }, {
    setPlaybackEnabled: enabled => playback.push(enabled)
  })
  adapter.addHermesMessageListener(event => delivered.push(JSON.parse(event.data)))
  const incoming = event => adapter.onQwenMessage(JSON.stringify(event))
  const outgoing = event => adapter.sendHermes(JSON.stringify(event))
  incoming({ type: 'session.created', session: { model: 'qwen-audio-3.1-realtime-plus' } })
  sent.length = 0; delivered.length = 0
  const call = (id = 'call1') => incoming({
    type: 'response.function_call_arguments.done', name: 'delegate_to_hermes', call_id: id
  })
  const speak = (content, id = 'call1') => outgoing({
    type: 'session.commentary.append', delegation_id: id, content
  })
  return { adapter, sent, delivered, playback, incoming, outgoing, call, speak }
}
test('native GPT Live events and appends pass through unchanged', () => {
  const sent = [], seen = []
  const a = createQwenAdapter({ send: raw => sent.push(JSON.parse(raw)) })
  a.addHermesMessageListener(e => seen.push(JSON.parse(e.data)))
  const event = { type: 'session.started', session: { id: 'native' } }
  a.onQwenMessage(JSON.stringify(event))
  a.sendHermes(JSON.stringify({ type: 'session.commentary.append', content: 'native' }))
  assert.deepEqual(seen, [event])
  assert.equal(sent[0].type, 'session.commentary.append')
})
test('Qwen session config preserves smart_turn and Hermes tool', () => {
  const sent = []
  const a = createQwenAdapter({send:raw=>sent.push(JSON.parse(raw))}, {voice:'longanqian'})
  a.onQwenMessage(JSON.stringify({type:'session.created',session:{model:'qwen-audio-3.1-realtime-plus'}}))
  assert.equal(sent[0].session.turn_detection.type, 'smart_turn')
  assert.equal(sent[0].session.tools[0].function.name, 'delegate_to_hermes')
  assert.equal(sent[0].session.voice, 'longanqian')
})
test('first Hermes sentence starts audio without a backend completion event', () => {
  const t = setup(); t.call(); t.speak('First result.')
  assert.equal(t.delivered[0].type, 'session.delegation.created')
  assert.equal(t.sent[0].item.type, 'function_call_output')
  assert.equal(t.sent[0].item.call_id, 'call1')
  assert.equal(t.sent[1].type, 'response.create')
})
test('function response completes before queued tool result creates next response', () => {
  const t = setup()
  t.incoming({type:'response.created',response:{id:'function-response'}})
  t.call(); t.speak('First result.')
  assert.equal(t.sent.length, 0)
  t.incoming({type:'response.done',response:{id:'function-response'}})
  assert.equal(t.sent[1].type, 'response.create')
})
test('later chunks queue and stale delegation IDs are discarded', () => {
  const t = setup(); t.call(); t.speak('First.'); t.speak('Second.'); t.speak('Old.', 'old')
  assert.equal(t.sent.length, 2)
  t.incoming({type:'response.done',response:{status:'completed'}})
  assert.match(t.sent[2].item.content[0].text, /Second/)
  assert.equal(t.sent.length, 4)
})
test('interrupt cancels playback, drops old output, then accepts new delegation', () => {
  const t = setup(); t.call(); t.speak('First.')
  t.incoming({type:'response.created',response:{id:'old-response'}})
  t.speak('Queued old.')
  t.incoming({type:'input_audio_buffer.speech_started'})
  assert.equal(t.sent.at(-1).type, 'response.cancel')
  assert.equal(t.playback.at(-1), false)
  const n = t.sent.length
  t.speak('Late old.'); t.incoming({type:'response.done',response:{id:'old-response'}})
  assert.equal(t.sent.length,n)
  t.incoming({type:'input_audio_buffer.speech_stopped'})
  t.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'new',transcript:'New request'}); t.call('call2'); t.speak('New.', 'call2')
  assert.equal(t.sent.at(-2).item.call_id,'call2')
  t.incoming({type:'response.created',response:{id:'new-response'}})
  assert.equal(t.playback.at(-1), true)
})
test('duplicate function event does not duplicate Hermes delegation', () => {
  const t=setup(); t.call(); t.call()
  assert.equal(t.delivered.filter(e=>e.type==='session.delegation.created').length,1)
})
test('close cancels once, signals desktop teardown, and rejects late events', () => {
  const t=setup(); t.call(); t.speak('First.')
  t.outgoing({type:'session.close'})
  assert.equal(t.sent.at(-1).type,'response.cancel')
  assert.equal(t.delivered.at(-1).type,'session.closed')
  const n=t.sent.length
  t.speak('Late.'); t.call('late'); t.outgoing({type:'session.close'})
  assert.equal(t.sent.length,n)
})
test('Qwen input resumes only after session configuration acknowledgement', () => {
  const sent = [], seen = []; let resumed = 0
  const adapter = createQwenAdapter({send:raw=>sent.push(JSON.parse(raw))}, {resumeInput:()=>resumed++})
  adapter.addHermesMessageListener(e=>seen.push(JSON.parse(e.data)))
  adapter.onQwenMessage(JSON.stringify({type:'session.created',session:{model:'qwen-audio-3.1-realtime-plus',id:'test'}}))
  assert.equal(resumed,0); assert.equal(seen.length,0)
  adapter.onQwenMessage(JSON.stringify({type:'session.updated'}))
  assert.equal(resumed,1); assert.equal(seen[0].type,'session.started')
  adapter.onQwenMessage(JSON.stringify({type:'session.updated'}))
  assert.equal(resumed,1)
})
test('desktop wrapper detaches RTP before answer and restores original mute state', async () => {
  const original = globalThis.RTCPeerConnection
  const track = {kind:'audio',enabled:false}; const changes=[]; const listeners={}
  const sender = {track,async replaceTrack(value){changes.push(value);this.track=value}}
  class Peer {
    addEventListener() {}
    getSenders(){return [sender]}
    async setRemoteDescription(){assert.equal(sender.track,null)}
    createDataChannel(){return {send(){},addEventListener(type,fn){listeners[type]=fn},removeEventListener(){}}}
  }
  globalThis.RTCPeerConnection=Peer
  let dispose
  try {
    plugin.register({storage:{get:(_key,value)=>value},onDispose:fn=>dispose=fn}, scopedHost())
    const pc=new globalThis.RTCPeerConnection();pc.createDataChannel('oai-events')
    await pc.setRemoteDescription({type:'answer'})
    listeners.message({data:JSON.stringify({type:'session.created',session:{model:'qwen-audio-3.1-realtime-plus'}})})
    assert.equal(sender.track,null)
    listeners.message({data:JSON.stringify({type:'session.updated'})})
    assert.equal(sender.track,track);assert.equal(track.enabled,false)
    assert.deepEqual(changes,[null,track])
  } finally {dispose?.();globalThis.RTCPeerConnection=original}
})
test('Chinese Hermes stream speaks before complete, filters other chats and suppresses duplicate desktop append', () => {
  const t=setup();t.call()
  const stream=createHermesStream(t.adapter,'call1',{sessionId:'bound',connectionId:null,profile:'default'})
  const event=(type,text,extra={})=>stream({type,session_id:'bound',payload:{text},...extra})
  event('message.delta','old result。')
  event('message.start','', {session_id:'other'})
  assert.equal(t.sent.length,0)
  event('message.start','')
  event('message.delta','第一句。第二句还在生成')
  assert.equal(t.sent[0].item.output,'第一句。')
  t.speak('第一句。第二句还在生成')
  assert.equal(t.sent.length,2)
  event('message.complete','第一句。第二句还在生成')
  t.incoming({type:'response.done'})
  assert.match(t.sent[2].item.content[0].text,/第二句还在生成/)
})
test('interrupt prevents an old stream from speaking into the next delegation', () => {
  const t=setup();t.call()
  const stream=createHermesStream(t.adapter,'call1',{sessionId:'bound'})
  stream({type:'message.start',session_id:'bound'})
  t.incoming({type:'input_audio_buffer.speech_started'})
  t.incoming({type:'input_audio_buffer.speech_stopped'});t.call('call2')
  const n=t.sent.length
  stream({type:'message.delta',session_id:'bound',payload:{text:'旧结果。'}})
  assert.equal(t.sent.length,n)
})
test('revised ASR hypotheses never duplicate the final request and delegation waits for it', () => {
  const t=setup()
  t.incoming({type:'input_audio_buffer.speech_started'})
  t.incoming({type:'conversation.item.input_audio_transcription.delta',item_id:'u',text:'wrong',stash:' maybe'})
  t.incoming({type:'input_audio_buffer.speech_stopped'})
  t.call()
  assert.equal(t.delivered.length,0)
  t.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'u',transcript:'Correct request.'})
  assert.equal(t.delivered[0].delta,'Correct request.')
  assert.equal(t.delivered[1].type,'session.delegation.created')
  t.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'u',transcript:'Correct request.'})
  assert.equal(t.delivered.length,2)
})

test('cloud cancellation preceding speech_started discards pending continuation', () => {
  const t=setup();t.call();t.speak('First.');t.speak('Old tail.')
  const n=t.sent.length
  t.incoming({type:'response.done',response:{id:'old',status:'cancelled'}})
  assert.equal(t.sent.length,n)
  t.incoming({type:'input_audio_buffer.speech_started'})
  t.incoming({type:'error',error:{param:'response.create',message:'Cannot create response while user is speaking.'}})
  assert.equal(t.delivered.filter(e=>e.type==='error').length,0)
})
test('Hermes non-streaming completion produces speech once', () => {
  const t=setup();t.call()
  const stream=createHermesStream(t.adapter,'call1',{sessionId:'s'})
  stream({type:'message.start',session_id:'s'})
  stream({type:'message.complete',session_id:'s',payload:{text:'Complete answer.',status:'complete'}})
  assert.equal(t.sent[0].item.output,'Complete answer.')
  t.speak('Complete answer.');assert.equal(t.sent.length,2)
})

test('desktop sees server txt transport readiness on its oai-events handle', () => {
  const original={readyState:'connecting',send(){throw new Error('wrong channel')}}
  const sent=[];const transport={readyState:'open',send:raw=>sent.push(raw)}
  const adapter=createQwenAdapter(original)
  adapter.bindTransport(transport)
  assert.equal(original.readyState,'open')
  adapter.sendHermes('native test');assert.deepEqual(sent,['native test'])
  transport.readyState='closed';assert.equal(original.readyState,'closed')
})

test('readiness deduplicates concurrent starts and retries after failure', async () => {
  let calls=0,resolve
  const ensure=createBridgeReadiness(()=>{calls++;return new Promise(r=>resolve=r)},1000)
  const a=ensure(),b=ensure();await Promise.resolve()
  assert.equal(calls,1);resolve({ok:true});await Promise.all([a,b])
  const c=ensure();await Promise.resolve();assert.equal(calls,2);resolve({ok:true});await c
  let fail=true
  const retry=createBridgeReadiness(async()=>{if(fail)throw new Error('occupied port');return {ok:true}})
  await assert.rejects(retry(),/occupied port/);fail=false;await retry()
})
test('readiness is bounded even when the transport hangs', async () => {
  const ensure=createBridgeReadiness(()=>new Promise(()=>{}),20)
  await assert.rejects(ensure(),/timed out/)
})
test('SDP negotiation waits for health and is blocked on startup failure', async () => {
  const original=globalThis.RTCPeerConnection
  let offered=0,dispose,resolve
  class Peer {
    addEventListener(){}
    createDataChannel(){return {send(){},addEventListener(){},removeEventListener(){}}}
    async createOffer(){offered++;return {sdp:'ready'}}
  }
  globalThis.RTCPeerConnection=Peer
  try {
    plugin.register({storage:{get:(_k,v)=>v},onDispose:fn=>dispose=fn,rest:()=>new Promise(r=>resolve=r)}, scopedHost())
    const pc=new globalThis.RTCPeerConnection();pc.createDataChannel('oai-events')
    const offer=pc.createOffer();await new Promise(r=>setTimeout(r,0));assert.equal(offered,0)
    resolve({ok:true});await offer;assert.equal(offered,1)
  } finally {dispose?.();globalThis.RTCPeerConnection=original}
})


test('sanitizer holds split fences, reasoning, links and table rows across every split', () => {
  const raw = '你好。\n```js\n秘密。\n```\n<think>思考秘密。</think>看[文档](https://example.com/secret)。\n| 名字 | 数量 |\n| --- | --- |\n| 秘密 | 9 |\n完成。'
  for (let split=1; split<raw.length; split++) {
    const spoken=[]
    const stream=createHermesStream({streamStarted(){},streamAppend(_id,text){spoken.push(text)}},'d',{sessionId:'s'})
    stream({type:'message.start',session_id:'s'})
    for(const text of [raw.slice(0,split),raw.slice(split)]) stream({type:'message.delta',session_id:'s',payload:{text}})
    stream({type:'message.complete',session_id:'s',payload:{}})
    const result=spoken.join(' ')
    assert.doesNotMatch(result,/秘密|think|https|```/,`split ${split}: ${result}`)
    assert.match(result,/你好/);assert.match(result,/文档/);assert.match(result,/完成/)
  }
  assert.equal(speechPrefix('你好。```unterminated code。',true),'你好。')
})

test('bare interruption cancels only the active bound turn via official RPC', async()=>{
  const calls=[], adapter={streamStarted(){},streamAppend(){}}
  const make=()=>createHermesStream(adapter,'d',{sessionId:'s',profile:'p',connectionId:'c'},(method,params)=>calls.push([method,params]))
  const event=(stream,type,extra={})=>stream({type,session_id:'s',profile:'p',connectionId:'c',...extra})
  let stream=make();event(stream,'message.start');stream.cancel('other');assert.equal(calls.length,0)
  const stopped=stream.cancel('d');stream.cancel('d');event(stream,'message.complete');await stopped;assert.deepEqual(calls,[['session.interrupt',{session_id:'s'}]])
  stream=make();event(stream,'message.start');event(stream,'message.start');stream.cancel('d');assert.equal(calls.length,1)
  stream=make();event(stream,'message.start');event(stream,'message.complete');stream.cancel('d');assert.equal(calls.length,1)
  stream=make();event(stream,'message.start',{replayed:true});const pending=stream.cancel('d');assert.equal(calls.length,1);event(stream,'message.start');event(stream,'message.complete');await pending;assert.equal(calls.length,2)
})

test('native and unknown configurations never touch bridge readiness or microphone', async()=>{
  const original=globalThis.RTCPeerConnection
  for (const config of [{}, {config:{voice:{voice_chat_mode:'gpt-live',gpt_live:{model:'gpt-live-1'}}}}, null]) {
    let disposed, calls=0, replaced=0
    const received=[]
    class Channel extends EventTarget {send(value){received.push(value)}}
    class Peer {
      addEventListener(){} createDataChannel(){return new Channel()}
      getSenders(){return [{track:{kind:'audio'},replaceTrack(){replaced++}}]}
      async createOffer(){return 'native-offer'} async setRemoteDescription(){return 'native-answer'}
    }
    globalThis.RTCPeerConnection=Peer
    const host=scopedHost(config)
    if(config===null)host.requestProfile=async()=>{throw new Error('query failed')}
    plugin.register({storage:{get:(_k,v)=>v},onDispose:fn=>disposed=fn,rest:()=>{calls++;throw new Error('bridge unavailable')}},host)
    const pc=new globalThis.RTCPeerConnection(),channel=pc.createDataChannel('oai-events')
    channel.addEventListener('message',e=>received.push(e.data))
    assert.equal(await pc.createOffer(),'native-offer');assert.equal(await pc.setRemoteDescription({}),'native-answer')
    channel.send('native');channel.dispatchEvent(new MessageEvent('message',{data:'native-event'}))
    assert.deepEqual(received,['native','native-event']);assert.equal(calls,0);assert.equal(replaced,0)
    disposed()
  }
  globalThis.RTCPeerConnection=original
})


test('cancel handoff awaits RPC acknowledgement and terminal event', async()=>{
  let ack, resolved=false
  const stream=createHermesStream({streamStarted(){},streamAppend(){throw new Error('cancelled speech')}},'d',{sessionId:'s'},()=>new Promise(r=>ack=r))
  stream({type:'message.start',session_id:'s'})
  const pending=stream.cancel('d').then(()=>resolved=true)
  stream({type:'message.delta',session_id:'s',payload:{text:'旧语音。'}})
  stream({type:'message.complete',session_id:'s'})
  await Promise.resolve();assert.equal(resolved,false)
  ack({status:'interrupted'});await pending;assert.equal(resolved,true)
})


test('duplicate cloud cancel and speech-start preserve the pending handoff in both orders', async()=>{
  for (const reverse of [false,true]) {
    const delivered=[];let handoff=null,ack,stream
    const adapter=createQwenAdapter({send(){}},{
      onInterrupt:id=>{handoff=stream?.cancel(id)||handoff},
      onDelegation:id=>{if(id==='new')return handoff}
    })
    const incoming=event=>adapter.onQwenMessage(JSON.stringify(event))
    adapter.addHermesMessageListener(e=>delivered.push(JSON.parse(e.data)))
    incoming({type:'session.created',session:{model:'qwen-audio-3.1-realtime-plus'}})
    incoming({type:'response.function_call_arguments.done',name:'delegate_to_hermes',call_id:'old'})
    stream=createHermesStream(adapter,'old',{sessionId:'s'},()=>new Promise(r=>ack=r))
    stream({type:'message.start',session_id:'s'})
    const events=[{type:'input_audio_buffer.speech_started'},{type:'response.done',response:{status:'cancelled'}}]
    for(const event of reverse?events.reverse():events) incoming(event)
    incoming({type:'input_audio_buffer.speech_stopped'})
    incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'u',transcript:'next'})
    incoming({type:'response.function_call_arguments.done',name:'delegate_to_hermes',call_id:'new'})
    await Promise.resolve();assert.equal(delivered.filter(e=>e.type==='session.delegation.created').length,1)
    stream({type:'message.complete',session_id:'s'});ack({status:'interrupted'})
    await new Promise(r=>setTimeout(r,0));assert.equal(delivered.filter(e=>e.type==='session.delegation.created').length,2)
  }
})

test('failed cancellation closes the voice session before another submission', async()=>{
  const delivered=[]
  const adapter=createQwenAdapter({send(){}},{onDelegation:()=>Promise.reject(new Error('RPC unavailable'))})
  adapter.addHermesMessageListener(e=>delivered.push(JSON.parse(e.data)))
  adapter.onQwenMessage(JSON.stringify({type:'session.created',session:{model:'qwen-audio-3.1-realtime-plus'}}))
  adapter.onQwenMessage(JSON.stringify({type:'response.function_call_arguments.done',name:'delegate_to_hermes',call_id:'d'}))
  await new Promise(r=>setTimeout(r,0))
  assert.equal(delivered.filter(e=>e.type==='session.delegation.created').length,0)
  assert.equal(delivered.at(-1).reason,'hermes_cancel_unconfirmed')
})


test('Chained routing binds local profile and Qwen config, preserves native traffic and restores constructor',async()=>{
  const original=globalThis.WebSocket
  const urls=[]
  class Socket extends EventTarget {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3
    constructor(url){super();urls.push(String(url));this.url=url;this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))})}
    send(){} close(){}
  }
  const chained={config:{tts:{provider:'http_tts',http_tts:{backend:'qwen'}},voice:{voice_chat_mode:'chained'}}}
  const cases=[{config:{config:{...chained.config,tts:{...chained.config.tts,http_tts:{backend:'qwen',streaming:false}}}},profile:'default',adapt:false},{config:chained,profile:'default',mode:'remote',adapt:false},{config:chained,profile:'default',adapt:true},{config:chained,profile:'other',adapt:false},{config:qwenConfig,profile:'default',adapt:false},{config:null,profile:'default',adapt:false}]
  try {
    for(const item of cases){
      globalThis.WebSocket=Socket
      const host=scopedHost(item.config);host.profileRoutes=async()=>[{mode:item.mode||'local',connectionId:'local',profile:'default',targetProfile:'default'}]
      if(item.config===null)host.requestProfile=async()=>{throw new Error('failed')}
      const dispose=installChainedTransport({onDispose(){},rest:async()=>({host:'127.0.0.1',port:54321,path:'/api/audio/speak-stream',profile:'default',qwen_enabled:true})},host)
      const ws=new globalThis.WebSocket(`ws://127.0.0.1:54321/api/audio/speak-stream?profile=${item.profile}&token=test`)
      ws.binaryType='arraybuffer'
      await new Promise(resolve=>ws.addEventListener('open',resolve))
      assert.equal(urls.at(-1).includes('/api/plugins/hermes-speech/'),item.adapt)
      assert.match(urls.at(-1),/token=test/)
      const native=new globalThis.WebSocket('wss://other.test/api/ws')
      assert.ok(native instanceof Socket);assert.equal(urls.at(-1),'wss://other.test/api/ws')
      dispose();assert.equal(globalThis.WebSocket,Socket)
    }
  } finally {globalThis.WebSocket=original}
})


test('Chained sockets close during scope query and unrelated ports stay native',async()=>{
  const original=globalThis.WebSocket,oldClose=globalThis.CloseEvent
  globalThis.CloseEvent ||= class extends Event{constructor(type,values){super(type);Object.assign(this,values)}}
  let urls=[],resolve
  class Socket extends EventTarget {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3
    constructor(url){super();urls.push(String(url));queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
  }
  try{
    globalThis.WebSocket=Socket
    const host=scopedHost({config:{tts:{provider:'http_tts',http_tts:{backend:'qwen'}}}})
    host.profileRoutes=()=>new Promise(r=>resolve=r)
    const dispose=installChainedTransport({onDispose(){},rest:async()=>({host:'127.0.0.1',port:54321,path:'/api/audio/speak-stream',profile:'default',qwen_enabled:true})},host)
    const ws=new globalThis.WebSocket('ws://127.0.0.1:54321/api/audio/speak-stream?profile=default');ws.close()
    resolve([{mode:'local',connectionId:'local',profile:'default',targetProfile:'default'}])
    await new Promise(r=>setTimeout(r,0));assert.equal(urls.length,0)
    host.profileRoutes=async()=>[{mode:'local',connectionId:'local',profile:'default',targetProfile:'default'}]
    const other=new globalThis.WebSocket('ws://127.0.0.1:9999/api/audio/speak-stream?profile=default')
    await new Promise(r=>other.addEventListener('open',r))
    assert.equal(urls.at(-1),'ws://127.0.0.1:9999/api/audio/speak-stream?profile=default')
    dispose()
  }finally{globalThis.WebSocket=original;globalThis.CloseEvent=oldClose}
})

