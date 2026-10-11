(function(root) {
  'use strict';
  let opening;
  function open() {
    return opening ||= new Promise((resolve,reject)=>{
      const request=indexedDB.open('fullpage-shot-archive',2);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('jobs'))db.createObjectStore('jobs',{keyPath:'id'});
        for(const name of ['tiles','items','frames'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'}).createIndex('jobId','jobId');
      };
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
  }
  async function transaction(stores,mode,action) {
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(stores,mode);let result;
      try {result=action(tx);} catch(e) {tx.abort();reject(e);return;}
      tx.oncomplete=()=>resolve(typeof result==='function'?result():result);
      tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('本地保存中断。'));
    });
  }
  const DB={
    get(store,id) {return transaction([store],'readonly',tx=>{const r=tx.objectStore(store).get(id);return ()=>r.result;});},
    put(store,row) {return transaction([store],'readwrite',tx=>{tx.objectStore(store).put(row);});},
    jobs() {return transaction(['jobs'],'readonly',tx=>{const r=tx.objectStore('jobs').getAll();return ()=>r.result;});},
    list(store,jobId) {return transaction([store],'readonly',tx=>{
      const rows=[],r=tx.objectStore(store).index('jobId').openCursor(IDBKeyRange.only(jobId));
      r.onsuccess=()=>{const c=r.result;if(!c)return;const {blob,...row}=c.value;rows.push(row);c.continue();};return ()=>rows;
    });},
    commit(job,tile,items,frame,edits={}) {return transaction(['jobs','tiles','items','frames'],'readwrite',tx=>{
      tx.objectStore('jobs').put(job);
      for(const id of edits.remove||[])tx.objectStore('tiles').delete(id);
      for(const row of edits.replace||[])tx.objectStore('tiles').put(row);
      if(frame)tx.objectStore('frames').put(frame);
      if(tile)tx.objectStore('tiles').put(tile);
      for(const item of items)tx.objectStore('items').put(item);
    });},
    remove(jobId) {return transaction(['jobs','tiles','items','frames'],'readwrite',tx=>{
      tx.objectStore('jobs').delete(jobId);
      for(const name of ['tiles','items','frames']) {
        const r=tx.objectStore(name).index('jobId').openCursor(IDBKeyRange.only(jobId));
        r.onsuccess=()=>{const c=r.result;if(c){c.delete();c.continue();}};
      }
    });}
  };
  root.ArchiveDB=DB;
})(globalThis);
