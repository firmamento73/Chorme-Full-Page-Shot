(function(root){
  'use strict';
  const C=ArchiveCore,DB=ArchiveDB;
  async function download(blob,name){
    const url=URL.createObjectURL(blob);
    try{return await chrome.downloads.download({url,filename:`网页归档/${C.outputName(name)}`,saveAs:false});}
    finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
  }
  async function render(plan){
    const canvas=document.createElement('canvas');canvas.width=plan.width;canvas.height=plan.height;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
    for(const part of plan.parts){
      const row=await DB.get('tiles',part.id);if(!row?.blob)throw new Error('截图文件缺失，请检查本地缓存。');
      const bitmap=await createImageBitmap(row.blob);
      try{ctx.drawImage(bitmap,0,part.sy,plan.width,part.height,0,part.dy,plan.width,part.height);}finally{bitmap.close();}
    }
    return canvas;
  }
  function pixels(image){const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height);}
  async function stitch(tiles,progress){
    const output=[],groups=new Map();let previous=null;
    for(const tile of tiles){
      let sy=tile.sy||0,height=tile.height;
      if(previous&&previous.strip!==tile.strip&&previous.width===tile.width){
        const scale=tile.captureScale||tile.height/(tile.end-tile.start),expected=Math.round((previous.end-tile.start)*scale);
        if(Number.isFinite(expected)&&expected>=16&&expected<=height){
          progress('正在匹配旧截图的重复区域');
          let remaining=height;const parts=[];
          for(let i=output.length-1;i>=0&&remaining;i--){const t=output[i];if(t.strip!==output.at(-1).strip)break;const h=Math.min(remaining,t.height);parts.unshift({id:t.id,sy:(t.sy||0)+t.height-h,height:h});remaining-=h;}
          let dy=0;for(const p of parts){p.dy=dy;dy+=p.height;}
          const canvas=await render({width:tile.width,height:dy,parts}),row=await DB.get('tiles',tile.id),bitmap=await createImageBitmap(row.blob);
          let seam;try{seam=ArchiveSeams.match(canvas.getContext('2d').getImageData(0,0,tile.width,dy),pixels(bitmap),{expected,samePosition:expected===height});}finally{bitmap.close();canvas.width=canvas.height=1;}
          if(seam.join){
            groups.set(tile.strip,output.at(-1).strip);sy+=seam.skip;height-=seam.skip;
            let trim=seam.trim||0;
            while(trim&&output.length){const last=output.at(-1);const amount=Math.min(trim,last.height);last.height-=amount;last.end-=amount/scale;trim-=amount;if(!last.height)output.pop();}
          }
        }
      }
      if(!groups.has(tile.strip))groups.set(tile.strip,tile.strip);
      if(height)output.push({...tile,sy,height,strip:groups.get(tile.strip)});
      previous=tile;
    }
    return output;
  }
  function toBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('图片编码失败，请尝试更小的分段。')),'image/png'));}
  const stamp=job=>`${C.filename(job.title).slice(0,55)}_${job.id.slice(0,8)}`;
  async function png(job,tiles,progress,options={}){
    if(options.mode==='single') {
      tiles=await stitch(tiles,progress);
      const whole=C.continuous(tiles,options.allowIndependent===true);
      const blocks=C.slices(tiles,3000,8000000);
      const blob=await ArchivePNG(whole.width,whole.height,async write=>{
        for(const plan of blocks){const canvas=await render(plan);try{await write(canvas);}finally{canvas.width=canvas.height=1;}}
      },progress);
      await download(blob,`${stamp(job)}_连续长图.png`);return 1;
    }
    const plans=C.slices(tiles);
    for(let i=0;i<plans.length;i++){
      progress(`正在导出长图 ${i+1}/${plans.length}`);const canvas=await render(plans[i]);
      await download(await toBlob(canvas),`${stamp(job)}_${String(i+1).padStart(3,'0')}.png`);canvas.width=canvas.height=1;
    }
    return plans.length;
  }
  async function pdf(job,tiles,progress,options={}){
    if(options.mode==='continuous') {
      tiles=await stitch(tiles,progress);
      const whole=C.continuous(tiles,options.allowIndependent===true);
      const doc=await PDFLib.PDFDocument.create();doc.setTitle(job.title);doc.setCreator('Full Page Shot 2.2.1');doc.setSubject(`来源：${job.url}\n状态：${job.reason}`);
      const scale=Math.min(595.28/whole.width,14000/whole.height),page=doc.addPage([whole.width*scale,whole.height*scale]);
      let y=whole.height;
      for(let i=0;i<tiles.length;i++){
        progress(`正在生成单页长 PDF ${i+1}/${tiles.length}`);
        const row=await DB.get('tiles',tiles[i].id);if(!row?.blob)throw new Error('截图文件缺失。');
        let blob=row.blob;
        if(tiles[i].sy||tiles[i].height!==row.height){const canvas=await render({width:whole.width,height:tiles[i].height,parts:[{id:tiles[i].id,sy:tiles[i].sy||0,dy:0,height:tiles[i].height}]});try{blob=await toBlob(canvas);}finally{canvas.width=canvas.height=1;}}
        const image=await doc.embedPng(await blob.arrayBuffer());y-=tiles[i].height;
        page.drawImage(image,{x:0,y:y*scale,width:whole.width*scale,height:tiles[i].height*scale});
      }
      await download(new Blob([await doc.save()],{type:'application/pdf'}),`${stamp(job)}_连续.pdf`);return 1;
    }
    const width=tiles[0]?.width||1200,height=Math.max(1,Math.floor(width*841.89/595.28));
    const plans=C.slices(tiles,height,12000000);let pdf=null,pixels=0,pages=0,volume=0;
    async function finish(){if(!pdf)return;await download(new Blob([await pdf.save()],{type:'application/pdf'}),`${stamp(job)}_${String(++volume).padStart(2,'0')}.pdf`);pdf=null;pixels=pages=0;}
    for(let i=0;i<plans.length;i++){
      const plan=plans[i],size=plan.width*plan.height;
      if(pdf&&(pixels+size>48000000||pages>=12))await finish();
      if(!pdf){pdf=await PDFLib.PDFDocument.create();pdf.setTitle(job.title);pdf.setSubject(`来源：${job.url}\n状态：${job.reason}`);pdf.setCreator('Full Page Shot 2.2.1');}
      progress(`正在生成 PDF ${i+1}/${plans.length}`);
      const canvas=await render(plan),blob=await toBlob(canvas),image=await pdf.embedPng(await blob.arrayBuffer());
      const pageWidth=595.28,pageHeight=841.89,imageHeight=pageWidth*plan.height/plan.width;
      const p=pdf.addPage([pageWidth,pageHeight]);p.drawImage(image,{x:0,y:pageHeight-imageHeight,width:pageWidth,height:imageHeight});pixels+=size;pages++;canvas.width=canvas.height=1;
    }
    await finish();return volume;
  }
  const dataUrl=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
  async function html(job,items,progress){
    const chunks=[],e=C.escape;
    chunks.push(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${e(job.title)}</title><style>body{font:15px/1.6 system-ui;background:#f4f7f4;color:#18332e;margin:24px}main{max-width:1200px;margin:auto}input{font:inherit;padding:12px;width:min(90%,500px)}section{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px;margin:24px 0}article{background:white;padding:12px;border-radius:10px}img{width:100%;height:250px;object-fit:contain}a{color:#176d60}p{overflow-wrap:anywhere}[hidden]{display:none}</style></head><body><main><h1>${e(job.title)}</h1><p>保存于 ${e(job.created)} · ${items.length} 条笔记</p><p>${e(job.reason)}</p><p>缺少封面：${items.filter(i=>!i.hasImage).length} 条。封面为采集时截图，不包含笔记全文或视频。</p><input id="search" placeholder="搜索标题或作者" aria-label="搜索标题或作者"><p id="count"></p><section>`);
    for(let i=0;i<items.length;i++){
      const item=items[i];progress(`正在导出收藏 ${i+1}/${items.length}`);
      const row=item.hasImage?await DB.get('items',item.id):null;
      const img=row?.blob?`<img loading="lazy" src="${await dataUrl(row.blob)}" alt="${e(item.title)}">`:'<p>封面未完整加载</p>';
      const url=C.safeLink(item.url);
      chunks.push(`<article data-search="${e((item.title+' '+item.author).toLocaleLowerCase())}">${img}<p>${e(item.title||'无标题')}</p><p>${e(item.author)}</p>${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">打开原笔记</a>`:''}</article>`);
    }
    chunks.push(`</section></main><script>const q=document.getElementById('search'),cards=[...document.querySelectorAll('article')];function filter(){let n=0;for(const c of cards){c.hidden=!c.dataset.search.includes(q.value.toLocaleLowerCase());if(!c.hidden)n++;}document.getElementById('count').textContent=n+' 条';}q.addEventListener('input',filter);filter();</script></body></html>`);
    await download(new Blob(chunks,{type:'text/html;charset=utf-8'}),`${stamp(job)}_收藏总览.html`);return 1;
  }
  root.ArchiveExport={download,png,pdf,html,stitch};
})(globalThis);
