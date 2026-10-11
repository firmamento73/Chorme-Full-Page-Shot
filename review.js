const $=id=>document.getElementById(id),DB=ArchiveDB,C=ArchiveCore,E=ArchiveExport;
let jobId=new URLSearchParams(location.search).get('job');
let job,tiles=[],items=[],mode='screens',offset=0,visible=[],busy=false,generation=0;
const labels={running:'采集中',paused:'已暂停',stopped:'用户结束',complete:'网站确认到底',bottom:'完整性未确认',limit:'达到本次上限'};
async function send(m){const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw new Error(r?.error||'扩展未响应');return r.value;}
function status(value){$('status').textContent=value;}
function filtered(){const text=$('search').value.toLocaleLowerCase();return mode==='screens'?tiles:items.filter(i=>(i.title+' '+i.author).toLocaleLowerCase().includes(text));}
function refreshView(){generation++;offset=0;$('grid').replaceChildren();visible=filtered();$('more').hidden=true;$('viewHint').textContent=mode==='screens'?`${tiles.length} 个截图增量片段；导出时合并已验证接缝。`:`${items.length} 条笔记 · ${items.filter(i=>!i.hasImage).length} 条封面待补。仅保存列表卡片。`;void more();}
async function more(){
  const epoch=generation,batch=visible.slice(offset,offset+20);offset+=batch.length;
  $('more').disabled=true;
  for(const row of batch){
    if(epoch!==generation)return;
    const card=document.createElement('article');card.className='card';
    let src=null;
    if(mode==='screens'||row.hasImage){
      const stored=await DB.get(mode==='screens'?'tiles':'items',row.id);if(epoch!==generation)return;
      if(stored?.blob){src=URL.createObjectURL(stored.blob);const img=document.createElement('img');img.alt=mode==='screens'?`截图 ${row.index+1}`:row.title;img.onload=img.onerror=()=>URL.revokeObjectURL(src);img.src=src;card.append(img);}
    }
    if(!src){const p=document.createElement('div');p.className='placeholder';p.textContent='封面未完整采集';card.append(p);}
    const body=document.createElement('div');body.className='body';
    const title=document.createElement('p');title.textContent=mode==='screens'?`第 ${row.index+1} 段 · ${row.width} × ${row.height}${row.incomplete?' · 加载不完整':''}`:(row.title||'无标题');body.append(title);
    const detail=document.createElement('small');detail.textContent=mode==='screens'?`第 ${row.strip+1} 组拼接片段`:row.author;body.append(detail);
    if(mode==='notes'&&C.safeLink(row.url)){const a=document.createElement('a');a.href=C.safeLink(row.url);a.textContent='打开原笔记';a.target='_blank';a.rel='noopener noreferrer';body.append(document.createElement('br'),a);}
    card.append(body);$('grid').append(card);
  }
  if(!visible.length){$('grid').innerHTML='<p class="empty">没有符合条件的已保存内容。</p>';}
  $('more').hidden=offset>=visible.length;$('more').disabled=false;
}
async function exportWith(fn){
  if(busy)return;busy=true;$('pngMode').disabled=$('pdfMode').disabled=$('forceJoin').disabled=true;for(const id of ['png','pdf','html','remove'])$(id).disabled=true;
  try{const count=await fn();status(`已交给 Chrome 下载：${count} 个文件。请在下载列表确认完成。`);}catch(e){status(e.message);}
  finally{busy=false;$('pngMode').disabled=$('pdfMode').disabled=$('forceJoin').disabled=false;$('png').disabled=$('pdf').disabled=!tiles.length;$('html').disabled=!items.length;$('remove').disabled=job.status==='running';}
}
async function init(){
  const jobs=(await DB.jobs()).sort((a,b)=>b.updated-a.updated);
  if(!jobId&&jobs.length)jobId=jobs[0].id;
  for(const j of jobs){const o=document.createElement('option');o.value=j.id;o.textContent=`${new Date(j.created).toLocaleString()} · ${j.title.slice(0,45)}`;o.selected=j.id===jobId;$('history').append(o);}
  job=await DB.get('jobs',jobId);if(!job){$('title').textContent='暂无归档结果';throw new Error('任务不存在，或本地缓存已被清除。');}
  // Query runtime so interrupted workers are reported as paused.
  const last=await send({type:'LAST',tabId:job.tabId});if(last?.id===job.id)job=last;
  tiles=(await DB.list('tiles',job.id)).sort((a,b)=>a.index-b.index);items=(await DB.list('items',job.id)).sort((a,b)=>a.index-b.index);
  $('title').textContent=job.title;
  if(C.safeLink(job.url)){const a=document.createElement('a');a.href=C.safeLink(job.url);a.textContent='打开来源页面';a.target='_blank';a.rel='noopener noreferrer';$('source').append(a);}
  $('counts').textContent=`${labels[job.status]||job.status} · ${tiles.length} 段截图 · ${items.length} 条笔记 · ${(job.bytes/1048576).toFixed(1)} MB`;
  $('reason').textContent=job.reason||(job.status==='running'?'任务仍在采集，此处为当前已保存结果。返回结果页后刷新可查看新增内容。':'');
  $('warnings').hidden=!job.warnings.length;$('warningText').textContent=job.warnings.join('\n');
  $('png').disabled=$('pdf').disabled=!tiles.length;$('html').disabled=!items.length;$('remove').disabled=job.status==='running';$('record').disabled=false;refreshView();
}
$('png').onclick=()=>exportWith(()=>E.png(job,tiles,status,{mode:$('pngMode').value,allowIndependent:$('forceJoin').checked}));$('pdf').onclick=()=>exportWith(()=>E.pdf(job,tiles,status,{mode:$('pdfMode').value,allowIndependent:$('forceJoin').checked}));$('html').onclick=()=>exportWith(()=>E.html(job,items,status));
$('record').onclick=async()=>{try{const {last,tabId,...record}=job;await E.download(new Blob([JSON.stringify({...record,tiles,items},null,2)],{type:'application/json'}),`${C.filename(job.title)}_采集记录.json`);status('采集记录已交给 Chrome 下载。');}catch(e){status(e.message);}};
$('remove').onclick=async()=>{if(busy||!confirm('删除此任务的本地缓存？已下载的文件仍保留。'))return;try{await send({type:'DELETE',jobId:job.id});location.href='review.html';}catch(e){status(e.message);}};
$('history').onchange=()=>{location.href='review.html?job='+encodeURIComponent($('history').value);};
for(const name of ['screens','notes'])$(name).onclick=()=>{mode=name;$('screens').setAttribute('aria-pressed',name==='screens');$('notes').setAttribute('aria-pressed',name==='notes');$('search').hidden=name==='screens';refreshView();};
$('search').oninput=refreshView;$('more').onclick=()=>more().catch(e=>status(e.message));
init().catch(e=>status(e.message));
