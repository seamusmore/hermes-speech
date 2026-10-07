export class Playback {
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

