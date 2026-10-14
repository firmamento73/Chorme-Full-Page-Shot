// One destination shared by F12 screenshots and every archive export.
(function(root){
  const database='fullpage-shot-output';let lastSaved=null;
  async function setting(write,value){
    const db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open(database,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('settings');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction('settings',write?'readwrite':'readonly'),store=tx.objectStore('settings');
      const request=write?(value?store.put(value,'directory'):store.delete('directory')):store.get('directory');
      tx.oncomplete=()=>resolve(write?value:request.result||null);
      tx.onabort=()=>reject(tx.error||new Error('无法保存目录设置。'));
      tx.onerror=()=>reject(tx.error);
    });}finally{db.close();}
  }
  const getDirectory=()=>setting(false);
  const setDirectory=directory=>setting(true,directory);
  async function description(){const directory=await getDirectory();return directory?`自选文件夹：${directory.name}`:'默认：Chrome 下载位置 / 网页归档';}
  async function availableName(directory,name){
    const dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,extension=dot>0?name.slice(dot):'';
    for(let i=0;i<10000;i++){
      const candidate=i?`${stem} (${i})${extension}`:name;
      try{await directory.getFileHandle(candidate);}
      catch(e){if(e.name==='NotFoundError')return candidate;if(e.name!=='TypeMismatchError')throw e;}
    }
    throw new Error('同名文件过多，请选择另一个保存目录。');
  }
  async function save(blob,name,{dataUrl}={}){
    name=ArchiveCore.outputName(name);
    const directory=await getDirectory();
    if(directory){
      return navigator.locks.request('fullpage-shot-output-save',async()=>{
        try{
          if(await directory.queryPermission({mode:'readwrite'})!=='granted')throw new Error('所选文件夹需要重新授权。请打开“保存位置”，点击“重新授权”，然后重试。');
          const filename=await availableName(directory,name),file=await directory.getFileHandle(filename,{create:true});
          const stream=await file.createWritable();
          try{await stream.write(blob);await stream.close();}catch(e){await stream.abort().catch(()=>{});throw e;}
          return lastSaved={filename:`${directory.name}/${filename}`,destination:'directory'};
        }catch(e){throw new Error(`未能保存到所选文件夹“${directory.name}”：${e.message}。未改存到下载目录。`);}
      });
    }
    const url=dataUrl||URL.createObjectURL(blob),filename=`网页归档/${name}`;
    try{return lastSaved={filename,destination:'downloads',downloadId:await chrome.downloads.download({url,filename,saveAs:false,conflictAction:'uniquify'})};}
    finally{if(!dataUrl)setTimeout(()=>URL.revokeObjectURL(url),60000);}
  }
  function completion(count){return lastSaved?.destination==='directory'?`已保存到所选文件夹：${count} 个文件。`:`已交给 Chrome 下载：${count} 个文件。请在下载列表确认完成。`;}
  root.ArchiveOutput={getDirectory,setDirectory,description,save,completion};
})(globalThis);
