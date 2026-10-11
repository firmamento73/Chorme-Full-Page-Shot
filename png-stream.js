// PNG scanlines are compressed in blocks; no full-height browser canvas.
(function(root){
  'use strict';
  const table=new Uint32Array(256);
  for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c;}
  function chunk(type,data){
    const out=new Uint8Array(data.length+12),view=new DataView(out.buffer);
    view.setUint32(0,data.length);out.set(new TextEncoder().encode(type),4);out.set(data,8);
    let crc=0xffffffff;for(let i=4;i<out.length-4;i++)crc=table[(crc^out[i])&255]^(crc>>>8);
    view.setUint32(out.length-4,(crc^0xffffffff)>>>0);return out;
  }
  root.ArchivePNG=async function(width,height,produce,progress){
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>0x7fffffff||height>0x7fffffff)throw new Error('长图尺寸超出 PNG 范围。');
    const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=6;
    const chunks=[new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header)];
    const stream=new CompressionStream('deflate'),writer=stream.writable.getWriter(),reader=stream.readable.getReader();
    let rows=0;
    const pumping=(async()=>{for(;;){const result=await reader.read();if(result.done)break;chunks.push(chunk('IDAT',result.value));}})();
    // Attach a rejection handler immediately, including when the producer fails.
    pumping.catch(()=>{});
    try {
      await produce(async(canvas)=>{
        if(canvas.width!==width)throw new Error('长图宽度发生变化。');
        const ctx=canvas.getContext('2d');
        for(let y=0;y<canvas.height;y+=32){
          const count=Math.min(32,canvas.height-y),data=ctx.getImageData(0,y,width,count).data,stride=width*4,block=new Uint8Array((stride+1)*count);
          for(let r=0;r<count;r++)block.set(data.subarray(r*stride,(r+1)*stride),r*(stride+1)+1);
          await writer.write(block);rows+=count;
        }
        progress?.(`正在编码单张长图 ${Math.min(100,Math.round(rows/height*100))}%`);
      });
      if(rows!==height)throw new Error('长图行数不完整，未生成下载。');
      await writer.close();await pumping;chunks.push(chunk('IEND',new Uint8Array()));
      return new Blob(chunks,{type:'image/png'});
    } catch(e){await writer.abort(e).catch(()=>{});await reader.cancel(e).catch(()=>{});await pumping.catch(()=>{});throw e;}
  };
})(globalThis);
