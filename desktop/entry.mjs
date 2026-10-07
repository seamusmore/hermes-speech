import React,{useEffect,useRef,useState} from 'react';
import {host as sdkHost,COMPOSER_AREAS,ROUTES_AREA,SIDEBAR_NAV_AREA,PALETTE_AREA} from '@hermes/plugin-sdk';
import {ChainedController} from './chained.mjs';
import {mountPanel} from './panel.mjs';
import {DesktopHostAdapter} from './host-adapter.mjs';
import {RealtimeCompatibility} from './shared/realtime.mjs';
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

