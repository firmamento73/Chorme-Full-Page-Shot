(function(root) {
  'use strict';
  const Core = {
    supported(url) { return /^(https?|file):/i.test(url || ''); },
    filename(value) { return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || '网页'; },
    outputName(value) {
      const match=String(value).match(/(\.[a-z0-9]{1,8})$/i),extension=match?match[1]:'';
      const stem=extension?String(value).slice(0,-extension.length):String(value);
      return this.filename(stem)+extension;
    },
    identity(url) { return new URL(url).href; },
    near(a,b,tolerance=1) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=tolerance; },
    sameView(a,b) {
      return a && b && a.signature===b.signature && a.ready===b.ready && a.pendingImages===b.pendingImages && a.skeletons===b.skeletons && a.viewport.width===b.viewport.width && a.viewport.height===b.viewport.height && a.viewport.dpr===b.viewport.dpr &&
        ['x','y','width','height'].every(k=>this.near(a.area[k],b.area[k],0.5)) && this.near(a.position,b.position,0.5);
    },
    sameContent(a,b){return a&&b&&a.contentSignature&&a.contentSignature===b.contentSignature&&a.ready===b.ready&&a.viewport.width===b.viewport.width&&a.viewport.height===b.viewport.height&&a.viewport.dpr===b.viewport.dpr;},
    seam(previous,current) {
      if(!previous) return {join:false,reason:'first'};
      if(!this.near(previous.area.width,current.area.width,0.5) || previous.viewport.dpr!==current.viewport.dpr || (previous.captureScale && current.captureScale && !this.near(previous.captureScale,current.captureScale,0.001))) return {join:false,reason:'尺寸变化'};
      const delta=current.position-previous.position;
      if(delta<=0 || current.start>=previous.end-2) return {join:false,reason:'没有可验证的重叠区域'};
      const matches=[];
      for(const a of current.anchors) {
        const b=previous.anchors.find(p=>p.key===a.key);
        if(b) matches.push({a,b});
      }
      if(matches.length<2) return {join:false,reason:'重叠区域缺少定位参照'};
      if(matches.some(({a,b})=>!this.near(a.y,b.y-delta,1.5) || !this.near(a.x,b.x,1.5) || !this.near(a.height,b.height,1.5))) return {join:false,reason:'内容重排或虚拟列表位置变化'};
      return {join:true,reason:''};
    },
    pngBlob(base64) {
      const binary=atob(base64),bytes=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
      if(![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) throw new Error('浏览器返回了无效截图。');
      return new Blob([bytes],{type:'image/png'});
    },
    escape(value) { return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
    safeLink(value) { try { const u=new URL(value);return /^https?:$/.test(u.protocol)?u.href:''; } catch {return '';} },
    continuous(tiles,allowIndependent=false) {
      if(!tiles.length)throw new Error('没有已保存的截图。');
      const width=tiles[0].width;
      if(tiles.some(t=>t.width!==width))throw new Error('截图宽度不同，无法无缝合成，请使用分段输出。');
      if(!allowIndependent&&new Set(tiles.map(t=>t.strip)).size>1)throw new Error('存在未确认的接缝或多次重扫。请选择分段输出，或勾选强制顺序连接；后者可能保留重复内容。');
      return {width,height:tiles.reduce((n,t)=>n+t.height,0),parts:tiles.map(t=>({id:t.id,sy:t.sy||0,height:t.height})),strip:0};
    },
    slices(tiles,maxHeight=10000,maxPixels=24000000) {
      const pages=[]; let page=null;
      for(const tile of tiles) {
        const limit=Math.max(1,Math.min(maxHeight,Math.floor(maxPixels/tile.width)));
        let offset=0;
        while(offset<tile.height) {
          if(!page || page.width!==tile.width || page.strip!==tile.strip || page.height>=limit) {
            page={width:tile.width,height:0,strip:tile.strip,parts:[]}; pages.push(page);
          }
          const height=Math.min(tile.height-offset,limit-page.height);
          page.parts.push({id:tile.id,sy:(tile.sy||0)+offset,dy:page.height,height});page.height+=height;offset+=height;
        }
      }
      return pages;
    }
  };
  root.ArchiveCore=Core;
  if(typeof module!=='undefined') module.exports=Core;
})(globalThis);
