import {CaptureGate, TurnLease, Journal} from './shared/core.mjs';
import {Playback} from './shared/playback.mjs';
export function runDemo(){
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
export function mountPanel(element,controller,{preview=false}={}){
 const root=element.shadowRoot||element.attachShadow({mode:'open'});let demo=null;let tab='live';let interacting=false;let lastHTML='';
 const style=`:host{display:block;height:100%;min-height:580px;color:#e8eef2;font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;background:#10161d}*{box-sizing:border-box}button{font:inherit;cursor:pointer;border:1px solid #35424d;background:#202c37;color:#e8eef2;padding:10px 16px;border-radius:10px}button:hover{background:#2d3e4d}button:disabled{opacity:.4;cursor:default}.primary{background:#8cdcc1;color:#12271f;border-color:#8cdcc1;font-weight:650}.wrap{max-width:1190px;margin:auto;padding:30px 32px 24px}.eyebrow{letter-spacing:2px;color:#8cdcc1;font-size:11px}.header{display:flex;align-items:center;justify-content:space-between;gap:18px}h1{margin:8px 0;font-size:30px;letter-spacing:-.7px;font-weight:600}p{margin:6px 0;color:#a3b2c0}.badge{padding:7px 13px;border:1px solid #39554d;border-radius:24px;color:#9ee3cb;background:#162b26;font-size:12px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:25px 0 20px}.card{padding:18px 20px;border:1px solid #2b3945;border-radius:14px;background:#18222c}.number{font-size:26px;letter-spacing:-.5px;margin:6px 0;color:#eef6f9}.small{font-size:12px;color:#90a3b2}.cardlabel{color:#b1c4d0;font-size:12px}.grid{display:grid;grid-template-columns:1.35fr 1fr;gap:18px}.box{border:1px solid #2c3a46;border-radius:15px;background:#151f29;overflow:hidden}.boxhead{display:flex;justify-content:space-between;align-items:center;padding:15px 19px;border-bottom:1px solid #2b3945;font-size:13px}.body{padding:18px 20px}.caption{font-size:19px;min-height:80px;color:#ccebdd;word-break:break-word}.muted{color:#7f93a3}.meter{height:4px;background:#2a3845;border-radius:8px;overflow:hidden;margin:12px 0}.fill{height:100%;background:#89d9c1;transition:width .1s}.messages{min-height:130px;max-height:280px;overflow:auto;scrollbar-width:thin}.message{padding:12px 0;border-top:1px solid #273743;white-space:pre-wrap;word-break:break-word}.role{display:block;margin-bottom:4px;font-size:11px;color:#7fab9b}.timeline{height:330px;overflow:auto;scrollbar-width:thin}.event{display:flex;gap:12px;margin:0 0 15px;font-size:12px}.dot{width:7px;height:7px;min-width:7px;background:#7fceb3;border-radius:100%;margin-top:6px}.time{font-variant-numeric:tabular-nums;color:#7e92a3;font-size:11px}.tools{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.footer{margin-top:18px;font-size:11px;color:#8397a8;display:flex;justify-content:space-between;gap:12px}.error{background:#482b2e;color:#ffc4c4;border-radius:10px;padding:12px;margin-top:15px}.tabs{display:flex;gap:20px;border-bottom:1px solid #2c3a46;margin-top:20px}.tabs button{padding:10px 0;background:none;border:0;border-radius:0;color:#95aabc}.tabs .selected{color:#a5e9d2;border-bottom:2px solid #89d9c1}.check{padding:16px 0;border-bottom:1px solid #2a3946;display:flex;gap:14px}.tick{color:#8cdcc1;font-size:18px}.detail{font-size:12px;color:#93a7b7;margin-top:5px}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:16px}td,th{padding:10px 7px;text-align:left;border-bottom:1px solid #2c3a46;font-weight:400}th{color:#91aaba}.notice{background:#21303a;border:1px solid #384d5a;border-radius:10px;padding:12px 15px;margin:14px 0;color:#bcd0dc;font-size:12px}@media(max-width:720px){.wrap{padding:20px 15px}.grid{grid-template-columns:1fr}.cards{gap:8px}.card{padding:12px}.number{font-size:21px}.header{align-items:flex-start}h1{font-size:24px}.footer{display:block}.timeline{height:220px}}`;
 root.innerHTML=`<style>${style}</style><div class="wrap"></div>`;
 const wrap=root.querySelector('.wrap');
 const render=()=>{
  if(interacting)return;
  const c=controller,last=c.turns?.at(-1),input=last?.input,report=c.report(),p95=report.summary.p95_speech_to_pcm_ms;
  const owner=c.owner||c.selection;
  const sessionLabel=owner?(owner.sessionId?`绑定会话 ${escape(owner.sessionId.slice(0,12))}`:'新会话 · 首次发言后创建'):'';
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
  <div class="footer"><span>${owner?`${sessionLabel} · ${escape(owner.profile)}`:'先打开 Hermes 会话，再从右侧独立语音面板开始。'}</span><span>使用前请结束原生语音通话 · 日志导出省略对话正文</span></div>`;
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
