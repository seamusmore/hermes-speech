class ContinuousPCM extends AudioWorkletProcessor {
 constructor(){super();this.buffer=new Int16Array(320);this.index=0;this.phase=0;this.sum=0;this.count=0;}
 process(inputs){const a=inputs[0]?.[0];if(!a)return true;
  for(const x of a){this.sum+=x;this.count++;this.phase+=16000;
   if(this.phase>=sampleRate){this.phase-=sampleRate;const v=Math.max(-1,Math.min(1,this.sum/this.count));this.buffer[this.index++]=Math.round(v*32767);this.sum=0;this.count=0;
    if(this.index===320){this.port.postMessage(this.buffer.buffer,[this.buffer.buffer]);this.buffer=new Int16Array(320);this.index=0;}}}
  return true;
 }
}
registerProcessor('continuous-pcm',ContinuousPCM);

