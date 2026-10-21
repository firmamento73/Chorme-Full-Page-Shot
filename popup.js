const $=id=>document.getElementById(id);
let tab,job,mode='scroll',internalScroll=false;
function setMode(value){mode=value;$('classicPanel').hidden=value!=='classic';$('scrollPanel').hidden=$('scrollHelp').hidden=value==='classic';$('modeScroll').setAttribute('aria-pressed',String(value==='scroll'));$('modeClassic').setAttribute('aria-pressed',String(value==='classic'));void chrome.storage.local.set({captureMode:value}).catch(error);}
async function send(m){const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw new Error(r?.error||'扩展未响应。');return r.value;}
function error(e){$('status').textContent=e.message;}
function options(){return {forceVisible:$('forceVisible').checked,seamless:$('seamless').checked,background:!$('forceVisible').checked&&$('background').checked,hideOverlays:$('hideOverlays').checked,overview:$('overview').checked,allowIncomplete:$('incomplete').checked,waitMs:Number($('wait').value)*1000};}
async function refresh(){
  job=await send({type:'LAST',tabId:tab.id});
  const classic=await send({type:'CLASSIC_STATUS',tabId:tab.id}),classicRunning=classic?.status==='running';
  $('classicStatus').textContent=classic?.phase||'';
  const active=await send({type:'ACTIVE'});$('activeJobs').replaceChildren();
  for(const j of active.filter(j=>j.tabId!==tab.id)) {
    const p=document.createElement('p');p.textContent=`其他页面：${j.title.slice(0,25)} · ${j.tileCount} 段 `;
    const button=document.createElement('button');button.textContent='暂停';button.onclick=()=>send({type:'PAUSE',jobId:j.id}).then(refresh).catch(error);p.append(button);$('activeJobs').append(p);
  }
  $('jobPanel').hidden=!job;
  const running=job?.status==='running';
  $('pause').hidden=!running;$('stop').hidden=!running;
  $('resume').hidden=!job||running||job.url!==tab.url||job.status==='complete';
  $('classicStart').disabled=running||classicRunning||!ArchiveCore.supported(tab.url);$('classicStart').textContent=classicRunning?'正在生成整页截图…':'一键 F12 整页截图';
  $('classicPreload').disabled=classicRunning||internalScroll;$('classicHide').disabled=classicRunning;
  $('start').disabled=running||classicRunning||!ArchiveCore.supported(tab.url);$('choose').disabled=$('reset').disabled=$('exclude').disabled=$('clearExclusions').disabled=running||classicRunning||!ArchiveCore.supported(tab.url);$('hideOverlays').disabled=running||classicRunning;$('background').disabled=running;$('seamless').disabled=running;
  $('forceVisible').disabled=running||classicRunning;
  if(running&&job.captureBackend==='visible'){$('forceVisible').checked=true;$('background').checked=false;}
  $('background').disabled=running||classicRunning||$('forceVisible').checked;
  $('compatHint').hidden=job?.captureBackend!=='visible';
  $('start').textContent=running?'采集正在运行':'从顶部开始采集';
  if(job){$('progress').textContent=`已保存 ${job.tileCount} 段 · ${job.itemCount} 条笔记 · ${(job.bytes/1048576).toFixed(1)} MB\n${running?job.phase:job.reason}`;}
}
$('modeScroll').onclick=()=>setMode('scroll');$('modeClassic').onclick=()=>setMode('classic');
$('forceVisible').onchange=()=>{$('background').disabled=$('forceVisible').checked;if($('forceVisible').checked)$('background').checked=false;};
$('classicStart').onclick=async()=>{try{await send({type:'CLASSIC_START',tabId:tab.id,options:{preload:$('classicPreload').checked,hideOverlays:$('classicHide').checked}});window.close();}catch(e){error(e);}};
async function setup(){
  $('destination').textContent=await ArchiveOutput.description();
  [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab)throw new Error('没有活动标签页。');
  await refresh();setInterval(()=>refresh().catch(error),1000);
  const preferred=await chrome.storage.local.get('captureMode'),classic=await send({type:'CLASSIC_STATUS',tabId:tab.id});
  setMode(classic?.status==='running'||preferred.captureMode==='classic'?'classic':'scroll');
  const info=await send({type:'INFO',tabId:tab.id});
  if(!info.supported){$('title').textContent='当前页面无法采集';$('selection').textContent='其他页面的采集任务继续运行，可在下方暂停。';return;}
  $('exclusions').textContent=`已点选排除 ${info.manualExclusions||0} 个元素；网页刷新后需重新点选。`;
  internalScroll=(info.scrollTargets?.internal||info.scrollTargets?.embedded)&&!info.scrollTargets?.documentScrollable;
  $('classicHint').hidden=!internalScroll;
  $('title').textContent=info.title;$('selection').textContent=info.selected?(info.selectionMode==='auto'?'已自动识别正文滚动区域':'已手动选择页面内的滚动区域'):'采集区域：自动识别正文／整个网页';
  await refresh();
  if(job){$('forceVisible').checked=job.options.forceVisible===true;$('seamless').checked=job.options.seamless!==false;$('background').checked=job.options.background!==false;$('hideOverlays').checked=job.options.hideOverlays!==false;$('wait').value=job.options.waitMs/1000;$('incomplete').checked=job.options.allowIncomplete;$('overview').checked=job.options.overview;}
  await refresh();

}
$('start').onclick=async()=>{try{await send({type:'START',tabId:tab.id,options:options()});window.close();}catch(e){error(e);}};
$('resume').onclick=async()=>{try{await send({type:'START',tabId:tab.id,resume:job.id,options:options()});window.close();}catch(e){error(e);}};
$('choose').onclick=async()=>{try{await send({type:'CHOOSE',tabId:tab.id});window.close();}catch(e){error(e);}};
$('exclude').onclick=async()=>{try{await send({type:'EXCLUDE',tabId:tab.id});window.close();}catch(e){error(e);}};
$('clearExclusions').onclick=async()=>{try{await send({type:'CLEAR_EXCLUSIONS',tabId:tab.id});$('exclusions').textContent='已清空点选排除。';}catch(e){error(e);}};
$('reset').onclick=async()=>{try{await send({type:'RESET',tabId:tab.id});$('selection').textContent='采集区域：自动识别正文／整个网页';}catch(e){error(e);}};
for(const [id,type] of [['pause','PAUSE'],['stop','STOP']])$(id).onclick=()=>send({type,jobId:job.id}).then(refresh).catch(error);
$('result').onclick=()=>send({type:'OPEN',jobId:job.id}).catch(error);
setup().catch(error);
