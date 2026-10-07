import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPanel} from '../desktop/panel.mjs';

test('panel renders draft sessions, starts voice, and updates after session creation', t=>{
 const listeners=new Map();
 const nodes=new Map(['.cards','.tools','.footer','.timeline'].map(key=>[key,{scrollTop:0}]));
 const wrap={innerHTML:'',querySelector:key=>nodes.get(key),insertBefore(){}};
 const root={innerHTML:'',querySelector:()=>wrap,
  addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener(){},removeEventListener(){}}});
 let dispose;
 t.after(()=>{dispose?.();if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else delete globalThis.window;});
 let update,started=0,unsubscribed=false;
 const controller={selection:{sessionId:null,profile:'default'},owner:null,
  turns:[],messages:[],journal:{rows:[]},frames:0,state:'idle',
  report:()=>({summary:{}}),start:()=>started++,
  subscribe:fn=>{update=fn;return()=>{unsubscribed=true;};}};
 dispose=mountPanel({shadowRoot:root},controller);
 for(const sessionId of [null,undefined,'']){
  controller.selection.sessionId=sessionId;update();
  assert.match(wrap.innerHTML,/新会话 · 首次发言后创建/);
  assert.match(wrap.innerHTML,/data-action="start"\s*>/);
 }
 listeners.get('click')({target:{closest:()=>({dataset:{action:'start'}})}});
 assert.equal(started,1);
 controller.owner={sessionId:null,profile:'draft-profile'};
 controller.selection={sessionId:'previous-session-id',profile:'previous'};
 update();assert.match(wrap.innerHTML,/新会话 · 首次发言后创建 · draft-profile/);
 controller.owner.sessionId='new-session-123456789';update();
 assert.match(wrap.innerHTML,/绑定会话 new-session- · draft-profile/);
 controller.owner=null;controller.selection=null;update();
 assert.match(wrap.innerHTML,/先打开 Hermes 会话/);
 dispose();dispose=null;assert.equal(unsubscribed,true);assert.equal(listeners.size,0);
});
