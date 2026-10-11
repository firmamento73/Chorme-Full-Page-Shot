// Pixel registration of overlapping browser frames, independent of DOM IDs.
(function(root){
  'use strict';
  function compare(a,b,cut,band,dense=false){
    const width=a.width,dx=dense?1:Math.max(1,Math.floor(width/96)),dy=dense?1:2;
    let error=0,bad=0,n=0,changes=0,rows=0;
    const quarters=[0,0,0,0],counts=[0,0,0,0];
    for(let y=0;y<band;y+=dy){
      let varied=false;
      for(let x=0;x<width;x+=dx){
        const ai=((a.height-band+y)*width+x)*4,bi=((cut-band+y)*width+x)*4;
        let delta=0;for(let c=0;c<4;c++)delta=Math.max(delta,Math.abs(a.data[ai+c]-b.data[bi+c]));
        const q=Math.min(3,Math.floor(x*4/width));counts[q]++;n++;
        error+=delta;if(delta>16){bad++;quarters[q]++;}
        if(y>=dy){const pi=ai-width*dy*4;let d=0;for(let c=0;c<3;c++)d+=Math.abs(a.data[ai+c]-a.data[pi+c]);if(d>18){changes++;varied=true;}}
      }
      if(varied)rows++;
    }
    return {cut,error:error/n,bad:bad/n,informative:changes>=12&&rows>=4,
      valid:error/n<=2&&bad/n<=.012&&quarters.every((v,i)=>!counts[i]||v/counts[i]<=.025)};
  }
  function match(a,b,{expected,geometry=false,samePosition=false}={}){
    if(!a||!b||a.width!==b.width)return {join:false,reason:'缺少上段像素或宽度变化'};
    expected=Math.round(expected);
    if(samePosition){
      if(a.height!==b.height)return {join:false,reason:'同位置完整像素参照缺失'};
      // Do not discard a changed middle area just because the bottom still matches.
      let first=-1;for(let i=0;i<a.data.length;i++)if(a.data[i]!==b.data[i]){first=i;break;}
      if(first>=0){const prefix=Math.floor(first/(a.width*4));
        if(prefix>=32)return {join:true,skip:prefix,trim:a.height-prefix,method:'pixels',error:0};
        return {join:false,reason:'同位置内容已改变，缺少未变化的连接区'};
      }
      return {join:true,skip:b.height,method:'pixels',error:0};
    }
    if(expected<16||expected>b.height)return {join:false,reason:'可用重叠太小或滚动回退'};
    const band=Math.min(160,a.height,expected);
    if(band<16)return {join:false,reason:'重叠参照太短'};
    const verify=(cut,allowFlat=false)=>{
      if(cut<band||cut>b.height)return null;
      const sample=compare(a,b,cut,band);
      if(!sample.valid||(!allowFlat&&!sample.informative))return null;
      const dense=compare(a,b,cut,band,true);
      return dense.valid?dense:null;
    };
    const exact=verify(expected,geometry);
    if(exact)return {join:true,skip:expected,trim:0,method:'pixels',error:exact.error};
    // Lazy/infinite pages can repaint the previous frame's bottom. Connect in
    // an unchanged overlap band, replacing that old tail with the current one.
    for(let trim=8;trim<=Math.min(expected-32,a.height-32,320);trim+=8){
      const cut=expected-trim,h=Math.min(96,cut,a.height-trim);
      const shortened={...a,width:a.width,height:a.height-trim,data:a.data};
      const sample=compare(shortened,b,cut,h);
      if(sample.valid&&(geometry||sample.informative)){
        const dense=compare(shortened,b,cut,h,true);
        if(dense.valid)return {join:true,skip:cut,trim,method:'pixels',error:dense.error};
      }
    }
    const candidates=[];
    // First consider raster rounding; then content movement caused by layout changes.
    const cuts=new Set();for(let d=-4;d<=4;d++)cuts.add(expected+d);
    for(let cut=band;cut<b.height;cut++)cuts.add(cut);
    for(const cut of cuts){const result=verify(cut);if(result)candidates.push(result);}
    if(!candidates.length)return {join:false,reason:'重叠像素未匹配'};
    candidates.sort((a,b)=>a.error-b.error||Math.abs(a.cut-expected)-Math.abs(b.cut-expected));
    let best=candidates[0];
    // Broadly repeated textures cannot establish a unique displacement.
    if(candidates.some(c=>Math.abs(c.cut-best.cut)>8&&c.error<=best.error+.2))return {join:false,reason:'重复纹理无法确定唯一接缝'};
    for(let d=-1;d<=1;d++){const c=verify(best.cut+d);if(c&&c.error<best.error)best=c;}
    return {join:true,skip:best.cut,method:'pixels',error:best.error};
  }
  root.ArchiveSeams={match};if(typeof module!=='undefined')module.exports=root.ArchiveSeams;
})(globalThis);
