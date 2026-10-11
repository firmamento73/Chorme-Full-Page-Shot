// Test only: bridges extension APIs to real Playwright pages and CDP screenshots.
// It is never included in the distributed extension.
const bridge=(type,args)=>window.testChromeBridge({type,args});
globalThis.importScripts=()=>{};
globalThis.chrome={
 runtime:{id:'test',getURL:path=>location.origin+'/'+path,onMessage:{addListener:fn=>{globalThis.testMessageListener=fn;}},sendMessage:async message=>bridge('send',message)},
 scripting:{insertCSS:async request=>bridge('insertCSS',request),removeCSS:async request=>bridge('removeCSS',request),executeScript:async request=>bridge('script',{...request,func:request.func?.toString()})},
 debugger:{attach:async target=>bridge('attach',target),detach:async target=>bridge('detach',target),sendCommand:async(target,method,params)=>bridge('command',{target,method,params}),onDetach:{addListener:()=>{}}},
 tabs:{get:async id=>bridge('tab',id),query:async request=>bridge('query',request),create:async request=>bridge('create',request)},
 windows:{get:async id=>({id,focused:true,state:'normal',...globalThis.testWindowState})},
 storage:{local:{set:async()=>{},get:async()=>({})}},
 action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
 downloads:{download:async request=>bridge('download',request)}
};
globalThis.testSend=message=>new Promise(resolve=>testMessageListener(message,{id:'test',url:location.origin+'/popup.html'},resolve));
