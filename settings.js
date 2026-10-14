const $=id=>document.getElementById(id);let directory=null;
function busy(value){for(const id of ['chooseDirectory','authorizeDirectory','resetDirectory'])$(id).disabled=value;}
async function refresh(){
  directory=await ArchiveOutput.getDirectory();
  $('destination').textContent=await ArchiveOutput.description();
  $('authorizeDirectory').hidden=!directory||await directory.queryPermission({mode:'readwrite'})==='granted';
}
function report(e){$('status').textContent=e.name==='AbortError'?'已取消，保存位置未改变。':e.message;}
$('chooseDirectory').onclick=async()=>{
  busy(true);
  try{
    if(!window.showDirectoryPicker)throw new Error('此浏览器不支持选择文件夹，请使用新版 Chrome。');
    const selected=await window.showDirectoryPicker({id:'fullpage-shot-output',mode:'readwrite'});
    if(await selected.queryPermission({mode:'readwrite'})!=='granted')throw new Error('未获得文件夹写入权限，保存位置未改变。');
    await ArchiveOutput.setDirectory(selected);await refresh();$('status').textContent='已保存设置，之后的截图和导出都使用此文件夹。';
  }catch(e){report(e);}finally{busy(false);}
};
$('authorizeDirectory').onclick=async()=>{
  busy(true);
  try{
    if(!directory||await directory.requestPermission({mode:'readwrite'})!=='granted')throw new Error('未获得写入权限，保存位置未改变。');
    await refresh();$('status').textContent='已恢复授权，可以继续保存。';
  }catch(e){report(e);}finally{busy(false);}
};
$('resetDirectory').onclick=async()=>{busy(true);try{await ArchiveOutput.setDirectory(null);await refresh();$('status').textContent='已恢复默认：Chrome 下载位置 / 网页归档。';}catch(e){report(e);}finally{busy(false);}};
window.addEventListener('focus',()=>{if(!$('chooseDirectory').disabled)refresh().catch(report);});
busy(true);refresh().catch(report).finally(()=>busy(false));
