// Chrome DevTools' Capture full size screenshot path: one full-document PNG.
const classicTasks=new Map(),classicResults=new Map();
async function classicStatus(tabId){
  if(classicResults.has(tabId))return classicResults.get(tabId);
  const key='classic:'+tabId,stored=(await chrome.storage.local.get(key))[key];
  if(stored?.status==='running')return {...stored,status:'error',phase:'截图进程已中断，请重新截图。'};
  return stored||null;
}
async function classicPhase(result,phase,status=result.status){
  Object.assign(result,{phase,status,updated:Date.now()});classicResults.set(result.tabId,result);
  await chrome.storage.local.set({['classic:'+result.tabId]:result});
}
async function startClassic(request){
  const tab=await chrome.tabs.get(request.tabId);
  if(!C.supported(tab.url))throw new Error('请在普通网页中使用 F12 整页截图。');
  if(classicTasks.has(tab.id)||[...tasks.values()].some(s=>s.tabId===tab.id))throw new Error('此页面正在截图或采集，请等待完成或先暂停。');
  await inject(tab.id);
  const layout=await page(tab.id,'scrollTargets');
  if(layout.internal&&!layout.documentScrollable){
    return redirectClassic({tabId:tab.id,title:tab.title||'网页',url:tab.url},request.options||{},false);
  }
  const state={tabId:tab.id,detached:false};classicTasks.set(tab.id,state);
  const result={tabId:tab.id,url:tab.url,status:'running',phase:'正在准备 F12 整页截图',title:tab.title||'网页'};
  try{await classicPhase(result,result.phase);}catch(e){classicTasks.delete(tab.id);throw e;}
  void runClassic(result,state,request.options||{}).catch(console.error);return result;
}
async function redirectClassic(result,options,visible){
  const job=await start({tabId:result.tabId,expectedUrl:result.url,options:{forceVisible:visible,background:!visible,seamless:true,hideOverlays:options.hideOverlays!==false,overview:false}});
  result.jobId=job.id;
  await classicPhase(result,visible?'Chrome 拒绝调试连接，已转为前台兼容归档。请保持原标签页可见；完成后在结果页导出长图。':'正文位于内部滚动区域，已转为滚动归档；完成后请在结果页导出连续长图。','redirected');
  return {mode:'scroll',jobId:job.id};
}
async function runClassic(result,state,options){
  const target={tabId:result.tabId};let attached=false,prepared=false,css=null,original=null,redirect=false;
  async function command(method,params){
    const tab=await chrome.tabs.get(result.tabId);
    if(tab.url!==result.url)throw new Error('原页面已跳转，请在新页面重新截图。');
    if(state.detached)throw new Error('截图连接已断开，请关闭 F12 后重试。');
    return bounded('F12 截图操作',()=>chrome.debugger.sendCommand(target,method,params),45000);
  }
  try{
    await badge(result,'…');
    let abandoned=false;
    try{await bounded('连接 F12 截图',()=>chrome.debugger.attach(target,'1.3').then(()=>{attached=true;if(abandoned)void chrome.debugger.detach(target).catch(()=>{});}));}
    catch(e){abandoned=true;if(ArchiveCapture.restricted(e)){redirect=true;return;}throw ArchiveCapture.connectionError(e);}
    await command('Emulation.setFocusEmulationEnabled',{enabled:true});
    const saved=await command('Runtime.evaluate',{expression:'({x:scrollX,y:scrollY})',returnByValue:true});original=saved.result.value;
    await inject(result.tabId);prepared=true;
    const info=await page(result.tabId,'classicPrepare',{hideOverlays:options.hideOverlays!==false});css=info.overlayCSS;
    await chrome.scripting.insertCSS({target:{tabId:result.tabId},css,origin:'USER'});
    if(options.preload!==false){
      await classicPhase(result,'正在预滚动触发懒加载（最多 200 屏）');
      const preload=await command('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
        const wait=ms=>new Promise(r=>setTimeout(r,ms));let count=0;
        for(let y=0;y<document.documentElement.scrollHeight&&count<200;y+=Math.max(innerHeight,200)){
          scrollTo({top:y,left:0,behavior:'instant'});await wait(120);count++;
        }
        scrollTo({top:0,left:0,behavior:'instant'});await wait(250);
        return {limit:count>=200};
      })()`});
      if(preload.exceptionDetails)throw new Error('预滚动未能完成，请重试或关闭预滚动。');
      result.preloadLimited=preload.result.value?.limit===true;
    }
    await classicPhase(result,'正在按 F12 整页截图方式生成 PNG');
    // Recheck floating UI after preload, before the one-shot document capture.
    await page(result.tabId,'classicCheck');await sleep(250);
    const metrics=await command('Page.getLayoutMetrics'),content=metrics.cssContentSize||metrics.contentSize;
    const width=Math.ceil(content?.width),height=Math.ceil(content?.height);
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('无法取得整页尺寸。');
    // Explicitly refuse an oversized capture rather than silently truncating it.
    if(width>16384||height>16384||width*height>64000000)throw new Error(`页面尺寸 ${width} × ${height} 超过 F12 模式安全范围，请使用滚动归档导出连续长图。`);
    const shot=await command('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:true,clip:{x:0,y:0,width,height,scale:1}});
    C.pngBlob(shot.data);
    const host=C.filename(new URL(result.url).hostname||'page'),stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'').replace('T','-');
    result.filename=`整页截图/${host}-${stamp}-F12.png`;result.width=width;result.height=height;
    await classicPhase(result,'正在保存整页 PNG');
    result.downloadId=await chrome.downloads.download({url:'data:image/png;base64,'+shot.data,filename:result.filename,saveAs:false});
    await classicPhase(result,`已提交下载：${result.filename}${result.preloadLimited?'；预滚动已达 200 屏上限':''}`,'complete');
    await badge(result,'✓');
  }catch(e){await classicPhase(result,e.message,'error');await badge(result,'!');}
  finally{
    if(prepared)try{await page(result.tabId,'cleanup');}catch{}
    if(css)try{await chrome.scripting.removeCSS({target:{tabId:result.tabId},css,origin:'USER'});}catch{}
    if(attached){
      const tab=await chrome.tabs.get(result.tabId).catch(()=>null);
      if(original&&tab?.url===result.url)try{await chrome.debugger.sendCommand(target,'Runtime.evaluate',{expression:`scrollTo({left:${Number(original.x)||0},top:${Number(original.y)||0},behavior:'instant'})`});}catch{}
      try{await chrome.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:false});}catch{}
      try{await chrome.debugger.detach(target);}catch{}
    }
    if(redirect){
      const pending=queue.then(()=>{classicTasks.delete(result.tabId);return redirectClassic(result,options,true);});queue=pending.catch(()=>{});
      try{await pending;}catch(e){await classicPhase(result,e.message,'error');await badge(result,'!');}
    }else classicTasks.delete(result.tabId);
  }
}
