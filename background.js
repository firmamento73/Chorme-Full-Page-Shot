importScripts('core.js','db.js','seams.js');
const C=ArchiveCore,DB=ArchiveDB,tasks=new Map();
importScripts('capture-backend.js','classic.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function internal(sender) {return sender.id===chrome.runtime.id&&sender.url?.startsWith(chrome.runtime.getURL(''));}
async function bounded(label,fn,limit=15000) {
  let timer;
  try {return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}超时，已保存结果保留。`)),limit);})]);}
  finally{clearTimeout(timer);}
}
async function inject(tabId) {await bounded('载入采集组件',()=>chrome.scripting.executeScript({target:{tabId},files:['overlays.js','scroll-target.js','collector.js']}));}
async function page(tabId,action,arg) {
  const result=await bounded('检查网页',()=>chrome.scripting.executeScript({target:{tabId},func:(action,arg)=>{
    try {return {ok:true,value:globalThis.FullPageCollector[action](arg)};}catch(e){return {ok:false,error:e.message};}
  },args:[action,arg??null]}));
  if(!result[0]?.result?.ok)throw new Error(result[0]?.result?.error || '无法访问原网页，请刷新后创建新任务。');
  return result[0].result.value;
}
async function check(job,state,starting=false) {
  if(state.stop)throw new Error('用户已暂停。');
  if(state.detached)throw new Error('截图调试连接已断开，请关闭开发者工具后继续。');
  const tab=await chrome.tabs.get(job.tabId);
  if(!tab.url||C.identity(tab.url)!==job.url)throw new Error('原页面已跳转，已停止。');
  if(job.options.background!==false)return true;
  const win=await chrome.windows.get(tab.windowId);
  // Popup windows can take focus without hiding the target tab. CDP captures
  // the attached tab, so window.focused is not a screenshot-source check.
  if(starting)return tab.active&&win.state!=='minimized';
  if(!tab.active)throw new Error('已切换到其他标签页，已暂停。请回到原标签页继续。');
  if(win.state==='minimized')throw new Error('浏览器已最小化，已暂停。恢复窗口后可继续。');
  return true;
}
async function phase(job,label) {
  job.phase=label;job.updated=Date.now();await DB.put('jobs',job);
}
async function waitForStart(job,state) {
  await phase(job,job.options.background!==false?'正在启动原标签页后台采集':'正在启动，等待扩展弹窗关闭、原网页可见');
  await badge(job,'…');
  const started=Date.now();let visibleSince=0;
  while(Date.now()-started<8000) {
    const active=await check(job,state,true);
    const info=active?await page(job.tabId,'info'):null;
    if(active&&(job.options.background!==false||info.visibility==='visible')) {
      visibleSince ||= Date.now();
      if(Date.now()-visibleSince>=350)return info;
    } else visibleSince=0;
    await sleep(100);
  }
  throw new Error('启动等待超时。请关闭扩展弹窗，保持原网页标签可见，再点击继续。');
}
async function waitForViewport(job,state) {
  // Chrome's debugger infobar can resize the viewport after attach. Observe
  // its settled size rather than mistaking our own infobar for a user resize.
  const started=Date.now();let previous=null,stable=0;
  while(Date.now()-started<5000) {
    await check(job,state);
    const info=await page(job.tabId,'info');
    if(job.options.background===false&&info.visibility!=='visible')throw new Error('目标网页已隐藏，已暂停。');
    stable=previous&&['width','height','dpr'].every(k=>previous[k]===info.viewport[k])?stable+1:0;
    previous=info.viewport;
    if(stable>=3&&Date.now()-started>=700)return info;
    await sleep(100);
  }
  throw new Error('连接截图后页面尺寸持续变化，已暂停，请保持窗口尺寸不变后重试。');
}
async function badge(job,text) {try{await chrome.action.setBadgeText({tabId:job.tabId,text});await chrome.action.setBadgeBackgroundColor({tabId:job.tabId,color:'#167568'});}catch{}}
async function waitReady(job,state) {
  let previous=null,stable=0,last=null;
  const started=Date.now();let lastProgress=0;
  while(Date.now()-started<job.options.waitMs) {
    await check(job,state);last=await page(job.tabId,'inspect');
    stable=C.sameView(previous,last)?stable+1:0;previous=last;
    if(job.viewport&&['width','height','dpr'].some(k=>job.viewport[k]!==last.viewport[k]))throw new Error('窗口尺寸或缩放已改变，已暂停。恢复原尺寸后继续；也可刷新整个网页后从头重扫。');
    if(last.ready&&stable>=2&&Date.now()-started>=job.options.settleMs)return last;
    if(Date.now()-lastProgress>=1000) {
      await phase(job,`等待当前区域加载：${last.pendingImages} 张图片、${last.skeletons} 处占位 · 最多还等 ${Math.max(0,Math.ceil((job.options.waitMs-(Date.now()-started))/1000))} 秒`);
      lastProgress=Date.now();
    }
    await sleep(250);
  }
  if(job.options.allowIncomplete&&last&&stable>=2)return {...last,incomplete:true};
  throw new Error(`当前区域在 ${job.options.waitMs/1000} 秒内未完成加载或稳定布局（${last?.pendingImages??0} 张图片、${last?.skeletons??0} 处占位）。可稍后继续，或启用“超时也保存并标记”。`);
}
function warn(job,message) {job.warnings=[...job.warnings,message].slice(-40);}
async function crop(bitmap,a) {
  const x=Math.round(a.x),y=Math.round(a.y),right=Math.round(a.x+a.width),bottom=Math.round(a.y+a.height);
  if(x<0||y<0||right>bitmap.width||bottom>bitmap.height||right<=x||bottom<=y)throw new Error('截图区域超出浏览器渲染范围。');
  if(right-x>8192||(right-x)*(bottom-y)>32000000)throw new Error('当前截图区域过大，请缩小窗口或降低浏览器缩放后重试。');
  const canvas=new OffscreenCanvas(right-x,bottom-y);
  canvas.getContext('2d').drawImage(bitmap,x,y,right-x,bottom-y,0,0,right-x,bottom-y);
  return {blob:await canvas.convertToBlob({type:'image/png'}),width:right-x,height:bottom-y};
}
async function trimSavedTail(job,rows,scale){
  const edits={remove:[],replace:[]};
  const tiles=(await DB.list('tiles',job.id)).sort((a,b)=>b.index-a.index);
  for(const meta of tiles){
    if(!rows)break;
    const old=await DB.get('tiles',meta.id);
    if(rows>=old.height){rows-=old.height;edits.remove.push(old.id);job.tileCount--;job.bytes-=old.blob.size;}
    else {
      const image=await createImageBitmap(old.blob);let part;
      try{part=await crop(image,{x:0,y:0,width:old.width,height:old.height-rows});}finally{image.close();}
      edits.replace.push({...old,...part,end:old.end-rows/scale});job.bytes+=part.blob.size-old.blob.size;rows=0;
    }
  }
  if(rows)throw new Error('接缝回退超出已保存内容。');return edits;
}
function pixels(bitmap){const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);return ctx.getImageData(0,0,bitmap.width,bitmap.height);}
async function capture(job,state,snapshot,known) {
  for(let attempt=0;attempt<3;attempt++) {
    await check(job,state);
    const result=job.captureBackend==='visible'?await ArchiveCapture.visible(job,state):await bounded('浏览器截图',()=>chrome.debugger.sendCommand({tabId:job.tabId},'Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false}),30000);
    await check(job,state);
    const after=await page(job.tabId,'inspect');
    if(!C.sameView(snapshot,after)) {snapshot=await waitReady(job,state);continue;}
    const bitmap=await createImageBitmap(C.pngBlob(result.data)),checkpoint=structuredClone(job);
    try {
      const sx=bitmap.width/snapshot.viewport.width,sy=bitmap.height/snapshot.viewport.height;
      if(Math.abs(sx-sy)>0.02||sx<=0||sx>8)throw new Error('截图像素比例变化，请保持浏览器缩放和窗口尺寸不变。');
      snapshot.captureScale=sx;
      const fresh=snapshot.notes.filter(n=>n.complete&&(!known.has(n.noteId)||!known.get(n.noteId).hasImage));
      const a=snapshot.area,frame=await crop(bitmap,{x:a.x*sx,y:a.y*sy,width:a.width*sx,height:a.height*sy});
      let edits={},tile=null,skip=0,seam={join:false,reason:'first'};
      if(job.last) {
        const previous=await DB.get('frames',job.id+':frame');
        if(previous?.blob){
          const old=await createImageBitmap(previous.blob),now=await createImageBitmap(frame.blob);
          try {
            const geometric=C.seam(job.last,snapshot);
            seam=ArchiveSeams.match(pixels(old),pixels(now),{
              expected:Math.round(job.last.end*sx)-Math.round(snapshot.start*sx),geometry:geometric.join,
              samePosition:C.near(job.last.position,snapshot.position,.01)&&C.near(job.last.start,snapshot.start,.01)});
          } finally{old.close();now.close();}
        } else seam={join:false,reason:'缺少上次的像素参照，请从顶部重新采集'};
        if(!seam.join&&job.options.seamless!==false){const e=new Error('接缝未匹配：'+seam.reason+'。已保留连续结果，当前片段尚未追加。');e.code='SEAM';throw e;}
        if(seam.join){skip=seam.skip;if(seam.trim)edits=await trimSavedTail(job,seam.trim,sx);}
      }
      if(!seam.join) {job.strip++;if(job.last)warn(job,`第 ${job.tileCount+1} 段独立保存：${seam.reason}。`);}
      const top=Math.round(a.y*sy)+skip,bottom=Math.round((a.y+a.height)*sy);
      if(bottom>top) {
        const part=skip?await crop(bitmap,{x:a.x*sx,y:top,width:a.width*sx,height:bottom-top}):frame;
        tile={...part,id:`${job.id}:tile:${job.tileCount}`,jobId:job.id,index:job.tileCount,strip:job.strip,
          start:snapshot.start+skip/sx,end:snapshot.end,incomplete:!!snapshot.incomplete,seam:seam.join?'pixels':'first',captureScale:sx};
        job.tileCount++;job.bytes+=part.blob.size;
      }
      const savedFrame={...frame,id:job.id+':frame',jobId:job.id};
      const items=[];
      if(job.options.overview) {
        for(const note of fresh) {
          const cover=note.cover || note.area;
          const part=await crop(bitmap,{x:cover.x*sx,y:cover.y*sy,width:cover.width*sx,height:cover.height*sy});
          const old=known.get(note.noteId);
          const item={id:`${job.id}:item:${note.noteId}`,jobId:job.id,noteId:note.noteId,title:note.title,author:note.author,url:note.url,hasImage:true,blob:part.blob,index:old?.index??job.itemCount,savedAt:new Date().toISOString()};
          if(!old)job.itemCount++;
          job.bytes+=part.blob.size;items.push(item);
        }
        for(const note of snapshot.notes) {
          if(known.has(note.noteId)||items.some(i=>i.noteId===note.noteId))continue;
          items.push({id:`${job.id}:item:${note.noteId}`,jobId:job.id,noteId:note.noteId,title:note.title,author:note.author,url:note.url,hasImage:false,index:job.itemCount++,savedAt:new Date().toISOString()});
        }
      }
      if(snapshot.incomplete)warn(job,`第 ${job.tileCount} 段包含未加载图片或占位，已标记。`);
      job.hiddenOverlays=snapshot.hiddenOverlays;job.last=snapshot;job.updated=Date.now();job.phase=`已保存 ${job.tileCount} 段${job.options.overview?' · '+job.itemCount+' 条笔记':''}${job.hiddenOverlays?' · 已隐藏 '+job.hiddenOverlays+' 处浮层':''}`;
      // One transaction commits screenshot, items and checkpoint together.
      await DB.commit(job,tile,items,savedFrame,edits);
      for(const item of items){const {blob,...meta}=item;known.set(item.noteId,meta);}
      await badge(job,String(job.tileCount));return snapshot;
    } catch(e){Object.assign(job,checkpoint);throw e;} finally {bitmap.close();}
  }
  throw new Error('截图前后布局持续变化，已暂停；当前不稳定片段未计入结果。');
}
async function run(job,state,resume) {
  let attached=false,prepared=false,overlayCSS=null,focusEmulated=false;
  try {
    await inject(job.tabId);
    const info=await waitForStart(job,state);
    const sameDocument=resume&&info.token===job.documentToken;
    if(sameDocument&&job.sourceViewport&&['width','height','dpr'].some(k=>job.sourceViewport[k]!==info.viewport[k]))throw new Error('窗口尺寸或缩放与上次不同，请恢复原尺寸后继续，或刷新整个网页从头重扫。');
    if(sameDocument&&info.selectionKey!==job.selectionKey)throw new Error('滚动选区已经改变，请创建新任务。');
    if(resume&&job.documentToken&&!sameDocument&&job.selection!=='整个网页')throw new Error('刷新后原滚动区域无法确认，请重新选区并创建任务。');
    if(resume&&job.documentToken&&!sameDocument) {job.last=null;warn(job,'页面已刷新，从顶部重新扫描；已保存笔记会去重，截图另起一段。');}
    if(sameDocument&&job.exclusionKey&&info.exclusionKey!==job.exclusionKey)throw new Error('点选排除的元素已改变，请从顶部创建新任务。');
    if(resume&&!sameDocument&&job.manualExclusions)throw new Error('刷新后点选排除已失效，请重新点选并从顶部创建新任务。');
    job.sourceViewport=info.viewport;
    let visible=job.captureBackend==='visible'||job.options.forceVisible===true;
    if(!visible){
      await phase(job,'正在连接浏览器截图');let attachAbandoned=false;
      try {await bounded('连接截图',()=>chrome.debugger.attach({tabId:job.tabId},'1.3').then(()=>{attached=true;if(attachAbandoned)void chrome.debugger.detach({tabId:job.tabId}).catch(()=>{});}));}
      catch(e){attachAbandoned=true;if(!ArchiveCapture.restricted(e))throw ArchiveCapture.connectionError(e);visible=true;warn(job,'Chrome 拒绝调试连接，已改用前台兼容截图。采集时请保持原标签页可见，完成后再打开结果页。');}
    }
    const backend=visible?'visible':'cdp';
    if(job.tileCount&&(job.captureBackend||'cdp')!==backend)throw new Error('截图方式已改变，像素比例可能不同。请从顶部创建新任务，避免与旧截图混合。');
    job.captureBackend=backend;
    if(visible){job.options.forceVisible=true;job.options.background=false;await phase(job,'前台兼容截图：请保持原标签页可见，完成后再打开结果页');await waitForStart(job,state);}
    if(!visible&&job.options.background!==false) {
      await phase(job,'正在启用原标签页后台绘制');
      try{await bounded('启用后台绘制',()=>chrome.debugger.sendCommand({tabId:job.tabId},'Emulation.setFocusEmulationEnabled',{enabled:true}));focusEmulated=true;}
      catch(e){throw new Error('无法启用后台采集，请更新 Chrome 或取消“切换标签页后继续采集”后重试。'+e.message);}
    }
    await phase(job,'正在等待截图提示栏和页面尺寸稳定');
    await waitForViewport(job,state);
    prepared=true;
    const preparedInfo=await page(job.tabId,'prepare',{resolveTarget:!resume||!sameDocument,top:!resume||!sameDocument||!job.last,position:sameDocument?job.last?.position:undefined,hideOverlays:job.options.hideOverlays,background:job.options.background!==false});
    overlayCSS=preparedInfo.overlayCSS;
    await bounded('应用浮层过滤',()=>chrome.scripting.insertCSS({target:{tabId:job.tabId},css:overlayCSS,origin:'USER'}));
    job.viewport=preparedInfo.viewport;job.documentToken=preparedInfo.token;job.selection=preparedInfo.selection;job.selectionKey=preparedInfo.selectionKey;job.exclusionKey=preparedInfo.exclusionKey;job.manualExclusions=preparedInfo.manualExclusions;
    const known=new Map((await DB.list('items',job.id)).map(i=>[i.noteId,i]));
    let idle=0,cycles=0,snapshot;
    while(cycles++<job.options.maxSteps) {
      for(let retry=0;;retry++) {
        snapshot=await waitReady(job,state);
        try{snapshot=await capture(job,state,snapshot,known);break;}
        catch(e){
          if(e.code!=='SEAM'||retry>=2||!job.last||snapshot.position-job.last.position<16)throw e;
          await check(job,state);await phase(job,'正在缩短滚动距离，重新匹配接缝');
          await page(job.tabId,'move',job.last.position+(snapshot.position-job.last.position)/2);
        }
      }
      if(snapshot.incomplete)warn(job,'加载超时，按用户设置保存当前显示结果。');
      if(snapshot.explicitEnd&&snapshot.ready&&!snapshot.incomplete) {job.status='complete';job.reason='网站显示没有更多内容。';break;}
      if(snapshot.atBottom) {
        const height=snapshot.maximum,signature=snapshot.signature;
        job.phase='已到当前底部，等待可能追加的内容';job.updated=Date.now();await DB.put('jobs',job);
        await sleep(job.options.bottomWaitMs);await check(job,state);
        const next=await page(job.tabId,'inspect');
        if(next.atBottom&&C.near(height,next.maximum)&&signature===next.signature)idle++;else idle=0;
        if(idle>=3) {job.status='bottom';job.reason='连续三轮未发现新内容；网站未提供明确结束标记，完整性尚未确认。';break;}
        // Scroll events may be needed by infinite-scroll implementations.
        if(next.atBottom&&idle) {await page(job.tabId,'move',Math.max(0,next.position-2));await page(job.tabId,'move',next.maximum);}
      } else {
        idle=0;await page(job.tabId,'move',snapshot.position+snapshot.area.height*0.7);
      }
    }
    if(job.status==='running'){job.status='limit';job.reason='达到本次采集轮数上限，可继续任务。';}
  } catch(e) {
    job.status=state.finish?'stopped':'paused';job.reason=e.message;
  } finally {
    if(prepared)try{await page(job.tabId,'cleanup');}catch{}
    if(overlayCSS)try{await chrome.scripting.removeCSS({target:{tabId:job.tabId},css:overlayCSS,origin:'USER'});}catch{}
    if(focusEmulated)try{await bounded('恢复标签页绘制',()=>chrome.debugger.sendCommand({tabId:job.tabId},'Emulation.setFocusEmulationEnabled',{enabled:false}),3000);}catch{}
    if(attached)try{await bounded('断开截图',()=>chrome.debugger.detach({tabId:job.tabId}),3000);}catch{}
    job.phase='采集已结束';job.updated=Date.now();
    try{await DB.put('jobs',job);}finally{tasks.delete(job.id);await badge(job,job.status==='complete'?'✓':'Ⅱ');}
  }
}
let queue=Promise.resolve();
async function start(request) {
  const tab=await chrome.tabs.get(request.tabId);
  if(!C.supported(tab.url))throw new Error('请在普通网页中使用；浏览器内部页面无法截图。');
  if(classicTasks.has(tab.id)||[...tasks.values()].some(state=>state.tabId===tab.id))throw new Error('此标签页已有截图或采集任务，请先等待截图完成或暂停采集。');
  let job;
  if(request.resume) {
    job=await DB.get('jobs',request.resume);if(!job||job.url!==C.identity(tab.url))throw new Error('请回到同一网址和收藏分类继续。');
    if(tasks.has(job.id))throw new Error('该任务正在另一个标签页采集，请先暂停。');
    job.tabId=tab.id;
    if(request.options)job.options.seamless=request.options.seamless!==false;
    if(request.options)job.options.background=request.options.background!==false;
    if(request.options)job.options.forceVisible=job.captureBackend==='visible'||request.options.forceVisible===true;
    if(request.options&&job.tileCount&&(request.options.hideOverlays!==false)!==(job.options.hideOverlays!==false))throw new Error('浮层设置改变后请从顶部创建新任务，避免混入旧截图。');
    if(request.options)job.options.hideOverlays=request.options.hideOverlays!==false;
    if(request.options){job.options.allowIncomplete=request.options.allowIncomplete===true;job.options.waitMs=Math.max(3000,Math.min(60000,Number(request.options.waitMs)||job.options.waitMs));}
  } else {
    const options=request.options||{};
    job={id:crypto.randomUUID(),url:C.identity(tab.url),title:tab.title||'网页',tabId:tab.id,created:new Date().toISOString(),tileCount:0,itemCount:0,bytes:0,strip:-1,last:null,warnings:[],
      options:{forceVisible:options.forceVisible===true,seamless:options.seamless!==false,background:options.background!==false,hideOverlays:options.hideOverlays!==false,overview:options.overview!==false,allowIncomplete:options.allowIncomplete===true,waitMs:Math.max(3000,Math.min(60000,Number(options.waitMs)||15000)),settleMs:Math.max(500,Math.min(5000,Number(options.settleMs)||900)),bottomWaitMs:2500,maxSteps:1500}};
  }
  if(job.options.forceVisible)job.options.background=false;
  job.status='running';job.reason='';job.phase='正在准备启动';job.updated=Date.now();
  const state={tabId:tab.id,stop:false,detached:false,finish:false};tasks.set(job.id,state);
  try{await DB.put('jobs',job);await chrome.storage.local.set({lastJob:job.id});}
  catch(e){tasks.delete(job.id);throw e;}
  void run(job,state,!!request.resume).catch(console.error);return job;
}
async function handle(m,sender) {
  if(!internal(sender))throw new Error('请求来源无效。');
  if(m.type==='CLASSIC_START'){const result=queue.then(()=>startClassic(m));queue=result.catch(()=>{});return result;}
  if(m.type==='CLASSIC_STATUS')return classicStatus(m.tabId);
  if(m.type==='START') {
    const result=queue.then(()=>start(m));queue=result.catch(()=>{});return result;
  }
  if(m.type==='ACTIVE')return (await DB.jobs()).filter(j=>tasks.has(j.id)).map(j=>({id:j.id,tabId:j.tabId,title:j.title,tileCount:j.tileCount,phase:j.phase}));
  if(m.type==='INFO') {
    const tab=await chrome.tabs.get(m.tabId);if(!C.supported(tab.url))return {supported:false};
    await inject(tab.id);return {supported:true,...await page(tab.id,'info'),scrollTargets:await page(tab.id,'scrollTargets')};
  }
  if(['CHOOSE','RESET','EXCLUDE','CLEAR_EXCLUSIONS'].includes(m.type)) {if(classicTasks.has(m.tabId)||[...tasks.values()].some(state=>state.tabId===m.tabId))throw new Error('请先等待此标签页截图完成或暂停采集，再调整选区。');await inject(m.tabId);return page(m.tabId,({CHOOSE:'choose',RESET:'reset',EXCLUDE:'exclude',CLEAR_EXCLUSIONS:'clearExclusions'})[m.type]);}
  if(m.type==='LAST') {
    const jobs=(await DB.jobs()).sort((a,b)=>b.updated-a.updated);
    const job=jobs.find(j=>j.tabId===m.tabId)||null;
    if(job?.status==='running'&&!tasks.has(job.id)){job.status='paused';job.reason='浏览器采集进程已中断，可继续；已保存结果保留。';await DB.put('jobs',job);}
    return job;
  }
  const job=await DB.get('jobs',m.jobId);if(!job)throw new Error('任务不存在。');
  if(m.type==='PAUSE'||m.type==='STOP') {const state=tasks.get(job.id);if(state){state.stop=true;state.finish=m.type==='STOP';}return true;}
  if(m.type==='OPEN')return chrome.tabs.create({url:chrome.runtime.getURL('review.html?job='+encodeURIComponent(job.id))});
  if(m.type==='DELETE') {if(tasks.has(job.id))throw new Error('请先暂停任务。');await DB.remove(job.id);return true;}
  throw new Error('未知操作。');
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{handle(m,sender).then(value=>reply({ok:true,value}),e=>reply({ok:false,error:e.message}));return true;});
chrome.debugger.onDetach.addListener(source=>{const classic=classicTasks.get(source.tabId);if(classic)classic.detached=true;for(const [id,state] of tasks){DB.get('jobs',id).then(j=>{if(j?.tabId===source.tabId)state.detached=true;});}});
