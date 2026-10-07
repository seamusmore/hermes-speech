import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {CaptureGate,TurnLease,TurnText,Journal,echoMatch} from '../desktop/shared/core.mjs';
import {Playback} from '../desktop/shared/playback.mjs';
import {ChainedController} from '../desktop/chained.mjs';
import {runDemo} from '../desktop/panel.mjs';
const quiet=()=>new Int16Array(320),voice=()=>new Int16Array(320).fill(6000);
const owner={sessionId:'session',connectionId:'local',profile:'default'};
const event=(type,payload={},seq=1,extra={})=>({type,payload,seq,session_id:owner.sessionId,connectionId:owner.connectionId,profile:owner.profile,...extra});
function fakeContext(){return {currentTime:1,state:'running',nodes:[],destination:{},createBuffer(c,n,r){return {duration:n/r,getChannelData:()=>new Float32Array(n)};},createBufferSource(){const node={connect(){},disconnect(){},start(at){this.at=at;},stop(){this.stopped=true;}};this.nodes.push(node);return node;},async suspend(){this.state='suspended';},async resume(){this.state='running';}};}
test('continuous capture retains onset and frames during two outstanding utterances',()=>{
 const events=[];const gate=new CaptureGate(e=>events.push(e));
 for(let i=0;i<40;i++)gate.push(quiet());
 for(let turn=0;turn<2;turn++){for(let i=0;i<30;i++)gate.push(voice());for(let i=0;i<40;i++)gate.push(quiet());}
 assert.equal(gate.seq,180);const starts=events.filter(e=>e.type==='begin');assert.equal(starts.length,2);assert.equal(starts[0].seq,19);
 for(const start of starts){const frames=events.filter(e=>e.type==='audio'&&e.id===start.id);for(let i=1;i<frames.length;i++)assert.equal(frames[i].seq,frames[i-1].seq+1);}
 assert.equal(events.filter(e=>e.type==='end')[0].speechSeq,69);
});
test('80 ms noise may pause but cannot open ASR; silence clears candidate',()=>{
 const events=[];const gate=new CaptureGate(e=>events.push(e));for(let i=0;i<4;i++)gate.push(voice(),true);gate.push(quiet(),true);
 assert.equal(events.filter(e=>e.type==='candidate').length,1);assert.equal(events.filter(e=>e.type==='begin').length,0);assert.ok(events.find(e=>e.type==='candidate_clear'));
});
test('playback suspension preserves all scheduled nodes; confirmed cancel stops every node',async()=>{
 const context=fakeContext(),journal=new Journal(),p=new Playback(context,journal);for(let i=0;i<3;i++)p.enqueue(new Uint8Array(48000),'s'+i);
 const starts=context.nodes.map(n=>n.at);await p.pause();assert.equal(p.nodes.size,3);assert.ok(context.nodes.every(n=>!n.stopped));await p.resume();assert.deepEqual(context.nodes.map(n=>n.at),starts);
 p.cancel();assert.ok(context.nodes.every(n=>n.stopped));assert.equal(p.nodes.size,0);assert.equal(p.buffered,0);
});
test('three sentences survive presentation ID hydration, duplicate events and replay',()=>{
 const out=[];let status;const lease=new TurnLease(owner,t=>out.push(t),s=>status=s);
 lease.event(event('message.start',{},1));lease.event(event('message.delta',{text:'第一句内容完整播放。'},2,{message_id:'live'}));
 lease.event(event('message.delta',{text:'第一句内容完整播放。'},2));lease.event(event('message.delta',{text:'历史回放不应发声。'},3,{replayed:true}));
 lease.event(event('message.delta',{text:'第二句内容完整播放。'},4,{message_id:'stored'}));lease.event(event('message.delta',{text:'第三句内容完整播放。'},5,{message_id:'stored'}));lease.event(event('message.complete',{},6));
 assert.deepEqual(out,['第一句内容完整播放。','第二句内容完整播放。','第三句内容完整播放。']);assert.equal(status,'complete');
});
test('foreign profile/session and stream epoch changes fail closed',()=>{
 const out=[];let status;const lease=new TurnLease(owner,t=>out.push(t),s=>status=s);
 lease.event(event('message.start',{},1,{profile:'other'}));assert.equal(lease.started,false);
 lease.event(event('message.start',{},2,{replayEpoch:1}));lease.event(event('message.delta',{text:'错误归属绝不能读。'},3,{session_id:'other'}));assert.equal(out.length,0);
 lease.event(event('message.delta',{text:'不允许换连接续读。'},4,{replayEpoch:2}));assert.equal(status,'connection_changed');assert.equal(out.length,0);
});
test('unsent final corrections are reconciled and spoken prefix edits fail',()=>{
 const out=[],t=new TurnText(x=>out.push(x));t.delta('完整的第一句话。未定稿尾部');t.finish('完整的第一句话。修订后的尾部');assert.deepEqual(out,['完整的第一句话。','修订后的尾部']);
 const u=new TurnText(()=>{});u.delta('已经播放过的内容。');assert.throws(()=>u.finish('全新替换掉的内容。'));
});
test('interim segments flush once then final text continues',()=>{
 const out=[],t=new TurnText(x=>out.push(x));t.delta('我先查一下。');t.seal('我先查一下。',true);t.delta('这是查询后的完整答案。');t.finish('这是查询后的完整答案。');assert.deepEqual(out,['我先查一下。','这是查询后的完整答案。']);
});
test('echo text matching excludes unrelated speech',()=>{assert.ok(echoMatch('正在查询天气','我正在查询天气，请稍等。'));assert.equal(echoMatch('帮我换一个话题','我正在查询天气，请稍等。'),false);});
test('AudioWorklet produces continuous 20 ms frames at 48 and44.1kHz',()=>{
 const source=fs.readFileSync(new URL('../desktop/capture-worklet.js',import.meta.url),'utf8');
 for(const rate of [48000,44100]){let Klass;const frames=[];class AudioWorkletProcessor{constructor(){this.port={postMessage:b=>frames.push(new Int16Array(b))};}}
 vm.runInNewContext(source,{AudioWorkletProcessor,sampleRate:rate,registerProcessor:(_,k)=>Klass=k,Int16Array,Math});const w=new Klass();let processed=0;
 while(processed<rate*2){const n=Math.min(128,rate*2-processed);w.process([[new Float32Array(n).fill(.25)]]);processed+=n;}
 assert.equal(frames.length,100);assert.ok(frames.every(f=>f.length===320&&[...f].every(x=>x===8192)));}
});
function controller(){const ctx={onEvent:()=>()=>{}},state={focusedSessionOwner:{get:()=>owner},focusedSessionId:{get:()=>owner.sessionId},focusedStoredSessionId:{get:()=> 'stored-session'},busyBySession:{get:()=>({})}};const host={locationKey:()=>globalThis.location?.hash||'',state,composer:{submit:()=>true},requestProfile:async()=>({status:'streaming'})};const c=new ChainedController(ctx,host,'');clearInterval(c.timer);c.owner=owner;c.route={mode:'local'};c.player=new Playback(fakeContext(),c.journal);c.socket={readyState:1,bufferedAmount:0,sent:[],send(v){this.sent.push(JSON.parse(v));}};return c;}
test('cancel before message.start waits for start, RPC and terminal before next turn',async()=>{
 const c=controller();c.running=true;await c.submit('测试问题',{id:'u',speechEnd:Date.now(),cancelReady:Promise.resolve()});
 let accepted=false;c.host.requestProfile=async(route,method)=>{if(method==='session.interrupt'){accepted=true;return {status:'interrupted'};}return {status:'streaming'};};
 const pending=c.cancelTurn('test');await Promise.resolve();assert.equal(accepted,false);
 c.onGateway(event('message.start',{},1));await Promise.resolve();assert.equal(accepted,true);
 let resolved=false;pending.then(()=>resolved=true);await Promise.resolve();assert.equal(resolved,false);
 c.onGateway(event('message.delta',{text:'取消后的文本不能合成。'},2));assert.equal(c.speechQueue.length,0);
 c.onGateway(event('message.complete',{status:'interrupted'},3));await pending;assert.equal(c.turn.cancelled,true);
 await c.submit('下一轮',{id:'u2',speechEnd:Date.now(),cancelReady:Promise.resolve()});c.onGateway(event('message.start',{},4));c.onGateway(event('message.delta',{text:'下一轮正常输出第一句话。'},5));assert.equal(c.socket.sent.filter(m=>m.type==='tts.begin').length,1);
 c.turn.terminal=true;c.running=false;
});
test('candidate resumes buffered audio after echo rejection without cancellation',async()=>{
 const c=controller();c.running=true;c.player.enqueue(new Uint8Array(48000),'speech');c.gate={active:null};c.onCapture({type:'candidate'});await Promise.resolve();assert.equal(c.player.paused,true);
 c.utterances.set('u',{id:'u',started:Date.now(),wasPlaying:true,reference:'今天天气晴朗适合散步。'});
 c.onTransport({type:'asr.final',id:'u',text:'今天天气晴朗'});await Promise.resolve();assert.equal(c.player.paused,false);assert.equal(c.player.nodes.size,1);assert.equal(c.socket.sent.length,0);c.running=false;
});
test('late PCM from cancelled synthesis never reaches next generation',()=>{
 const c=controller();c.tts={id:'old',cancelled:true};c.onTransport({type:'tts.pcm',id:'old',pcm:btoa('00')});assert.equal(c.player.nodes.size,0);
 c.tts={id:'new',turn:{cancelled:false}};c.onTransport({type:'tts.pcm',id:'old',pcm:btoa('00')});assert.equal(c.player.nodes.size,0);
});
test('demo shares production state machines and all advertised checks pass',()=>{assert.ok(runDemo().checks.every(c=>c.ok));});

test('three-sentence queue cancels before second PCM, drops third, then accepts fresh turn',async()=>{
 const c=controller();c.running=true;await c.submit('三句话',{id:'u',speechEnd:Date.now()});
 c.onGateway(event('message.start',{},1));c.onGateway(event('message.delta',{text:'第一句话要完整播放。'},2));c.onGateway(event('message.delta',{text:'第二句话还没有首帧。'},3));c.onGateway(event('message.delta',{text:'第三句话不能再合成。'},4));c.onGateway(event('message.complete',{},5));
 const first=c.tts.id;c.onTransport({type:'tts.done',id:first,bytes:4800});c.onTransport({type:'tts.closed',id:first});const second=c.tts.id;
 await c.cancelTurn('test');c.onTransport({type:'tts.pcm',id:second,pcm:btoa('00')});c.onTransport({type:'tts.closed',id:second});assert.equal(c.player.nodes.size,0);
 assert.equal(c.socket.sent.filter(m=>m.type==='tts.begin').length,2);assert.equal(c.speechQueue.length,0);
 await c.submit('新一轮',{id:'u2',speechEnd:Date.now()});c.onGateway(event('message.start',{},6));c.onGateway(event('message.delta',{text:'新一轮可以正常合成。'},7));assert.equal(c.socket.sent.filter(m=>m.type==='tts.begin').length,3);assert.equal(c.tts.turn.cancelled,false);c.turn.terminal=true;c.running=false;
});

test('avatar clock observes scheduled playback, keeps paused turn, clears stale samples',async()=>{
 const context=fakeContext(),p=new Playback(context,new Journal());const pcm=new Int16Array(24000).fill(8192);p.enqueue(new Uint8Array(pcm.buffer),'s1','turn-1');
 assert.equal(p.snapshot(),null);context.currentTime=1.5;const x=p.snapshot();assert.equal(x.turn,'turn-1');assert.ok(x.rms>.24&&x.rms<.26);assert.ok(x.positionMs>400);
 await p.pause();context.currentTime=1.6;const paused=p.snapshot();assert.equal(paused.turn,x.turn);assert.equal(paused.rms,0);assert.equal(paused.positionMs,x.positionMs);
 await p.resume();assert.ok(p.snapshot().positionMs>x.positionMs);p.cancel();assert.equal(p.snapshot(),null);
});

test('a completed drained reply stays completed when the next input arrives',async()=>{const c=controller();c.turn={terminal:true,cancelled:false};await c.cancelTurn('next_input');assert.equal(c.turn.cancelled,false);});
test('superseding message start cannot confirm cancellation of the old turn',async()=>{
 const c=controller();c.running=true;await c.submit('test',{id:'u',speechEnd:Date.now()});c.onGateway(event('message.start',{},1));c.host.requestProfile=async()=>({status:'interrupted'});const pending=c.cancelTurn('test');await Promise.resolve();c.onGateway(event('message.start',{},2));await assert.rejects(pending,/终止归属/);c.running=false;
});


test('terminal reply outcomes keep capture and socket alive for three subsequent turns',async()=>{
 for(const status of ['complete','error','interrupted','rewritten']){
  const c=controller();c.running=true;let stopped=0,closed=0;
  c.media={getTracks:()=>[{stop(){stopped++;}}]};c.socket.close=()=>closed++;
  for(let n=0;n<3;n++){
   await c.submit('test',{id:'u'+n,speechEnd:Date.now()});
   c.onGateway(event('message.start',{},n*10+1));
   c.onGateway(event('message.delta',{text:'This is the spoken sentence!'},n*10+2));
   c.onGateway(event('message.complete',{status:status==='rewritten'?'complete':status,text:status==='rewritten'?'A replaced final response.':'This is the spoken sentence!'},n*10+3));
   await Promise.resolve();
   assert.equal(c.running,true,`${status} turn ${n} must keep listening`);
   assert.equal(stopped,0);assert.equal(closed,0);
   if(c.tts){const id=c.tts.id;c.onTransport({type:'tts.done',id});c.onTransport({type:'tts.closed',id});}
  }
  c.running=false;
 }
});

test('previewed final does not repeat an already sealed interim',()=>{
 const out=[];let reason;const t=new TurnLease(owner,s=>out.push(s),r=>reason=r);
 t.event(event('message.start',{},1));
 t.event(event('message.delta',{text:'The completed response!'},2));
 t.event(event('message.interim',{text:'The completed response!',already_streamed:true},3));
 t.event(event('message.complete',{text:'The completed response!',response_previewed:true},4));
 assert.deepEqual(out,['The completed response!']);assert.equal(reason,'complete');
});


test('continuous capture to ASR final, gateway reply and PCM completes three rounds on one connection',async()=>{
 const c=controller();c.running=true;c.gate=new CaptureGate(e=>c.onCapture(e));
 let seq=0;
 for(let n=0;n<3;n++){
  for(let i=0;i<40;i++)c.gate.push(quiet());
  for(let i=0;i<20;i++)c.gate.push(voice());
  for(let i=0;i<40;i++)c.gate.push(quiet());
  const end=c.socket.sent.filter(x=>x.type==='asr.end').at(-1);
  assert.ok(end);c.onTransport({type:'asr.final',id:end.id,text:'User input '+n,speech:{version:1,accepted:true}});await c.chain;
  c.onGateway(event('message.start',{},++seq));
  c.onGateway(event('message.delta',{text:'This is the full response!'},++seq));
  c.onGateway(event('message.complete',{status:'complete',text:'This is the full response!'},++seq));
  const id=c.tts.id;c.onTransport({type:'tts.pcm',id,pcm:btoa('00')});
  c.onTransport({type:'tts.done',id});c.onTransport({type:'tts.closed',id});
  c.player.ctx.currentTime=c.player.cursor+1;
  for(const node of [...c.player.nodes])node.onended();
  assert.equal(c.running,true);assert.equal(c.turn.terminal,true);
  assert.equal(c.player.nodes.size,0);assert.equal(c.speechQueue.length,0);
 }
 assert.equal(c.gate.seq,300);assert.equal(c.turns.length,3);
 assert.equal(c.socket.sent.filter(x=>x.type==='asr.begin').length,3);
 assert.equal(c.socket.sent.filter(x=>x.type==='tts.begin').length,3);
 assert.equal(c.report().events.filter(x=>x.type==='session.error').length,0);
 c.running=false;
});


test('hallucinated Okay partial and rejected final never submit or cancel playback',async()=>{
 const c=controller();c.running=true;c.player.enqueue(new Uint8Array(48000),'speech');
 c.utterances.set('noise',{id:'noise',started:Date.now(),wasPlaying:true,reference:'A different reply'});
 c.onTransport({type:'asr.partial',id:'noise',text:'Okay'});
 assert.equal(c.player.active,true);assert.equal(c.turn,null);
 c.onTransport({type:'asr.final',id:'noise',text:'Okay',speech:{version:1,accepted:false,speech_ms:0}});
 await c.chain;assert.equal(c.turn,null);assert.equal(c.player.active,true);assert.equal(c.running,true);c.running=false;
});
test('verified short Okay is accepted; missing evidence is rejected',async()=>{
 for(const accepted of [false,true]){
  const c=controller();c.running=true;c.utterances.set('u',{id:'u',started:Date.now(),speechEnd:Date.now(),wasPlaying:false});
  c.onTransport({type:'asr.final',id:'u',text:'Okay',...(accepted?{speech:{version:1,accepted:true,speech_ms:192}}:{})});
  await c.chain;assert.equal(c.turns.length,accepted?1:0);c.running=false;
 }
});
test('short echo is rejected and playback tail remains protected',async()=>{
 const c=controller();c.running=true;c.messages.push({role:'assistant',text:'OK, I will check.'});
 c.player.enqueue(new Uint8Array(48000),'speech');c.player.cancel();assert.equal(c.player.echoRisk,true);
 c.onCapture({type:'begin',id:'echo',seq:0});
 c.onTransport({type:'asr.final',id:'echo',text:'OK',speech:{version:1,accepted:true}});
 await c.chain;assert.equal(c.turns.length,0);assert.equal(c.running,true);c.running=false;
});


function draftController(){
 const c=controller();c.running=true;c.startGeneration=1;let focused=null,stored=null;
 c.host.state.focusedSessionId.get=()=>focused;c.host.state.focusedStoredSessionId={get:()=>stored};
 c.owner={...owner,sessionId:null};c.draftLocation='';c.socket.close=()=>{};
 c.host.composer={submit:()=>false};
 c.focus=(id)=>{focused=id;stored=id?'stored-'+id:null;};
 return c;
}
test('blank chat first speech uses composer once, verifies new session and replays early reply',async()=>{
 const c=draftController();let sends=0,prompts=0,lists=0;const first='Hello from voice';
 c.host.requestProfile=async(_,method)=>{
  if(method==='session.active_list')return {sessions:++lists===1?[{id:'old'}]:[{id:'new',started_at:Date.now()/1000}]};
  if(method==='session.history')return {messages:[{role:'user',content:first,timestamp:Date.now()/1000}]};
  if(method==='prompt.submit'){prompts++;return {status:'streaming'};}
 };
 c.host.composer.submit=(target,text)=>{if(target==='stored-new'&&text==='second'){prompts++;return true;}assert.equal(target,'new');assert.equal(text,first);sends++;c.focus('new');
  c.onGateway(event('message.start',{},1,{session_id:'new'}));
  c.onGateway(event('message.delta',{text:'This is the first answer!'},2,{session_id:'new'}));
  c.onGateway(event('message.complete',{status:'complete'},3,{session_id:'new'}));return true;};
 await c.submit(first,{id:'u',callGeneration:1,speechEnd:Date.now()});
 assert.equal(sends,1);assert.equal(prompts,0);assert.equal(c.owner.sessionId,'new');assert.equal(c.turn.terminal,true);
 assert.equal(c.socket.sent.filter(x=>x.type==='tts.begin').length,1);
 await c.submit('second',{id:'u2',callGeneration:1,speechEnd:Date.now()});assert.equal(prompts,1);c.turn.terminal=true;c.running=false;
});
test('blank chat never binds to an existing session or a mismatched first message',async()=>{
 for(const scenario of ['old','mismatch','ambiguous']){
  const c=draftController();let lists=0;
  c.host.requestProfile=async(_,method)=>method==='session.active_list'?{sessions:++lists===1?[{id:'old'}]:scenario==='ambiguous'?[{id:'new',started_at:Date.now()/1000},{id:'other',started_at:Date.now()/1000}]:[{id:'new',started_at:Date.now()/1000}]}:{messages:[{role:'user',content:'different',timestamp:Date.now()/1000}]};
  c.host.composer.submit=()=>{c.focus(scenario==='old'?'old':'new');return true;};
  if(scenario==='old'){await c.submit('my speech',{id:'u',callGeneration:1});assert.equal(c.running,false);}
  else await assert.rejects(c.submit('my speech',{id:'u',callGeneration:1}));
  assert.equal(c.turns.length,0);c.running=false;
 }
});
test('old queued recognition cannot submit after stop/restart and blank selection never reuses old owner',async()=>{
 const c=controller();c.running=true;c.startGeneration=2;let calls=0;c.host.requestProfile=async()=>{calls++;};
 await c.submit('late',{id:'old',callGeneration:1});assert.equal(calls,0);
 c.host.state.focusedSessionId.get=()=>null;c.host.state.focusedStoredSessionId.get=()=>null;c.socket.close=()=>{};c.checkOwner();
 assert.equal(c.running,false);assert.equal(c.selection.sessionId,null);
});
test('composer dispatch failure is reported without creating or submitting a different session',async()=>{
 const c=draftController();c.host.requestProfile=async()=>({sessions:[]});
 await assert.rejects(c.submit('hello',{id:'u',callGeneration:1}),/未接收/);assert.equal(c.turns.length,0);assert.equal(c.owner.sessionId,null);c.running=false;
});
test('stopped draft creation ignores its late history reply',async()=>{
 const c=draftController();let release,lists=0;
 c.host.requestProfile=async(_,method)=>method==='session.active_list'?{sessions:++lists===1?[]:[{id:'new',started_at:Date.now()/1000}]}:new Promise(r=>release=r);
 c.host.composer.submit=()=>{c.focus('new');return true;};
 const pending=c.submit('hello',{id:'u',callGeneration:1});
 for(let i=0;i<10&&!release;i++)await Promise.resolve();assert.ok(release);
 await c.stop();release({messages:[{role:'user',content:'hello',timestamp:Date.now()/1000}]});await pending;
 assert.equal(c.turns.length,0);assert.equal(c.running,false);
});


test('stop reading preserves capture and text, suppresses queued and future speech, and next turn speaks',async()=>{
 for(const moment of ['before-pcm','playing','paused','completed']){
  const c=controller();c.running=true;let closed=0,interrupted=0;
  c.media={getTracks:()=>[{stop(){closed++;}}]};c.socket.close=()=>closed++;
  c.captureContext={close(){closed++;}};c.gate=new CaptureGate(e=>c.onCapture(e));
  c.host.requestProfile=async(_,method)=>{if(method==='session.interrupt')interrupted++;return {status:'streaming'};};
  await c.submit('first',{id:'u',speechEnd:Date.now()});
  c.onGateway(event('message.start',{},1));
  c.onGateway(event('message.delta',{text:'The first sentence is spoken!'},2));
  c.onGateway(event('message.delta',{text:'The second sentence is queued!'},3));
  const id=c.tts.id;
  if(moment!=='before-pcm')c.onTransport({type:'tts.pcm',id,pcm:btoa('00')});
  if(moment==='paused')await c.player.pause();
  if(moment==='completed')c.onGateway(event('message.complete',{},4));
  assert.equal(c.canStopReading,true);await c.stopReading();await c.stopReading();
  assert.equal(c.canStopReading,false);assert.equal(c.running,true);assert.equal(closed,0);assert.equal(interrupted,0);
  assert.equal(c.turn.cancelled,false);assert.equal(c.player.active,false);assert.equal(c.player.paused,false);
  assert.equal(c.speechQueue.length,0);assert.equal(c.socket.sent.filter(x=>x.type==='tts.cancel').length,1);
  c.onTransport({type:'tts.pcm',id,pcm:btoa('00')});
  c.onTransport({type:'error',id,code:'tts_failed'});
  c.onTransport({type:'tts.closed',id});
  if(moment!=='completed'){
   c.onGateway(event('message.delta',{text:'The third sentence still appears!'},4));
   c.onGateway(event('message.complete',{},5));
   assert.ok(c.messages.at(-1).text.includes('third sentence'));
  }
  assert.equal(c.socket.sent.filter(x=>x.type==='tts.begin').length,1);assert.equal(c.player.active,false);
  for(let i=0;i<40;i++)c.gate.push(quiet());for(let i=0;i<20;i++)c.gate.push(voice());for(let i=0;i<40;i++)c.gate.push(quiet());
  const end=c.socket.sent.filter(x=>x.type==='asr.end').at(-1);assert.ok(end);
  c.onTransport({type:'asr.final',id:end.id,text:'Next topic',speech:{version:1,accepted:true}});await c.chain;
  c.onGateway(event('message.start',{},6));c.onGateway(event('message.delta',{text:'The next reply speaks normally!'},7));
  assert.equal(c.socket.sent.filter(x=>x.type==='tts.begin').length,2);
  c.onTransport({type:'tts.pcm',id:c.tts.id,pcm:btoa('00')});assert.equal(c.player.active,true);
  assert.equal(closed,0);assert.equal(interrupted,0);c.turn.terminal=true;c.running=false;
 }
});


test('final formatting trims keep speech intact while actual rewrites remain detected',()=>{
 for(const [stream,final] of [['\n\nThis reply is already spoken!','This reply is already spoken!'],['  This reply is already spoken!  ','This reply is already spoken!'],['This reply is already spoken!','\nThis reply is already spoken!\n']]){
  const out=[];let reason;const lease=new TurnLease(owner,t=>out.push(t),r=>reason=r);
  lease.event(event('message.start',{},1));lease.event(event('message.delta',{text:stream},2));
  lease.event(event('message.complete',{text:final,status:'complete'},3));
  assert.equal(reason,'complete');assert.equal(out.join('').trim(),final.trim());
 }
 let reason;const lease=new TurnLease(owner,()=>{},r=>reason=r);
 lease.event(event('message.start',{},1));lease.event(event('message.delta',{text:'This is the original spoken text!'},2));
 lease.event(event('message.complete',{text:'This is different content!'},3));assert.equal(reason,'final_text_changed');
});

test('existing voice submits once through exact composer and receives immediate reply events',async()=>{
 const c=controller();c.running=true;const order=[];let submits=0;
 c.host.requestProfile=async()=>{throw Error('Direct prompt RPC must not be used');};
 c.host.composer.submit=(target,text)=>{
  assert.equal(target,'stored-session');assert.notEqual(target,owner.sessionId);assert.equal(text,'My spoken input');submits++;
  order.push('user');c.onGateway(event('message.start',{},1));
  c.onGateway(event('message.delta',{text:'The reply starts immediately!'},2));order.push('assistant');
  c.onGateway(event('message.complete',{},3));return true;
 };
 await c.submit('My spoken input',{id:'u',speechEnd:Date.now()});
 assert.equal(submits,1);assert.deepEqual(order,['user','assistant']);assert.equal(c.turn.terminal,true);
 assert.equal(c.socket.sent.filter(m=>m.type==='tts.begin').length,1);c.running=false;
});

test('unavailable composer fails without fallback or duplicate submission',async()=>{
 const c=controller();c.running=true;let rpc=0,dispatch=0;
 c.host.requestProfile=async()=>{rpc++;};c.host.composer.submit=()=>{dispatch++;return false;};
 await c.submit('keep this input',{id:'u'});assert.equal(c.running,true);assert.equal(c.turn.input.text,'keep this input');
 assert.equal(dispatch,1);assert.equal(rpc,0);assert.equal(c.turn.terminal,true);c.running=false;
});


test('voice uses visible stored address when runtime composer mapping is absent',async()=>{
 const c=controller();c.running=true;const seen=[];
 c.host.composer.submit=(id)=>{seen.push(id);return id==='stored-session';};
 await c.submit('hello',{id:'u'});assert.deepEqual(seen,['stored-session']);assert.equal(c.turn.terminal,false);
 c.turn.terminal=true;c.running=false;
});
test('missing visible stored address never falls through to another composer',async()=>{
 const c=controller();c.running=true;c.host.state.focusedStoredSessionId.get=()=>null;let calls=0;
 c.host.composer.submit=()=>{calls++;return true;};
 await c.submit('hello',{id:'u'});assert.equal(c.running,true);assert.equal(calls,0);c.running=false;
});


test('dedicated voice page submits to pinned session and returning chat restores composer delivery',async()=>{
 const previous=globalThis.location;const c=controller();c.running=true;let rpc=0,composers=0;
 c.host.requestProfile=async(_,method,args)=>{assert.equal(method,'prompt.submit');assert.equal(args.session_id,owner.sessionId);rpc++;return {status:'streaming'};};
 c.host.composer.submit=()=>{composers++;return true;};
 try{
  globalThis.location={hash:'#/speech'};
  for(let n=0;n<2;n++){
   await c.submit('page input '+n,{id:'u'+n});c.onGateway(event('message.start',{},n*10+1));
   c.onGateway(event('message.complete',{},n*10+2));assert.equal(c.running,true);
  }
  assert.equal(rpc,2);assert.equal(composers,0);
  globalThis.location.hash='#/stored-session';await c.submit('chat input',{id:'u3'});
  assert.equal(composers,1);assert.equal(rpc,2);c.turn.terminal=true;
 }finally{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;c.running=false;}
});
