// Test only: verify the stored handle can be used outside a Window context.
importScripts('../core.js','../output.js');
onmessage=async()=>{
  try{postMessage({ok:true,result:await ArchiveOutput.save(new Blob(['worker output']),'worker.txt')});}
  catch(e){postMessage({ok:false,error:e.message});}
};
