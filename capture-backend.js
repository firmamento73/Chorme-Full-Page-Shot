// Browser-authorized viewport capture when the debugger cannot attach.
// captureVisibleTab targets a window's active tab, so validate identity and
// activation/navigation revisions before and after every capture.
(function(){
  const windows=new Map(),tabs=new Map();let queue=Promise.resolve(),nextCapture=0;
  const bump=(map,id)=>map.set(id,(map.get(id)||0)+1);
  chrome.tabs.onActivated?.addListener(info=>bump(windows,info.windowId));
  chrome.tabs.onUpdated?.addListener((id,change)=>{if(change.url||change.status==='loading')bump(tabs,id);});
  chrome.tabs.onRemoved?.addListener(id=>bump(tabs,id));
  chrome.tabs.onDetached?.addListener((id,info)=>{bump(tabs,id);bump(windows,info.oldWindowId);});
  chrome.tabs.onAttached?.addListener((id,info)=>{bump(tabs,id);bump(windows,info.newWindowId);});
  function restricted(error){return /Cannot access a chrome-extension:\/\/ URL of different extension|another debugger is already attached/i.test(error?.message||String(error));}
  function connectionError(error){
    const raw=error?.message||String(error);
    return new Error(restricted(error)?'Chrome 拒绝调试连接，页面可能包含其他扩展的嵌入内容或已有调试连接。请使用前台兼容截图。':'无法连接浏览器截图：'+raw+'。可尝试勾选“前台兼容截图”。');
  }
  async function active(job,state){
    await check(job,state);
    const tab=await chrome.tabs.get(job.tabId),win=await chrome.windows.get(tab.windowId);
    if(!tab.active||win.state==='minimized')throw new Error('前台兼容截图已暂停：请保持原标签页可见，不能切页或最小化。');
    if(tab.url!==job.url||tab.status==='loading')throw new Error('原页面正在跳转或重新加载，当前截图已丢弃。');
    return tab;
  }
  async function visible(job,state){
    const operation=queue.then(async()=>{
      await sleep(Math.max(0,nextCapture-Date.now()));
      const tab=await active(job,state),windowRevision=windows.get(tab.windowId)||0,tabRevision=tabs.get(tab.id)||0;
      await active(job,state);
      if((windows.get(tab.windowId)||0)!==windowRevision||(tabs.get(tab.id)||0)!==tabRevision)throw new Error('截图期间活动页面发生变化，当前截图已丢弃。');
      nextCapture=Date.now()+600;
      const url=await bounded('前台兼容截图',()=>chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'}),20000);
      const after=await active(job,state);
      if(after.windowId!==tab.windowId||(windows.get(tab.windowId)||0)!==windowRevision||(tabs.get(tab.id)||0)!==tabRevision)throw new Error('截图期间活动页面发生变化，当前截图已丢弃。');
      if(typeof url!=='string'||!url.startsWith('data:image/png;base64,'))throw new Error('浏览器未返回有效的前台截图。');
      return {data:url.slice('data:image/png;base64,'.length)};
    });
    queue=operation.catch(()=>{});return operation;
  }
  globalThis.ArchiveCapture={restricted,connectionError,visible};
})();
