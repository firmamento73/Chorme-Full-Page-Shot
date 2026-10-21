// Route rolling capture into visible HTML frames using the existing debugger
// permission. No host permissions, site APIs, cookies or main-world scripts.
globalThis.ArchiveFrames=(()=>{
  const files=['overlays.js','scroll-target.js','collector.js'];
  let source;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const allowed=url=>/^(https?:|about:blank(?:$|#)|about:srcdoc(?:$|#)|blob:https?:)/.test(url);
  const changed=()=>new Error('内嵌正文已刷新、跳转或被替换，已停止；请从顶部创建新任务，避免混合不同文档。');
  function value(result){
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'无法读取内嵌正文。');
    return result.result?.value;
  }
  async function open(tabId,topPage){
    const sessions=new Map([['',{}]]),frames=new Map(),pending=new Set(),owners=[],prepared=[];
    let closed=false;
    const command=(sessionId,method,params={})=>bounded('访问内嵌正文',()=>chrome.debugger.sendCommand({tabId,...(sessionId?{sessionId}:{})},method,params));
    const evaluate=async(node,expression)=>value(await command(node.session,'Runtime.evaluate',{contextId:node.context,expression,returnByValue:true,awaitPromise:true}));
    const invoke=(node,action,arg)=>evaluate(node,`globalThis.FullPageCollector[${JSON.stringify(action)}](${JSON.stringify(arg??null)})`);
    const autoAttach=session=>command(session,'Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false},{exclude:true}]});
    function event(source,method,params){
      if(closed||source.tabId!==tabId)return;
      if(method==='Target.attachedToTarget'&&params.targetInfo?.type==='iframe'){
        const id=params.sessionId;sessions.set(id,{target:params.targetInfo.targetId});
        const work=autoAttach(id).catch(()=>{}).finally(()=>pending.delete(work));pending.add(work);
      }
    }
    chrome.debugger.onEvent.addListener(event);
    async function cleanup(){
      if(closed)return;closed=true;chrome.debugger.onEvent.removeListener(event);
      for(const node of prepared.reverse())try{if(node.top)await topPage('cleanup');else await invoke(node,'cleanup');}catch{}
      for(const owner of owners){
        try{await command(owner.parent.session,'Runtime.callFunctionOn',{objectId:owner.objectId,functionDeclaration:'function(attribute){this.removeAttribute(attribute);}',arguments:[{value:owner.attribute}]});}catch{}
        try{await command(owner.parent.session,'Runtime.releaseObject',{objectId:owner.objectId});}catch{}
      }
      // The caller detaches the tab's debugger in its finally block, releasing
      // auto-attached sessions too. Never attach to an unrelated browser target.
    }
    try{
      source ||= Promise.all(files.map(async file=>{const response=await fetch(chrome.runtime.getURL(file));if(!response.ok)throw new Error('无法载入内嵌采集组件。');return response.text();})).then(parts=>parts.join('\n'));
      const scripts=await source;
      await autoAttach('');
      let previous=-1;
      for(let i=0;i<20;i++){
        await delay(100);
        if(!pending.size&&previous===sessions.size)break;
        previous=sessions.size;
      }
      // Page.getFrameTree includes in-process frames; OOPIF roots are supplied
      // by their child sessions. Merge by frame ID, preserving parent links.
      for(const [session] of sessions){
        const tree=await command(session,'Page.getFrameTree');
        function add(entry,parent){
          const f=entry.frame,old=frames.get(f.id);
          frames.set(f.id,{...old,id:f.id,url:f.url,parentId:parent||f.parentId||old?.parentId,session});
          for(const child of entry.childFrames||[])add(child,f.id);
        }
        add(tree.frameTree,null);
      }
      const top=[...frames.values()].find(f=>!f.parentId&&f.session==='');
      if(!top)throw new Error('无法定位网页的内嵌正文。');
      top.top=true;
      async function initialize(node){
        if(node.context)return;
        const world=await command(node.session,'Page.createIsolatedWorld',{frameId:node.id,worldName:'FullPageShot.frames.2.2.4'});
        node.context=world.executionContextId;
        await evaluate(node,scripts);
        node.info=await invoke(node,'info');
      }
      await initialize(top);
      const viewport=top.info.viewport,candidates=[],errors=[];
      async function ownerBox(owner){
        return value(await command(owner.parent.session,'Runtime.callFunctionOn',{
          objectId:owner.objectId,returnByValue:true,
          functionDeclaration:`function(){
            if(!this.isConnected||this.tagName!=='IFRAME')throw Error('内嵌正文已被替换。');
            if(!this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return null;
            for(let p=this;p;p=ArchiveScrollTargets.parent(p)){
              const s=getComputedStyle(p);
              if(s.transform!=='none'||s.rotate!=='none'||s.scale!=='none'||s.translate!=='none'||(s.zoom&&Number(s.zoom)!==1))throw Error('内嵌正文带有缩放或变换，无法可靠拼接；请恢复网页默认布局。');
            }
            return {box:ArchiveScrollTargets.box(this),clip:ArchiveScrollTargets.visibleArea(this)};
          }`
        }));
      }
      function intersection(a,b){
        const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);
        return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};
      }
      async function geometry(node){
        let x=0,y=0,clip={x:0,y:0,width:viewport.width,height:viewport.height};
        const boxes=[];
        for(const owner of node.chain){
          const rect=await ownerBox(owner);
          if(!rect)throw new Error('内嵌正文已隐藏，已暂停。');
          clip=intersection(clip,{...rect.clip,x:rect.clip.x+x,y:rect.clip.y+y});
          x+=rect.box.x;y+=rect.box.y;boxes.push(rect);
        }
        return {x,y,clip,boxes};
      }
      async function visit(parent,chain=[]){
        for(const node of frames.values()){
          if(node.parentId!==parent.id||!allowed(node.url))continue;
          try{
            const handle=await command(parent.session,'DOM.getFrameOwner',{frameId:node.id});
            const object=await command(parent.session,'DOM.resolveNode',{backendNodeId:handle.backendNodeId,executionContextId:parent.context});
            const owner={parent,objectId:object.object.objectId,attribute:'data-fps-frame-'+crypto.randomUUID()};owners.push(owner);
            node.chain=[...chain,owner];
            const geom=await geometry(node);
            if(geom.clip.width<160||geom.clip.height<100||geom.clip.width*geom.clip.height<viewport.width*viewport.height*.25)continue;
            await initialize(node);
            const targets=await invoke(node,'scrollTargets');
            if(targets.documentScrollable||targets.internal)candidates.push({node,score:geom.clip.width*geom.clip.height});
            await visit(node,node.chain);
          }catch(e){errors.push(e.message);}
        }
      }
      await visit(top);
      // Prefer a descendant when an outer scrolling shell wraps the same view.
      const choices=candidates.filter(a=>!candidates.some(b=>b!==a&&b.node.chain.some(o=>o.parent.id===a.node.id)&&b.score>=a.score*.85)).sort((a,b)=>b.score-a.score);
      if(!choices.length)throw new Error('未找到可采集的内嵌滚动正文。浏览器内置 PDF、受保护的预览器或自绘滚动区域可能不支持。'+(errors.length?' '+errors[0]:''));
      if(choices.length>1&&choices[1].score>choices[0].score*.75)throw new Error('发现多个相近大小的内嵌正文，无法确定要采集哪一个；请在新标签页打开所需正文。');
      const node=choices[0].node;
      const identity={frameId:node.id,url:node.info.url,token:node.info.token};
      async function verify(){
        for(const entry of [top,...node.chain.map(o=>o.parent).filter(p=>!p.top),node]){
          let info;try{info=await invoke(entry,'info');}catch{throw changed();}
          if(info.token!==entry.info.token||info.url!==entry.info.url)throw changed();
          if(['width','height','dpr'].some(k=>info.viewport[k]!==entry.info.viewport[k]))throw new Error('内嵌正文或窗口尺寸已改变，已暂停；请恢复原尺寸或从顶部创建新任务。');
        }
      }
      return {
        identity,close:cleanup,
        async prepare(options,previous){
          if(previous&&Object.keys(identity).some(key=>identity[key]!==previous[key]))throw changed();
          await verify();
          for(const owner of node.chain){
            await command(owner.parent.session,'Runtime.callFunctionOn',{objectId:owner.objectId,functionDeclaration:'function(attribute){this.setAttribute(attribute, "");}',arguments:[{value:owner.attribute}]});
            prepared.push(owner.parent);
            if(owner.parent.top)await topPage('frameShell',{...options,attribute:owner.attribute});
            else await invoke(owner.parent,'frameShell',{...options,attribute:owner.attribute});
          }
          prepared.push(node);await invoke(node,'prepare',options);
          return {viewport,selection:'内嵌正文'};
        },
        async call(action,arg){
          await verify();
          let hidden=0;const revisions=[];
          for(const owner of node.chain){
            const state=owner.parent.top?await topPage('shellCheck'):await invoke(owner.parent,'shellCheck');
            hidden+=state.hiddenOverlays;revisions.push(state.revision);
          }
          if(action==='move')return invoke(node,action,arg);
          if(action!=='inspect')throw new Error('未知内嵌采集操作。');
          const snapshot=await invoke(node,'inspect'),geom=await geometry(node);
          const globalArea={...snapshot.area,x:snapshot.area.x+geom.x,y:snapshot.area.y+geom.y};
          const clipped=intersection(globalArea,geom.clip);
          if(Math.abs(clipped.width-globalArea.width)>1||Math.abs(clipped.height-globalArea.height)>1)throw new Error('内嵌正文被外层页面裁切，无法完整拼接；请调整窗口或在新标签页打开正文。');
          snapshot.area=globalArea;snapshot.viewport=viewport;snapshot.hiddenOverlays+=hidden;
          const translate=r=>r&&({...r,x:r.x+geom.x,y:r.y+geom.y});
          snapshot.anchors=snapshot.anchors.map(translate);
          snapshot.notes=snapshot.notes.map(n=>({...n,area:translate(n.area),cover:translate(n.cover)}));
          snapshot.contentSignature=JSON.stringify([snapshot.contentSignature,identity,geom.boxes]);
          snapshot.signature=JSON.stringify([snapshot.signature,snapshot.contentSignature,revisions]);
          return snapshot;
        }
      };
    }catch(e){await cleanup();throw e;}
  }
  return {open};
})();
