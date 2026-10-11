// Test widgets deliberately use arbitrary labels/IDs and unusual placement.
window.makeTestOverlays=()=>{
  const add=(name,css,html='floating UI')=>{
    const e=document.createElement('div');e.id=name;e.dataset.overlayTest='';
    e.style.cssText=css+';background:rgb(250,0,250);z-index:99999';e.innerHTML=html;document.body.append(e);return e;
  };
  add('arbitrary-tool','position:fixed;right:10px;bottom:90px;width:180px;height:120px', '<button style="position:static;visibility:visible!important;background:rgb(250,0,250)">arbitrary label</button><img src="/missing-overlay-image.png" style="width:70px;height:30px">');
  add('manual-absolute','position:absolute;left:300px;top:200px;width:120px;height:80px');
  const sticky=add('sticky-tool','position:sticky;top:0;width:100%;height:25px');document.body.prepend(sticky);
  const shadow=add('shadow-widget','position:fixed;right:40px;top:320px;width:140px;height:80px','');
  shadow.attachShadow({mode:'open'}).innerHTML='<button style="visibility:visible!important;background:rgb(250,0,250);height:80px;width:140px">shadow UI</button>';
  const backdrop=document.createElement('style');backdrop.textContent='dialog::backdrop{background:rgb(250,0,250)!important}';document.head.append(backdrop);
  window.addEventListener('scroll',()=>{
    if(scrollY>100&&!document.getElementById('late-widget')) {
      add('late-widget','position:fixed;left:40px;bottom:140px;width:130px;height:100px');
      const dialog=document.createElement('dialog');dialog.id='modal-widget';dialog.dataset.overlayTest='';dialog.textContent='dialog UI';
      dialog.style.cssText='width:200px;height:100px;background:rgb(250,0,250)';document.body.append(dialog);dialog.showModal();
      const popover=add('popover-widget','position:absolute;top:220px;left:450px;width:110px;height:60px');popover.setAttribute('popover','manual');popover.showPopover();
    }
  });
};

void 0;
