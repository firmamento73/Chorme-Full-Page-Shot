// Reversible rendering filter. No site-specific IDs, text or network requests.
(function() {
  'use strict';
  globalThis.ArchiveOverlays=class {
    constructor(getRoot,getArea,getPosition) {
      this.getRoot=getRoot;this.getArea=getArea;this.getPosition=getPosition;
      this.attribute='data-fps-hide-'+crypto.randomUUID();
      this.inline=new Map();this.hidden=new Set();this.manual=new Set();this.styles=new Map();this.observers=new Map();
      this.manualError='';this.active=false;this.enabled=true;this.revision=0;this.frame=0;this.key=crypto.randomUUID();
    }
    parent(e){return e.parentElement || e.getRootNode()?.host || null;}
    contains(a,b){for(let p=b;p;p=this.parent(p))if(p===a)return true;return false;}
    protected(e){const root=this.getRoot();return e===document.body||e===document.documentElement||this.contains(e,root);}
    excluded(e){for(let p=e;p;p=this.parent(p))if(this.hidden.has(p))return true;return false;}
    visible(e){return !this.excluded(e)&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';}
    elements() {
      const found=[],trees=[document];
      for(let i=0;i<trees.length;i++)for(const e of trees[i].querySelectorAll('*')) {
        found.push(e);if(e.shadowRoot)trees.push(e.shadowRoot);
      }
      if(this.active)for(const tree of trees)this.watch(tree);
      return found;
    }
    css(){const selector=`[${this.attribute}]`;return `${selector},${selector} *{visibility:hidden!important;pointer-events:none!important}${selector}::backdrop{visibility:hidden!important}`;}
    watch(tree) {
      if(this.styles.has(tree)&&this.styles.get(tree).isConnected)return;
      const style=document.createElement('style'),selector=`[${this.attribute}]`;
      style.textContent=this.css();
      if(tree!==document)style.textContent+=`:host-context(${selector}),:host-context(${selector}) *{visibility:hidden!important;pointer-events:none!important}`;
      (tree===document?document.documentElement:tree).append(style);this.styles.set(tree,style);
      if(this.observers.has(tree))return;
      const observer=new MutationObserver(()=>{
        if(this.active&&!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;if(this.active)this.sync();});
      });
      observer.observe(tree,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','hidden','open']});
      this.observers.set(tree,observer);
    }
    floating(e,a) {
      if(this.protected(e)||this.excluded(this.parent(e)))return false;
      const s=getComputedStyle(e),r=e.getBoundingClientRect();
      if(s.display==='none'||Number(s.opacity)===0||r.width<=0||r.height<=0||r.right<=a.x||r.left>=a.x+a.width||r.bottom<=a.y||r.top>=a.y+a.height)return false;
      // A fixed application shell or selected reader must remain available.
      const large=r.width>a.width*.65&&r.height>a.height*.55;
      const content=e.matches('main,article,[role="main"]')||!!e.querySelector('main,article,[role="main"]')||(/auto|scroll/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+5);
      if(large&&content)return false;
      if(s.position==='fixed')return true;
      // Sticky headings remain in normal flow until they stick during scrolling.
      if(s.position==='sticky'&&this.getPosition()>2&&r.height<a.height*.25) {
        const top=parseFloat(s.top),bottom=parseFloat(s.bottom);
        return (Number.isFinite(top)&&Math.abs(r.top-a.y-top)<3)||(Number.isFinite(bottom)&&Math.abs(r.bottom-(a.y+a.height-bottom))<3);
      }
      // Browser top-layer popovers/dialogs may not use position:fixed.
      return e.matches(':popover-open,dialog[open]')&&!this.protected(e);
    }
    sync() {
      if(!this.active)return;
      // Re-evaluate geometry each step, including dynamically inserted/open-shadow UI.
      const elements=this.elements(),next=new Set(),a=this.getArea();
      this.manualError=[...this.manual].some(e=>!e.isConnected)?'点选排除的元素已被网页替换。请先清空点选排除，重新点选并从顶部创建新任务。':'';
      for(const e of this.manual)if(e.isConnected&&!this.protected(e))next.add(e);
      // Hidden parents already cover their children. Evaluate against the new set,
      // not the previous set, so sticky elements can return to normal flow.
      const old=this.hidden;this.hidden=next;
      if(this.enabled)for(const e of elements)if(this.floating(e,a))next.add(e);
      let changed=false;
      for(const e of old)if(!next.has(e)){e.removeAttribute(this.attribute);changed=true;}
      for(const e of next)if(!old.has(e)||!e.hasAttribute(this.attribute)){e.setAttribute(this.attribute,'');changed=true;}
      // Inline fallback also works when the site's CSP blocks style elements,
      // and inside open shadow roots with explicit visibility overrides.
      for(const [e,oldStyle] of this.inline)if(!this.excluded(e)){this.restoreInline(e,oldStyle);this.inline.delete(e);}
      for(const e of elements)if(this.excluded(e)&&getComputedStyle(e).visibility!=='hidden') {
        this.inline.set(e,{value:e.style.getPropertyValue('visibility'),priority:e.style.getPropertyPriority('visibility')});
        e.style.setProperty('visibility','hidden','important');changed=true;
      }
      if(changed)this.revision++;
    }
    check(){if(this.manualError)throw new Error(this.manualError);}
    restoreInline(e,old){if(e.style.getPropertyValue('visibility')!=='hidden'||e.style.getPropertyPriority('visibility')!=='important')return;old.value?e.style.setProperty('visibility',old.value,old.priority):e.style.removeProperty('visibility');}
    start(enabled=true){this.stop();this.enabled=enabled;this.active=true;this.sync();}
    stop() {
      this.active=false;cancelAnimationFrame(this.frame);this.frame=0;
      for(const observer of this.observers.values())observer.disconnect();this.observers.clear();
      for(const e of this.hidden)e.removeAttribute(this.attribute);this.hidden.clear();
      for(const style of this.styles.values())style.remove();this.styles.clear();
      for(const [e,oldStyle] of this.inline)this.restoreInline(e,oldStyle);this.inline.clear();
    }
    add(e){if(!e||this.protected(e))throw new Error('不能排除整个正文或所选滚动区域，请点选具体浮层。');this.manual.add(e);this.key=crypto.randomUUID();}
    clear(){this.stop();this.manual.clear();this.manualError='';this.key=crypto.randomUUID();}
    count(){return [...this.manual].filter(e=>e.isConnected).length;}
    candidate(e){
      // Prefer the nearest positioned control. An outer fixed application shell
      // may contain the entire page and must not become the exclusion target.
      for(let p=e;p&&!this.protected(p);p=this.parent(p))if(['fixed','sticky'].includes(getComputedStyle(p).position))return p;
      return e;
    }

  };
})();
