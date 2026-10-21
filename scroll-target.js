// Discover native scroll containers, including overflow:hidden app/table bodies.
// Selection is geometric and semantic, never tied to a site's names or classes.
(function(){
  'use strict';
  const documentRoot=()=>document.scrollingElement||document.documentElement;
  const parent=e=>e.parentElement||e.getRootNode()?.host||null;
  const contains=(a,b)=>{for(let p=b;p;p=parent(p))if(p===a)return true;return false;};
  function elements(){
    const output=[],trees=[document];
    for(let i=0;i<trees.length;i++)for(const e of trees[i].querySelectorAll('*')){output.push(e);if(e.shadowRoot)trees.push(e.shadowRoot);}
    return output;
  }
  function box(e){
    if(e===documentRoot())return {x:0,y:0,width:innerWidth,height:innerHeight};
    const r=e.getBoundingClientRect();return {x:r.left+e.clientLeft,y:r.top+e.clientTop,width:e.clientWidth,height:e.clientHeight};
  }
  function visibleArea(e){
    const r=box(e);let left=Math.max(0,r.x),top=Math.max(0,r.y),right=Math.min(innerWidth,r.x+r.width),bottom=Math.min(innerHeight,r.y+r.height);
    for(let p=parent(e);p&&p!==document.documentElement;p=parent(p)){
      const s=getComputedStyle(p),a=box(p);
      if(/auto|scroll|hidden|clip|overlay/.test(s.overflowX)){left=Math.max(left,a.x);right=Math.min(right,a.x+a.width);}
      if(/auto|scroll|hidden|clip|overlay/.test(s.overflowY)){top=Math.max(top,a.y);bottom=Math.min(bottom,a.y+a.height);}
    }
    return {x:left,y:top,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
  }
  function eligible(e,manual=false){
    if(e===documentRoot()||e===document.body)return false;
    const s=getComputedStyle(e),a=visibleArea(e);
    if(!/auto|scroll|hidden|overlay/.test(s.overflowY)||e.scrollHeight<=e.clientHeight+5||a.height<100||a.width<80)return false;
    if(e.checkVisibility&&!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;
    if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;
    if(!manual){
      if(a.width<160||a.width*a.height<innerWidth*innerHeight*.06)return false;
      for(let p=e;p;p=parent(p))if(p.matches('nav,aside,[role="navigation"],[role="menu"],[role="listbox"],textarea,select'))return false;
    }
    return true;
  }
  function candidates(){
    return elements().filter(e=>eligible(e)).map(e=>{
      const a=visibleArea(e);let main=false;
      for(let p=e;p;p=parent(p))if(p.matches('main,article,[role="main"],[role="grid"],[role="table"]')){main=true;break;}
      return {element:e,area:a,score:a.width*a.height*(main?1.2:1)};
    }).sort((a,b)=>b.score-a.score);
  }
  function documentScrollable(){return documentRoot().scrollHeight>innerHeight+5&&!/hidden|clip/.test(getComputedStyle(documentRoot()).overflowY)&&!document.body?.matches('[inert]')&&!/hidden|clip/.test(getComputedStyle(document.body).overflowY);}
  function resolve(){
    const doc=documentRoot();
    if(documentScrollable())return {element:doc,automatic:false};
    const choices=candidates();
    // A same-size clipping shell and its scrolling child describe one region.
    const distinct=choices.filter(a=>!choices.some(b=>a!==b&&contains(a.element,b.element)&&b.score>=a.score*.85));
    if(distinct.length>1&&distinct[1].score>distinct[0].score*.75)throw new Error('发现多个相近大小的滚动区域，请点击“选择滚动区域”，再点正文列表。');
    if(distinct.length)return {element:distinct[0].element,automatic:true};
    if(embedded()&&doc.scrollHeight<=innerHeight+5)throw new Error('正文位于内嵌页面，需要连接浏览器调试截图后识别其滚动区域；前台兼容截图暂不支持此类正文。');
    return {element:doc,automatic:false};
  }
  function closest(e){for(let p=e;p;p=parent(p))if(eligible(p,true))return p;return documentRoot();}
  function embedded(){return elements().some(e=>{if(e.tagName!=='IFRAME')return false;const a=visibleArea(e);return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&a.width*a.height>innerWidth*innerHeight*.25;});}
  globalThis.ArchiveScrollTargets={documentRoot,documentScrollable,parent,box,visibleArea,eligible,candidates,resolve,closest,elements,embedded};
})();
