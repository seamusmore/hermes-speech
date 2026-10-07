import {CaptureGate, Journal, TurnLease, echoMatch, percentile} from './shared/core.mjs';
import {SpeechEventPublisher} from './shared/events.mjs';
const uid=prefix=>`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const base64=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);};
const decode=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));
import {Playback} from './shared/playback.mjs';
export class ChainedController {
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

