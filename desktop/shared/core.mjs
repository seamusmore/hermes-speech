// Pure state machines shared by the live plugin and offline acceptance tests.
export class Journal {
  constructor(limit=3000) { this.limit=limit; this.rows=[]; this.started=Date.now(); }
  add(type, fields={}) { const row={at:Date.now(),ms:Date.now()-this.started,type,...fields};this.rows.push(row);if(this.rows.length>this.limit)this.rows.shift();try{globalThis.localStorage?.setItem('independent-voice-diagnostics-v1',JSON.stringify(this.rows.slice(-300)));}catch{}return row; }
  export() { return {schema:1,clock:'browser-wall-ms',audioClock:'AudioContext scheduled; physical audibility unmeasured',events:this.rows}; }
}
export class CaptureGate {
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
export function echoMatch(text,reference) {
  const norm=s=>String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const a=norm(text),b=norm(reference);if(!a||!b)return false;
  if(b.includes(a))return true;
  if(a.length<4)return false;
  const pairs=s=>new Set([...s].slice(1).map((v,i)=>s[i]+v));
  const aa=pairs(a);let best=0;
  for(let i=0;i<b.length;i+=Math.max(1,Math.floor(a.length/4))){const bb=pairs(b.slice(i,i+a.length+2));let shared=0;for(const x of aa)if(bb.has(x))shared++;best=Math.max(best,2*shared/(aa.size+bb.size||1));}
  return best>=.72;
}
export class TurnText {
  constructor(emit){this.emit=emit;this.segment='';this.sent=0;this.closed=false;this.seen=false;}
  delta(text){if(this.closed)return;this.seen=true;this.segment+=text;this.flush(false);}
  flush(final){let end=this.sent;if(final)end=this.segment.length;else{const re=/[。！？!?\n]|\.(?=\s)/g;for(const m of this.segment.matchAll(re))if(m.index+1-this.sent>=8)end=m.index+1;}
    if(end>this.sent){const text=this.segment.slice(this.sent,end);this.sent=end;if(text.trim())this.emit(text);}}
  seal(text,already=false){if(this.closed)return;if(!already&&text){if(!this.segment)this.segment=text;else if(text.startsWith(this.segment))this.segment=text;else if(text!==this.segment)throw Error('Reply text changed after speech began');}this.flush(true);this.segment='';this.sent=0;this.seen=false;}
  finish(text=''){if(this.closed)return;if(text&&text.trim()===this.segment.trim())text=this.segment;if(text){if(!this.segment)this.segment=text;else if(text.startsWith(this.segment))this.segment=text;else if(!text.startsWith(this.segment.slice(0,this.sent)))throw Error('Final reply rewrote already spoken content');else this.segment=text;}this.flush(true);this.closed=true;}
}
export class TurnLease {
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
export function percentile(values,q){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);return a[Math.max(0,Math.ceil(q*a.length)-1)];}

