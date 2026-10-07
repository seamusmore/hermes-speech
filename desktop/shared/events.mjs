// Generic metadata publisher. Audio ownership never depends on this transport.
export class SpeechEventPublisher {
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

