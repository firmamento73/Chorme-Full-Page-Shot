// Isolated content-script world. Site globals/cookies are not read.
(function() {
  'use strict';
  const version='2.2.3';
  if(globalThis.FullPageCollector?.version===version)return;
  globalThis.FullPageCollector?.cleanup();
  const token=crypto.randomUUID();
  let selected=null,selectionKey='document',selectionMode='auto',running=false,backgroundMode=false,interruption='',restore=[],picker=null,cancelPicker=null;
  const documentRoot=()=>document.scrollingElement || document.documentElement;
  const root=()=>selected?.isConnected?selected:documentRoot();
  const isDocument=e=>e===documentRoot();
  const pos=()=>isDocument(root())?scrollY:root().scrollTop;
  const round=n=>Math.round(n*100)/100;
  const rect=r=>({x:round(r.left),y:round(r.top),width:round(r.width),height:round(r.height)});
  const intersects=(r,a)=>r.width>0&&r.height>0&&r.right>a.x&&r.left<a.x+a.width&&r.bottom>a.y&&r.top<a.y+a.height;
  function assert() {
    if(interruption)throw new Error(interruption);
    if(document.hidden&&!backgroundMode)throw new Error('目标标签页已隐藏，已暂停。请回到原标签页继续。');
    if(selected&&!selected.isConnected)throw new Error('所选区域已被网页替换，请重新选择区域并创建任务。');
  }
  function baseArea() {
    return ArchiveScrollTargets.box(root());
  }
  const area=()=>ArchiveScrollTargets.visibleArea(root());
  const overlays=new ArchiveOverlays(root,area,pos);
  function loaded(img) {return !!img.currentSrc&&img.complete&&img.naturalWidth>0;}
  function noteCards(a) {
    const scope=isDocument(root())?document:root(),found=new Map();
    for(const link of scope.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"],a[data-archive-id]')) {
      let url;try{url=new URL(link.getAttribute('href'),location.href);}catch{continue;}
      if(!/^https?:$/.test(url.protocol))continue;
      const id=link.dataset.archiveId || url.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9_-]+)/)?.[1];
      if(!id||found.has(id))continue;
      const card=link.closest('.note-item,section[data-note-id],[data-archive-card]') || link;
      const r=card.getBoundingClientRect();
      if(!intersects(r,a)||!overlays.visible(card))continue;
      const images=[...card.querySelectorAll('img')].filter(i=>overlays.visible(i));
      const image=images.find(i=>!i.closest('.author,.author-wrapper')&&i.getBoundingClientRect().height>60);
      const title=(card.querySelector('.title,.note-title,[data-archive-title]')?.textContent || link.getAttribute('title') || card.innerText || '').trim().slice(0,300);
      const author=(card.querySelector('.author .name,.author-wrapper .name,.author-name,[data-archive-author]')?.textContent || '').trim().slice(0,100);
      const cover=image?.getBoundingClientRect();
      const complete=r.left>=a.x-0.5&&r.right<=a.x+a.width+0.5&&r.top>=a.y-0.5&&r.bottom<=a.y+a.height+0.5&&images.every(loaded);
      found.set(id,{noteId:id,title,author,url:url.href,complete,area:rect(r),cover:cover?rect(cover):null});
    }
    return [...found.values()];
  }
  function inspect() {
    assert();overlays.sync();overlays.check();
    const a=area(),base=baseArea(),e=root(),scope=isDocument(e)?document:e;
    if(a.width<80||a.height<100)throw new Error('截图区域太小或被遮挡，请重新选择区域或调整窗口。');
    const images=[...scope.querySelectorAll('img')].filter(i=>intersects(i.getBoundingClientRect(),a)&&overlays.visible(i));
    const pending=images.filter(i=>!loaded(i));
    const skeletons=[...scope.querySelectorAll('[aria-busy="true"], [class*="skeleton"], [class*="Skeleton"], [data-archive-loading]')].filter(e=>intersects(e.getBoundingClientRect(),a)&&overlays.visible(e));
    const anchors=[];
    for(const el of scope.querySelectorAll('img,p,h1,h2,h3,li,a[href],[data-archive-row]')) {
      const r=el.getBoundingClientRect();if(!intersects(r,a)||r.height<3||!overlays.visible(el))continue;
      let key=el.id?`id:${el.id}`:el.tagName+':'+(el.getAttribute('href')||el.getAttribute('src')||el.textContent?.trim().slice(0,100)||'');
      const card=el.closest('.note-item,[data-archive-card],section[data-note-id]');
      const cardLink=card?.querySelector('a[href]');
      const context=card?.dataset.noteId||card?.dataset.index||cardLink?.getAttribute('href');
      if(context)key=context+'|'+key;
      if(key.length<4 || anchors.some(x=>x.key===key))continue;
      anchors.push({key,...rect(r)});if(anchors.length>=120)break;
    }
    const notes=noteCards(a);
    const position=pos(),start=position+a.y-base.y,end=start+a.height;
    const maximum=Math.max(0,e.scrollHeight-e.clientHeight);
    const endElement=[...scope.querySelectorAll('[data-archive-end],.end-container,.no-more,.no-more-text')].find(el=>overlays.visible(el)&&intersects(el.getBoundingClientRect(),a)&&/没有更多|到底|全部加载|no more|end of|all loaded/i.test(el.textContent || ''));
    const state={token,url:location.href,title:document.title,area:a,position,start,end,maximum,atBottom:position>=maximum-2,explicitEnd:!!endElement,
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},anchors,notes,hiddenOverlays:overlays.hidden.size,overlayRevision:overlays.revision,
      ready:pending.length===0&&skeletons.length===0&&document.fonts.status==='loaded',pendingImages:pending.length,skeletons:skeletons.length};
    state.contentSignature=JSON.stringify([a,round(position),[...anchors].sort((a,b)=>a.key.localeCompare(b.key)),images.map(i=>[i.currentSrc,loaded(i)]).sort((a,b)=>a[0].localeCompare(b[0])),notes.map(n=>[n.noteId,n.title,n.complete]).sort((a,b)=>a[0].localeCompare(b[0]))]);
    state.signature=JSON.stringify([state.contentSignature,overlays.revision]);
    return state;
  }
  function move(target) {
    assert();const e=root();
    const before=pos(),expected=Math.max(0,Math.min(target,e.scrollHeight-e.clientHeight));
    if(isDocument(e))window.scrollTo({top:target,left:scrollX,behavior:'instant'});
    else e.scrollTo({top:target,left:e.scrollLeft,behavior:'instant'});
    if(Math.abs(expected-before)>2&&Math.abs(pos()-before)<.5)throw new Error('所选区域没有响应滚动，请点击“选择滚动区域”并点正文列表；若使用自绘滚动条，当前可能不支持。');
    return pos();
  }
  function cleanup() {
    cancelPicker?.();running=false;backgroundMode=false;overlays.stop();for(const fn of restore.splice(0))fn();interruption='';
  }
  function prepare(options) {
    cleanup();backgroundMode=options?.background===true;
    if(!options?.wholeDocument&&selectionMode==='auto'&&options?.resolveTarget!==false){
      const found=ArchiveScrollTargets.resolve(),next=isDocument(found.element)?null:found.element;
      if(next!==selected){selected=next;selectionKey=selected?crypto.randomUUID():'document';}
    }
    assert();const e=root();
    for(const property of ['scroll-behavior','overflow-anchor','scroll-snap-type']) {
      const value=e.style.getPropertyValue(property),priority=e.style.getPropertyPriority(property);
      e.style.setProperty(property,property==='scroll-behavior'?'auto':'none','important');
      restore.push(()=>value?e.style.setProperty(property,value,priority):e.style.removeProperty(property));
    }
    running=true;
    if(options?.top)move(0);
    if(Number.isFinite(options?.position))move(options.position);
    overlays.start(options?.hideOverlays!==false);overlays.check();
    return {token,url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},selectionKey,selectionMode,overlayCSS:overlays.css(),exclusionKey:overlays.key,manualExclusions:overlays.count(),selection:isDocument(e)?'整个网页':`${selectionMode==='auto'?'自动识别：':''}${e.tagName.toLowerCase()}${e.id?'#'+e.id:''}`};
  }
  function choose(kind='scroll') {
    cleanup();picker?.remove();picker=document.createElement('div');
    picker.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const shadow=picker.attachShadow({mode:'closed'});
    shadow.innerHTML='<style>aside{position:fixed;top:12px;left:12px;background:#123c36;color:white;padding:12px 18px;border-radius:10px;font:14px system-ui}div{position:fixed;border:3px solid #16a085;background:#16a08522;box-sizing:border-box}</style><aside>点击要保存的滚动区域；Esc 取消。只支持当前页面，iframe 内部暂不支持。</aside><div></div>';
    if(kind==='exclude')shadow.querySelector('aside').textContent='点击要排除的浮层（优先选择最近的固定控件）；Esc 取消。仅采集时隐藏。';
    document.documentElement.append(picker);
    function candidate(el) {
      if(kind==='exclude')return overlays.candidate(el);
      return ArchiveScrollTargets.closest(el);
    }
    const hover=ev=>{const e=candidate(ev.composedPath()[0]),r=isDocument(e)?{left:0,top:0,width:innerWidth,height:innerHeight}:e.getBoundingClientRect();shadow.querySelector('div').style.cssText=`left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;};
    function finish() {document.removeEventListener('mousemove',hover,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);picker?.remove();picker=null;cancelPicker=null;}
    cancelPicker=finish;
    const click=ev=>{ev.preventDefault();ev.stopImmediatePropagation();const element=candidate(ev.composedPath()[0]);if(kind==='exclude'){if(!overlays.protected(element))overlays.add(element);}else{selected=element;selectionMode='manual';selectionKey=isDocument(selected)?'document':crypto.randomUUID();}finish();};
    const key=ev=>{if(ev.key==='Escape'){ev.preventDefault();finish();}};
    document.addEventListener('mousemove',hover,true);document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);
    return true;
  }
  for(const name of ['wheel','touchstart','keydown'])window.addEventListener(name,ev=>{
    if(!running||!ev.isTrusted)return;
    if(name==='keydown'&&!['PageDown','PageUp','Home','End','ArrowUp','ArrowDown',' ','Escape'].includes(ev.key))return;
    interruption='检测到手动滚动或停止操作，已暂停。';
  },{capture:true,passive:true});
  globalThis.FullPageCollector={version,inspect,move,prepare,cleanup,choose,
    classicPrepare(options){const old=selected;selected=null;try{const info=prepare({top:true,background:true,wholeDocument:true,hideOverlays:options?.hideOverlays});restore.push(()=>{selected=old;});return info;}catch(e){selected=old;throw e;}},
    classicCheck(){overlays.sync();overlays.check();return true;},
    exclude(){return choose('exclude');},clearExclusions(){cleanup();overlays.clear();return true;},
    reset(){cleanup();selected=null;selectionMode='auto';selectionKey='document';return true;},
    scrollTargets(){const found=ArchiveScrollTargets.candidates();return {internal:found.length>0,documentScrollable:ArchiveScrollTargets.documentScrollable()};},
    info(){return {token,title:document.title,url:location.href,visibility:document.visibilityState,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},selectionKey,selectionMode,selected:!isDocument(root()),running,manualExclusions:overlays.count(),exclusionKey:overlays.key};}
  };
})();
