"""Real Chromium rendering + test-only extension API bridge (no installed extension).
Run: python tests/browser_test.py. Requires Playwright, Pillow and PyMuPDF.
"""
import asyncio,base64,functools,http.server,io,json,os,threading,time
from urllib.parse import quote
from pathlib import Path
from playwright.async_api import async_playwright
from PIL import Image,ImageChops
import fitz
ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/'dist'/('classic-artifacts' if os.environ.get('BROWSER_TEST_CLASSIC') else 'seam-artifacts' if os.environ.get('BROWSER_TEST_SEAMS') else 'independent-artifacts' if os.environ.get('BROWSER_TEST_INDEPENDENT') else 'overlay-artifacts' if os.environ.get('BROWSER_TEST_OVERLAYS') else 'test-artifacts')
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
async def main():
 OUTPUT.mkdir(parents=True,exist_ok=True)
 for artifact in ([] if os.environ.get('BROWSER_TEST_QUICK') or os.environ.get('BROWSER_TEST_STARTUP') or os.environ.get('BROWSER_TEST_OVERLAYS') or os.environ.get('BROWSER_TEST_INDEPENDENT') or os.environ.get('BROWSER_TEST_SEAMS') else OUTPUT.glob('*')):
  if artifact.is_file() and artifact.name not in ['startup-results.json','resume-edge-results.json','overlay-results.json']:artifact.unlink()
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
 threading.Thread(target=server.serve_forever,daemon=True).start()
 origin=f'http://127.0.0.1:{server.server_port}'
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BINARY','/usr/lib/chromium/chromium'),headless=not bool(os.environ.get('BROWSER_TEST_HEADED')),args=['--no-sandbox','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding'])
  context=await browser.new_context(viewport={'width':1200,'height':900},device_scale_factor=1.25)
  pages,sessions,next_id,download_id={},{},1,0
  flags={'active':None,'infobar':False}
  original_viewports={}
  injected_styles={}
  control=None
  async def register(page):
   nonlocal next_id
   ident=next_id;next_id+=1;pages[ident]=page
   return ident
  async def bridge(source,request):
   nonlocal download_id
   t,a=request['type'],request.get('args')
   if t=='tab':
    page=pages[a]
    active=flags['active'] if flags['active'] is not None else await page.evaluate('document.visibilityState === "visible"')
    return {'id':a,'windowId':1,'url':page.url,'title':await page.title(),'active':active}
   if t=='script':
    page=pages[a['target']['tabId']]
    if a.get('files'):
     for name in a['files']:await page.evaluate((ROOT/name).read_text())
     return [{'result':None}]
    result=await page.evaluate('({source,args})=>('+a['func']+')(...args)',{'source':a['func'],'args':a.get('args',[])})
    return [{'result':result}]
   if t=='insertCSS':
    session=sessions[a['target']['tabId']]
    await session.send('DOM.enable');await session.send('CSS.enable')
    tree=await session.send('Page.getFrameTree')
    sheet=await session.send('CSS.createStyleSheet',{'frameId':tree['frameTree']['frame']['id']})
    injected_styles[a['css']]=(session,sheet['styleSheetId'])
    await session.send('CSS.setStyleSheetText',{'styleSheetId':sheet['styleSheetId'],'text':a['css']})
    return None
   if t=='removeCSS':
    entry=injected_styles.pop(a['css'],None)
    if entry:await entry[0].send('CSS.setStyleSheetText',{'styleSheetId':entry[1],'text':''})
    return None
   if t=='attach':
    ident=a['tabId'];sessions[ident]=await context.new_cdp_session(pages[ident])
    if flags['infobar']:
     original_viewports[ident]=pages[ident].viewport_size.copy()
     await pages[ident].set_viewport_size({'width':original_viewports[ident]['width'],'height':original_viewports[ident]['height']-40})
    return None
   if t=='detach':
    ident=a['tabId'];session=sessions.pop(ident,None)
    if session:await session.detach()
    if ident in original_viewports:await pages[ident].set_viewport_size(original_viewports.pop(ident))
    return None
   if t=='command':
    result=await sessions[a['target']['tabId']].send(a['method'],a.get('params',{}))
    if a['method']=='Page.captureScreenshot' and flags.get('corruptNextSeam') and await pages[a['target']['tabId']].evaluate('scrollY>0'):
     flags['corruptNextSeam']=False;flags['corruptions']=flags.get('corruptions',0)+1
     png=Image.open(io.BytesIO(base64.b64decode(result['data']))).convert('RGB');png.paste((242,16,209),(0,0,png.width,min(620,png.height)))
     buffer=io.BytesIO();png.save(buffer,format='PNG');result['data']=base64.b64encode(buffer.getvalue()).decode()
    return result
   if t=='send':return await control.evaluate('m=>testSend(m)',a)
   if t=='query':
    if flags.get('queryTab'):
     page=pages[flags['queryTab']];return [{'id':flags['queryTab'],'url':page.url,'windowId':1,'title':await page.title()}]
    return [{'id':i,'url':page.url,'windowId':1,'title':await page.title()} for i,page in pages.items() if (not a.get('active') or await page.evaluate('document.visibilityState === "visible"'))]
   if t=='create':
    page=await context.new_page();ident=await register(page);await page.goto(a['url']);return {'id':ident}
   if t=='download':
    download_id+=1
    encoded=await source['page'].evaluate('async u=>{const b=await (await fetch(u)).arrayBuffer();let s="";for(const n of new Uint8Array(b))s+=String.fromCharCode(n);return btoa(s);}',a['url'])
    dest=OUTPUT/Path(a['filename']).name;dest.write_bytes(base64.b64decode(encoded));return download_id
   raise RuntimeError(t)
  await context.expose_binding('testChromeBridge',bridge)
  await context.add_init_script("if(['/review.html','/popup.html'].includes(location.pathname)){"+(ROOT/'tests'/'chrome-shim.js').read_text()+"}")
  control=await context.new_page();await control.goto(origin+'/tests/runner.html')
  async def send(m):
   result=await control.evaluate('m=>testSend(m)',m)
   assert result.get('ok'),result
   return result.get('value')
  async def wait_job(ident,timeout=180,tiles_at_least=None):
   start=time.monotonic()
   while time.monotonic()-start<timeout:
    job=await send({'type':'LAST','tabId':ident})
    if tiles_at_least is not None and job['tileCount']>=tiles_at_least:return job
    if tiles_at_least is None and job['status']!='running':
     # Await final cleanup as well as persisted state.
     await control.wait_for_function('id=>!tasks.has(id)',arg=job['id'])
     return job
    await asyncio.sleep(.25)
   raise AssertionError('Task timed out: '+json.dumps(job,ensure_ascii=False))
  async def fixture(mode,count=36,end='yes'):
   page=await context.new_page();ident=await register(page)
   await page.goto(f'{origin}/tests/fixture.html?mode={mode}&count={count}&end={end}')
   await page.bring_to_front();await send({'type':'INFO','tabId':ident})
   return page,ident
  async def start(ident,**options):
   return await send({'type':'START','tabId':ident,'options':{'background':False,'overview':True,'settleMs':500,'waitMs':4000,**options}})
  async def counts(job):
   return await control.evaluate('async id=>({tiles:await ArchiveDB.list("tiles",id),items:await ArchiveDB.list("items",id)})',job['id'])
  results=[]
  async def record(name,job,expected):
   data=await counts(job);assert job['status']=='complete',job['reason'];assert len(data['items'])==expected,(name,len(data['items']),expected)
   assert len({i['noteId'] for i in data['items']})==expected
   assert all(i['hasImage'] for i in data['items']),[i['noteId'] for i in data['items'] if not i['hasImage']]
   assert all(not t['incomplete'] for t in data['tiles'])
   results.append({'case':name,'status':job['status'],'tiles':len(data['tiles']),'items':len(data['items']),'strips':job['strip']+1})
   print('PASS',results[-1],flush=True)
  if os.environ.get('BROWSER_TEST_CLASSIC'):
   async def classic(ident,**options):
    await send({'type':'CLASSIC_START','tabId':ident,'options':options})
    for _ in range(240):
     status=await send({'type':'CLASSIC_STATUS','tabId':ident})
     if status['status']!='running':
      await control.wait_for_function('id=>!classicTasks.has(id)',arg=ident);return status
     await asyncio.sleep(.25)
    raise AssertionError('F12 capture did not finish')
   pixel=await context.new_page();ident=await register(pixel);await pixel.goto(origin+'/tests/pixel-fixture.html');await pixel.wait_for_function('document.querySelector("canvas")?.height===4600')
   reference=await context.new_cdp_session(pixel);metrics=await reference.send('Page.getLayoutMetrics');size=metrics['cssContentSize'];params={'format':'png','fromSurface':True,'captureBeyondViewport':True,'clip':{'x':0,'y':0,'width':size['width'],'height':size['height'],'scale':1}}
   baseline=Image.open(io.BytesIO(base64.b64decode((await reference.send('Page.captureScreenshot',params))['data']))).convert('RGB');await reference.detach()
   await pixel.evaluate('scrollTo(0,420)');await pixel.wait_for_timeout(100)
   status=await classic(ident,preload=False,hideOverlays=True);assert status['status']=='complete',status
   actual=Image.open(OUTPUT/Path(status['filename']).name).convert('RGB');assert actual.size==baseline.size,(actual.size,baseline.size);assert ImageChops.difference(actual,baseline).getbbox() is None
   assert await pixel.evaluate('scrollY')==420
   assert not sessions and await pixel.locator('[style*="visibility: hidden"]').count()==0
   results.append({'case':'F12 pixels match full-document reference; original position restored','size':actual.size,'differentPixels':0})
   lazy,lazy_id=await fixture('lazy',36);await lazy.evaluate('scrollTo(0,300)');await lazy.wait_for_timeout(100)
   status=await classic(lazy_id,preload=True,hideOverlays=True);assert status['status']=='complete',status
   assert await lazy.evaluate('[...document.images].every(i=>i.complete&&i.naturalWidth>0)')
   assert await lazy.evaluate('scrollY')==300
   assert await lazy.locator('header').evaluate('e=>getComputedStyle(e).visibility')=='visible'
   results.append({'case':'F12 preload loads 36 covers and restores floating UI and scroll position','status':status['status']})
   flags['queryTab']=lazy_id;popup=await context.new_page();await popup.goto(origin+'/popup.html');await popup.wait_for_function('!document.querySelector("#classicStart").disabled');await popup.click('#modeClassic')
   assert await popup.locator('#classicPanel').is_visible() and not await popup.locator('#scrollPanel').is_visible()
   assert await popup.locator('.brand img').evaluate('e=>e.complete&&e.naturalWidth===48')
   await popup.screenshot(path=str(OUTPUT/'popup-classic.png'));await popup.click('#modeScroll');assert await popup.locator('#scrollPanel').is_visible();await popup.close();flags.pop('queryTab')
   await pixel.evaluate('document.querySelector("canvas").style.height="20000px"')
   status=await classic(ident,preload=False);assert status['status']=='error' and '安全范围' in status['phase'],status
   assert not sessions and await pixel.evaluate('scrollY')==420
   results.append({'case':'oversized F12 capture refused explicitly; connection and styles restored'})
   # Keep another tab collecting while F12 captures this one; reject overlap on one tab.
   virtual,virtual_id=await fixture('virtual',120);job=await start(virtual_id,background=True)
   conflict=await control.evaluate('m=>testSend(m)',{'type':'CLASSIC_START','tabId':virtual_id});assert not conflict['ok'],conflict
   status=await classic(lazy_id,preload=False);assert status['status']=='complete',status
   assert any(tab_id==virtual_id for tab_id in sessions)
   await send({'type':'PAUSE','jobId':job['id']});paused=await wait_job(virtual_id);assert paused['status']=='paused'
   job=await start(lazy_id,background=True);job=await wait_job(lazy_id);await record('scroll archiving still works after F12 capture',job,36)
   results.append({'case':'F12 and scroll jobs run on separate tabs; same-tab conflict rejected'})
   (OUTPUT/'classic-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results,ensure_ascii=False,indent=2));await browser.close();server.shutdown();return
  if os.environ.get('BROWSER_TEST_SEAMS'):
   # Upgrade an existing v1 archive in place before the DB helper first opens.
   await control.evaluate("""()=>new Promise((resolve,reject)=>{const r=indexedDB.open('fullpage-shot-archive',1);r.onupgradeneeded=()=>{r.result.createObjectStore('jobs',{keyPath:'id'});for(const name of ['tiles','items'])r.result.createObjectStore(name,{keyPath:'id'}).createIndex('jobId','jobId');};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['jobs','tiles','items'],'readwrite');tx.objectStore('jobs').put({id:'migration-sentinel',title:'old archive',created:new Date().toISOString(),updated:0,status:'complete',tabId:999});tx.objectStore('tiles').put({id:'old-tile',jobId:'migration-sentinel',blob:new Blob(['old image bytes'])});tx.objectStore('items').put({id:'old-item',jobId:'migration-sentinel',title:'old note'});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}})""")
   saved=await control.evaluate("""async()=>{const job=await ArchiveDB.get('jobs','migration-sentinel'),tile=await ArchiveDB.get('tiles','old-tile'),item=await ArchiveDB.get('items','old-item');await ArchiveDB.put('frames',{id:'migration-frame',jobId:job.id,blob:new Blob(['frame'])});return {title:job.title,image:await tile.blob.text(),note:item.title}}""")
   assert saved=={'title':'old archive','image':'old image bytes','note':'old note'}
   await control.evaluate("ArchiveDB.remove('migration-sentinel')")
   assert not await control.evaluate("ArchiveDB.get('frames','migration-frame')")
   results.append({'case':'IndexedDB v1 upgrade preserves jobs / image bytes / notes and frame deletion','preserved':True})
   # Pixel-only page: no card IDs, text anchors, img elements or row markers.
   page=await context.new_page();ident=await register(page)
   await page.goto(origin+'/tests/pixel-fixture.html')
   await page.bring_to_front();await send({'type':'INFO','tabId':ident})
   flags['corruptNextSeam']=True
   await start(ident,background=True)
   first=await wait_job(ident,tiles_at_least=2)
   assert flags.get('corruptions')==1
   assert first['last']['anchors']==[]
   await send({'type':'PAUSE','jobId':first['id']});paused=await wait_job(ident)
   await page.evaluate("y=>{const ctx=document.getElementById('page').getContext('2d');ctx.fillStyle='rgb(23,62,171)';ctx.fillRect(0,y-120,1200,120);}",paused['last']['end'])
   await send({'type':'START','tabId':ident,'resume':paused['id']});job=await wait_job(ident)
   assert job['status']=='complete',job
   data=await counts(job);assert job['strip']==0 and all(t['seam']=='pixels' for t in data['tiles'][1:])
   review=await context.new_page();await review.goto(origin+'/review.html?job='+job['id'])
   await review.wait_for_function('typeof job!=="undefined" && job && tiles.length>0')
   for button in ['png','pdf']:
    await review.locator('#'+button).click();await review.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=90000)
   path=next(OUTPUT.glob('*_'+job['id'][:8]+'_连续长图.png'));actual=Image.open(path).convert('RGB')
   # Independent full-page CDP screenshot is the ground truth for every pixel.
   session=await context.new_cdp_session(page);height=await page.evaluate('document.documentElement.scrollHeight')
   baseline=await session.send('Page.captureScreenshot',{'format':'png','fromSurface':True,'captureBeyondViewport':True,'clip':{'x':0,'y':0,'width':1200,'height':height,'scale':1}})
   expected=Image.open(io.BytesIO(base64.b64decode(baseline['data']))).convert('RGB');expected.save(OUTPUT/'pixel-ground-truth.png')
   assert actual.size==expected.size,(actual.size,expected.size)
   difference=ImageChops.difference(actual,expected);assert difference.getbbox() is None,difference.getbbox()
   pdf=fitz.open(next(OUTPUT.glob('*_'+job['id'][:8]+'_连续.pdf')));assert len(pdf)==1
   # Reconstruct embedded image blocks in PDF order, checking their actual bytes.
   rects=sorted([(pdf[0].get_image_rects(x[0])[0],x[0]) for x in pdf[0].get_images()],key=lambda t:t[0].y0)
   y=0;pdf_pixels=Image.new('RGB',actual.size)
   for rectangle,xref in rects:
    image=Image.open(io.BytesIO(pdf.extract_image(xref)['image'])).convert('RGB');pdf_pixels.paste(image,(0,y));y+=image.height
   assert y==actual.height and ImageChops.difference(pdf_pixels,actual).getbbox() is None
   results.append({'case':'pixel-only page / pause-resume / PNG and embedded PDF match baseline at every pixel','size':list(actual.size),'tiles':job['tileCount'],'strips':1,'differentPixels':0,'corruptedCaptureRetried':True,'changedTailReplaced':True})
   print('PASS',results[-1],flush=True)
   # Frame cache is local and bounded to one full viewport per job.
   frames=await control.evaluate('id=>ArchiveDB.list("frames",id)',job['id']);assert len(frames)==1
   await send({'type':'DELETE','jobId':job['id']});assert not await control.evaluate('id=>ArchiveDB.list("frames",id)',job['id'])
   await review.close()
   # Previously stored independent full viewports are repaired at export time.
   positions=list(range(0,height-900,630))+[height-900]
   positions.insert(2,positions[1])  # Include a duplicated pause-resume viewport.
   rows=[]
   for i,y in enumerate(positions):
    buffer=io.BytesIO();expected.crop((0,y,1200,y+900)).save(buffer,format='PNG')
    rows.append({'id':'legacy-pixel-overlap:'+str(i),'jobId':'legacy-pixel-overlap','index':i,'strip':i,'width':1200,'height':900,'start':y,'end':y+900,'data':base64.b64encode(buffer.getvalue()).decode()})
   legacy=await control.evaluate("""async ({rows,tabId,url})=>{const job={id:'legacy-pixel-overlap',tabId,url,title:'旧片段像素修复',created:new Date().toISOString(),updated:Date.now(),status:'complete',warnings:[],reason:'test',tileCount:rows.length,itemCount:0,bytes:0,options:{}};await ArchiveDB.put('jobs',job);for(const row of rows){const {data,...t}=row;t.blob=new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'image/png'});await ArchiveDB.put('tiles',t);}return job;}""",{'rows':rows,'tabId':ident,'url':page.url})
   review=await context.new_page();await review.goto(origin+'/review.html?job='+legacy['id'])
   await review.wait_for_function('typeof job!=="undefined" && job && tiles.length>0')
   for button in ['png','pdf']:
    await review.locator('#'+button).click();await review.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=90000)
   repaired=Image.open(next(OUTPUT.glob('*_legacy-p_连续长图.png'))).convert('RGB')
   assert repaired.size==expected.size and ImageChops.difference(repaired,expected).getbbox() is None
   repaired_doc=fitz.open(next(OUTPUT.glob('*_legacy-p_连续.pdf')));assert len(repaired_doc)==1
   results.append({'case':'old independent viewports / duplicate resume frame repaired on export without force','inputHeight':sum(t['height'] for t in rows),'outputHeight':repaired.height,'differentPixels':0})
   print('PASS',results[-1],flush=True)
   await review.close();await page.close();pages.pop(ident)
   page,ident=await fixture('infinite',90);await start(ident,background=True);job=await wait_job(ident)
   await record('infinite append / repainted old tail / verified continuous output',job,90);assert job['strip']==0
   await page.close();pages.pop(ident)
   (OUTPUT/'seam-results.json').write_text(json.dumps({'browser':browser.version,'cases':results,'method':'Real Chromium rendering/CDP screenshots, with API bridge; all pixels compared to independent full-page capture.'},ensure_ascii=False,indent=2))
   print('PASS pixel seam suite',flush=True)
   await browser.close();server.shutdown();return
  if os.environ.get('BROWSER_TEST_INDEPENDENT'):
   source,first_id=await fixture('virtual',500);await start(first_id,background=True)
   first=await wait_job(first_id,tiles_at_least=2)
   other,second_id=await fixture('lazy',36);await start(second_id,background=True)
   flags['active']=False
   await control.evaluate('()=>{globalThis.testWindowState={state:"minimized",focused:false}}')
   await send({'type':'PAUSE','jobId':first['id']});paused=await wait_job(first_id);assert paused['status']=='paused'
   await send({'type':'START','tabId':first_id,'resume':paused['id']})
   first_job=await wait_job(first_id);second_job=await wait_job(second_id)
   await record('background target / inactive and minimized state / independent first tab / pause-resume / 500 virtual cards',first_job,500)
   await record('independent second target finishes without pausing first',second_job,36)
   assert first_job['last']['url']==source.url and second_job['last']['url']==other.url
   assert first_job['strip']==0 and second_job['strip']==0
   flags['active']=None;await control.evaluate('()=>{globalThis.testWindowState={state:"normal",focused:true}}')
   # Confirm other work can proceed and a target URL change remains a pause.
   target,ident=await fixture('lazy',90);await start(ident,background=True);await wait_job(ident,tiles_at_least=1)
   await target.goto(origin+'/tests/fixture.html?mode=lazy&count=18&different=yes')
   changed=await wait_job(ident);assert changed['status']=='paused' and '跳转' in changed['reason']
   results.append({'case':'target navigation still pauses its own job','status':changed['status']})
   await target.close();pages.pop(ident)
   review500=await context.new_page();await review500.goto(origin+'/review.html?job='+first_job['id'])
   await review500.wait_for_function('typeof job!=="undefined" && job && tiles.length>0')
   for button in ['png','pdf']:
    await review500.locator('#'+button).click();await review500.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=120000)
   png500=Image.open(next(OUTPUT.glob('*_'+first_job['id'][:8]+'_连续长图.png')))
   metadata=await counts(first_job);assert png500.height==sum(t['height'] for t in metadata['tiles'])
   assert len(fitz.open(next(OUTPUT.glob('*_'+first_job['id'][:8]+'_连续.pdf'))))==1
   results.append({'case':'500-card single PNG / one-page PDF after background pause-resume','pngSize':list(png500.size),'pdfPages':1,'strips':first_job['strip']+1})
   await review500.close()
   # The saved source is one verified strip; single and A4 exports are choices.
   review=await context.new_page();await review.goto(origin+'/review.html?job='+second_job['id'])
   await review.wait_for_function('typeof job!=="undefined" && job && tiles.length>0')
   for button in ['png','pdf']:
    await review.locator('#'+button).click();await review.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=90000)
   pdf_path=next(OUTPUT.glob('*_'+second_job['id'][:8]+'_连续.pdf'));doc=fitz.open(pdf_path)
   assert len(doc)==1
   rects=sorted([doc[0].get_image_rects(i[0])[0] for i in doc[0].get_images()],key=lambda r:r.y0)
   assert all(abs(a.y1-b.y0)<.02 for a,b in zip(rects,rects[1:])),rects
   assert abs(rects[0].y0)<.02 and abs(rects[-1].y1-doc[0].rect.height)<.02
   await review.locator('#pdfMode').select_option('paged');await review.locator('#pdf').click()
   await review.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=90000)
   paged=fitz.open(next(OUTPUT.glob('*_'+second_job['id'][:8]+'_01.pdf')))
   assert len(paged)>=2 and all(abs(p.rect.height-841.89)<.1 for p in paged)
   results.append({'case':'single-page continuous PDF / touching image rectangles / A4 option','continuousPages':1,'a4Pages':len(paged)})
   await review.close()
   # A full-size raster above 32767 rows is encoded without one giant canvas.
   synthetic=await control.evaluate("""async tabId=>{
    const id='streaming-long-png-test',job={id,tabId,title:'连续导出测试',url:'https://example.com/long',created:new Date().toISOString(),updated:Date.now(),status:'complete',reason:'test',warnings:[],tileCount:2,itemCount:0,bytes:0,strip:0,options:{}};
    await ArchiveDB.put('jobs',job);
    for(let n=0;n<2;n++){const c=document.createElement('canvas');c.width=96;c.height=20000;const x=c.getContext('2d');for(let y=0;y<20000;y++){x.fillStyle=`rgb(${(n*20000+y)%251},37,91)`;x.fillRect(0,y,96,1);}const blob=await new Promise(r=>c.toBlob(r));await ArchiveDB.put('tiles',{id:id+':'+n,jobId:id,index:n,strip:0,width:96,height:20000,blob});}return job;
   }""",second_id)
   review=await context.new_page();await review.goto(origin+'/review.html?job='+synthetic['id'])
   await review.wait_for_function('typeof job!=="undefined" && job && tiles.length===2')
   for button in ['png','pdf']:
    await review.locator('#'+button).click();await review.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=90000)
   longpng=Image.open(next(OUTPUT.glob('*_streamin_连续长图.png'))).convert('RGB');assert longpng.size==(96,40000)
   for y in [0,100,19999,20000,20001,39999]:assert longpng.getpixel((30,y))==(y%251,37,91),(y,longpng.getpixel((30,y)))
   longdoc=fitz.open(next(OUTPUT.glob('*_streamin_连续.pdf')));assert len(longdoc)==1
   assert max(longdoc[0].rect.width,longdoc[0].rect.height)<=14000.1
   results.append({'case':'streamed 40000-row PNG / no missing boundary rows / single long PDF','pngSize':list(longpng.size),'pdfPages':len(longdoc)})
   # Ambiguous strips require an explicit choice instead of silent overlap loss.
   await control.evaluate("async id=>{const t=await ArchiveDB.get('tiles',id+':1');t.strip=1;await ArchiveDB.put('tiles',t)}",synthetic['id'])
   await review.reload();await review.wait_for_function('typeof job!=="undefined" && job && tiles.length===2')
   await review.locator('#png').click();await review.wait_for_function('!busy && document.getElementById("status").textContent.includes("未确认")')
   results.append({'case':'unverified seams are reported before continuous output','blocked':True})
   await review.close();await source.close();await other.close()
   (OUTPUT/'independent-results.json').write_text(json.dumps({'browser':browser.version,'cases':results,'method':'Real target CDP focus emulation, rendering and export; inactive-tab/window states use API bridge. Not native extension installation.'},ensure_ascii=False,indent=2))
   print('PASS independent / continuous export suite',flush=True)
   await browser.close();server.shutdown();return
  if os.environ.get('BROWSER_TEST_OVERLAYS'):
   async def tile_images(job):
    encoded=await control.evaluate("""async id=>{const tiles=await ArchiveDB.list('tiles',id);return Promise.all(tiles.map(async t=>{const row=await ArchiveDB.get('tiles',t.id);const a=new Uint8Array(await row.blob.arrayBuffer());let s='';for(const n of a)s+=String.fromCharCode(n);return btoa(s);}));}""",job['id'])
    return [Image.open(io.BytesIO(base64.b64decode(data))).convert('RGB') for data in encoded]
   async def magenta_count(job):
    return sum(sum(pixel==(250,0,250) for pixel in image.get_flattened_data()) for image in await tile_images(job))
   page,ident=await fixture('lazy',36)
   await page.evaluate((ROOT/'tests'/'overlays-fixture.js').read_text());await page.evaluate('makeTestOverlays()')
   await send({'type':'EXCLUDE','tabId':ident});await page.locator('#manual-absolute').click(position={'x':70,'y':60})
   info=await send({'type':'INFO','tabId':ident});assert info['manualExclusions']==1
   # Cancel a subsequent picker without changing the user's earlier selection.
   await send({'type':'EXCLUDE','tabId':ident});await page.keyboard.press('Escape')
   assert (await send({'type':'INFO','tabId':ident}))['manualExclusions']==1
   # Sticky UI should remain in its original position once, before it sticks.
   await page.evaluate('FullPageCollector.prepare({top:true})')
   assert await page.locator('#sticky-tool').evaluate('e=>getComputedStyle(e).visibility')=='visible'
   await page.evaluate('FullPageCollector.move(400)');await page.wait_for_timeout(50)
   assert await page.locator('#sticky-tool').evaluate('e=>getComputedStyle(e).visibility')=='hidden'
   await page.evaluate('FullPageCollector.move(0)');await page.wait_for_timeout(50)
   assert await page.locator('#sticky-tool').evaluate('e=>getComputedStyle(e).visibility')=='visible'
   # Give sticky UI a different color so the pixel sentinel measures floating UI.
   await page.evaluate("document.getElementById('sticky-tool').style.background='rgb(20,180,20)';FullPageCollector.cleanup()")
   # Restrict page style tags: the extension user stylesheet/inline fallback must work.
   await page.evaluate("()=>{const m=document.createElement('meta');m.httpEquiv='Content-Security-Policy';m.content=\"style-src 'none'\";document.head.append(m);}")
   await start(ident);first=await wait_job(ident,tiles_at_least=1)
   # During collection fixed/absolute cards keep their normal geometry and images.
   assert await page.locator('.note-item').first.evaluate('e=>getComputedStyle(e).visibility')=='visible'
   await send({'type':'PAUSE','jobId':first['id']});paused=await wait_job(ident)
   assert paused['status']=='paused'
   assert await page.locator('#arbitrary-tool').evaluate('e=>getComputedStyle(e).visibility')=='visible'
   assert await page.locator('#shadow-widget button').evaluate('e=>getComputedStyle(e).visibility')=='visible'
   await send({'type':'START','tabId':ident,'resume':paused['id']});job=await wait_job(ident)
   await record('fixed / dynamic / shadow / CSP / manual overlays with pause-resume',job,36)
   assert await magenta_count(job)==0,'Floating widget pixels leaked into saved images'
   images=await tile_images(job);images[0].save(OUTPUT/'overlay-filtered-first.png')
   # The absolute overlay covered NOTE 4 at (350,275); its actual image color
   # must be present in the saved tile, not a white patch or cropped hole.
   expected=await page.evaluate("()=>{const c=document.createElement('canvas');const x=c.getContext('2d');x.fillStyle='hsl(93,55%,75%)';x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data].slice(0,3);}")
   scale=images[0].width/1200
   assert images[0].getpixel((round(350*scale),round(275*scale)))==tuple(expected),(images[0].getpixel((round(350*scale),round(275*scale))),expected)

   assert await page.locator('[data-overlay-test]').evaluate_all('es=>es.every(e=>getComputedStyle(e).visibility==="visible")')
   assert not await page.locator('[data-overlay-test]').first.evaluate('e=>[...e.attributes].some(a=>a.name.startsWith("data-fps-hide-"))')
   results.append({'case':'pixel sentinel / all widgets restored / no excluded broken-image wait','floatingPixels':0,'savedItems':36})
   # Test actual PDF output, not only DOM visibility.
   review=await context.new_page();await review.goto(origin+'/review.html?job='+job['id'])
   await review.wait_for_function('typeof job!=="undefined" && job && tiles.length>0')
   await review.locator('#pdfMode').select_option('paged');await review.locator('#pdf').click();await review.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=60000)
   pdfs=list(OUTPUT.glob('*_'+job['id'][:8]+'_*.pdf'));assert pdfs
   for path in pdfs:
    for pdfpage in fitz.open(path):
     bitmap=pdfpage.get_pixmap()
     image=Image.frombytes('RGB',(bitmap.width,bitmap.height),bitmap.samples)
     assert not any(pixel==(250,0,250) for pixel in image.get_flattened_data())
   results.append({'case':'PDF output contains no floating pixel sentinel','pdfFiles':len(pdfs)})
   await review.close();await page.close();pages.pop(ident)
   # Fixed article/scroll shell must not vanish when it is the chosen content.
   page,ident=await fixture('container',45)
   await page.evaluate("document.getElementById('root').style.cssText='position:fixed;inset:70px 40px 40px;margin:0;height:620px';")
   await send({'type':'CHOOSE','tabId':ident});await page.locator('.note-item').first.click(position={'x':30,'y':40})
   await start(ident);job=await wait_job(ident);await record('selected fixed scrolling body is protected',job,45)
   await page.close();pages.pop(ident)
   # Manual picking within a fixed app shell must select the nearest widget,
   # not an outer shell that contains the whole reading area.
   page,ident=await fixture('container',18)
   await page.evaluate("""()=>{const r=document.getElementById('root');r.style.cssText='position:fixed;inset:70px 40px 40px;margin:0;height:620px';const e=document.createElement('div');e.id='nested-widget';e.style.cssText='position:fixed;top:200px;left:220px;width:100px;height:80px;background:magenta';e.textContent='widget';r.append(e);}""")
   await send({'type':'EXCLUDE','tabId':ident});await page.locator('#nested-widget').click(position={'x':60,'y':60})
   await page.evaluate('FullPageCollector.prepare({top:true})')
   assert await page.locator('#root').evaluate('e=>getComputedStyle(e).visibility')=='visible'
   assert await page.locator('#nested-widget').evaluate('e=>getComputedStyle(e).visibility')=='hidden'
   await page.evaluate('FullPageCollector.cleanup()')
   results.append({'case':'large fixed reading shell / nearest manual widget selection','bodyPreserved':True})
   await page.close();pages.pop(ident)
   page,ident=await fixture('lazy',18)
   await page.evaluate("()=>{const e=document.createElement('div');e.id='replaceable-overlay';e.style.cssText='position:absolute;top:200px;left:200px;width:100px;height:80px';e.textContent='manual';document.body.append(e);}")
   await send({'type':'EXCLUDE','tabId':ident});await page.locator('#replaceable-overlay').click(position={'x':50,'y':50})
   await page.evaluate('FullPageCollector.prepare({top:true})')
   await page.evaluate("document.getElementById('replaceable-overlay').replaceWith(document.createElement('div'))")
   failure=await page.evaluate("()=>{try{FullPageCollector.inspect();return ''}catch(e){return e.message}}")
   assert '替换' in failure and '清空' in failure
   await page.evaluate('FullPageCollector.cleanup();FullPageCollector.clearExclusions()')
   results.append({'case':'replaced manual exclusion stops before saving contaminated tiles','paused':True})
   await page.close();pages.pop(ident)
   # Users can retain floats explicitly. Check the saved pixels change accordingly.
   page,ident=await fixture('lazy',18)
   await page.evaluate("()=>{const e=document.createElement('div');e.style.cssText='position:fixed;bottom:100px;right:10px;width:100px;height:60px;background:rgb(250,0,250);z-index:99999';document.body.append(e);}")
   await start(ident,hideOverlays=False);job=await wait_job(ident);await record('user can retain floating UI',job,18)
   assert await magenta_count(job)>0
   denied=await control.evaluate('m=>testSend(m)',{'type':'START','tabId':ident,'resume':job['id'],'options':{'hideOverlays':True}})
   assert not denied['ok'] and '从顶部' in denied['error']
   results.append({'case':'changing overlay setting cannot mix with old saved tiles','rejected':True})
   await page.close();pages.pop(ident)
   (OUTPUT/'overlay-results.json').write_text(json.dumps({'browser':browser.version,'cases':results,'method':'Real Chromium rendering/CDP pixel and PDF checks with extension API bridge; not an installed-extension test.'},ensure_ascii=False,indent=2))
   print('PASS overlay regression suite',flush=True)
   await browser.close();server.shutdown();return
  if os.environ.get('BROWSER_TEST_STARTUP'):
   await control.evaluate('()=>{globalThis.testWindowState={focused:false};}')
   page,ident=await fixture('lazy',36);await start(ident);job=await wait_job(ident)
   await record('visible active tab with unfocused parent window',job,36)
   await page.close();pages.pop(ident)
   page,ident=await fixture('lazy',18);flags['active']=False
   await start(ident);await asyncio.sleep(.5)
   waiting=await send({'type':'LAST','tabId':ident})
   assert waiting['status']=='running' and waiting['tileCount']==0 and '等待' in waiting['phase']
   flags['active']=True;job=await wait_job(ident);await record('popup transition waits rather than pauses immediately',job,18)
   await page.close();pages.pop(ident)
   flags['infobar']=True
   page,ident=await fixture('lazy',90);await start(ident);first=await wait_job(ident,tiles_at_least=2)
   assert first['sourceViewport']['height']==900 and first['viewport']['height']==860
   await send({'type':'PAUSE','jobId':first['id']});paused=await wait_job(ident)
   assert page.viewport_size['height']==900
   await send({'type':'START','tabId':ident,'resume':paused['id']});job=await wait_job(ident)
   await record('debugger infobar viewport / detach / same-page resume',job,90)
   await page.close();pages.pop(ident);flags['infobar']=False
   page,ident=await fixture('lazy',18)
   legacy={'id':'legacy-zero-screen','tabId':ident,'url':page.url,'title':'旧版零截图任务','created':'2026-10-12T00:00:00Z','status':'paused','reason':'目标页面不在前台，已暂停。','tileCount':0,'itemCount':0,'bytes':0,'strip':-1,'last':None,'warnings':[],
     'options':{'overview':True,'allowIncomplete':False,'background':False,'waitMs':4000,'settleMs':500,'bottomWaitMs':2500,'maxSteps':1500}}
   await control.evaluate('j=>ArchiveDB.put("jobs",j)',legacy)
   await send({'type':'START','tabId':ident,'resume':legacy['id']});job=await wait_job(ident)
   await record('resume legacy task that failed before page preparation',job,18)
   await page.close();pages.pop(ident)
   page,ident=await fixture('lazy',90);await start(ident);first=await wait_job(ident,tiles_at_least=2)
   flags['active']=False;job=await wait_job(ident);assert job['status']=='paused' and '其他标签页' in job['reason']
   results.append({'case':'actual tab switch still pauses','status':job['status'],'tiles':job['tileCount']})
   flags['active']=True;await send({'type':'START','tabId':ident,'resume':job['id']});await wait_job(ident,tiles_at_least=job['tileCount']+1)
   await control.evaluate('()=>{globalThis.testWindowState={focused:false,state:"minimized"};}')
   job=await wait_job(ident);assert job['status']=='paused' and '最小化' in job['reason']
   results.append({'case':'minimized window still pauses','status':job['status'],'tiles':job['tileCount']})
   await control.evaluate('()=>{globalThis.testWindowState={focused:false,state:"normal"};}')
   await page.close();pages.pop(ident)
   page,ident=await fixture('broken',18);await start(ident)
   deadline=time.monotonic()+10;loading=None
   while time.monotonic()<deadline:
    loading=await send({'type':'LAST','tabId':ident})
    if '等待当前区域加载' in loading['phase']:break
    await asyncio.sleep(.1)
   assert loading['status']=='running' and '1 张图片' in loading['phase'],loading
   job=await wait_job(ident);assert job['status']=='paused'
   results.append({'case':'loading count and remaining time visible before first saved screen','status':job['status'],'tiles':job['tileCount']})
   (OUTPUT/'startup-results.json').write_text(json.dumps({'browser':browser.version,'cases':results,'method':'Real Chromium rendering with test-only focus, active-tab and debugger-infobar API simulation; not an installed-extension test.'},ensure_ascii=False,indent=2))
   print('PASS startup regression suite',flush=True)
   await browser.close();server.shutdown();return
  if os.environ.get('BROWSER_TEST_QUICK'):
   page,ident=await fixture('broken',30);await start(ident);paused=await wait_job(ident)
   assert paused['status']=='paused' and paused['tileCount']==0
   await page.evaluate('(src)=>{document.querySelector(\"img[data-index=\\\"2\\\"]\").src=src;window.scrollTo(0,document.documentElement.scrollHeight)}', 'data:image/svg+xml;base64,'+base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg" width="500" height="160"><rect width="500" height="160" fill="red"/></svg>').decode())
   await send({'type':'START','tabId':ident,'resume':paused['id']});job=await wait_job(ident);await record('zero-fragment resume returns to top',job,30)
   await page.close();pages.pop(ident)
   page,ident=await fixture('lazy',60);await start(ident);first=await wait_job(ident,tiles_at_least=2)
   await page.set_viewport_size({'width':1100,'height':850});job=await wait_job(ident)
   assert job['status']=='paused' and '尺寸' in job['reason']
   await send({'type':'START','tabId':ident,'resume':job['id']});denied=await wait_job(ident);assert denied['status']=='paused'
   await page.set_viewport_size({'width':1200,'height':900});await send({'type':'START','tabId':ident,'resume':job['id']});job=await wait_job(ident);await record('resize pauses / restore resumes',job,60)
   (OUTPUT/'resume-edge-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
   await browser.close();server.shutdown();return
  # Lazy images + fixed bars, then validate actual exported artifacts.
  page,ident=await fixture('lazy',36);job=await start(ident);job=await wait_job(ident);await record('lazy / fixed bars / fractional DPR',job,36)
  review=await context.new_page();await review.goto(origin+'/review.html?job='+job['id'])
  await review.wait_for_function('typeof job!=="undefined" && job && tiles.length>0')
  review_errors=[];review.on('pageerror',lambda e:review_errors.append(str(e)))
  await review.locator('#pngMode').select_option('split');await review.locator('#pdfMode').select_option('paged')
  for button in ['png','pdf','html']:
   await review.locator('#'+button).click();await review.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=60000)
  pngs=list(OUTPUT.glob('*.png'));pdfs=list(OUTPUT.glob('*.pdf'));htmls=list(OUTPUT.glob('*.html'))
  assert pngs and pdfs and htmls
  total_height=sum(Image.open(path).height for path in pngs)
  data=await counts(job);assert total_height==sum(t['height'] for t in data['tiles'])
  assert sum(len(fitz.open(path)) for path in pdfs)>0
  offline=await context.new_page();await offline.goto(origin+'/dist/test-artifacts/'+quote(htmls[-1].name));assert await offline.locator('article').count()==36
  assert await offline.locator('img').count()==36
  await offline.locator('#search').fill('作者 2');assert 0<await offline.locator('article:visible').count()<36
  assert not review_errors,review_errors
  results.append({'case':'PNG / PDF / offline HTML / text escaping','pngHeight':total_height,'pdfFiles':len(pdfs),'htmlItems':36})
  print('PASS exports',flush=True)
  await review.locator('#notes').click();await review.wait_for_function('document.querySelectorAll("#grid article").length===20');await review.screenshot(path=str(OUTPUT/'review-preview.png'),full_page=True)
  await offline.close();await review.close();await page.close();pages.pop(ident)
  # Inner scroll-container picker is exercised through a trusted click.
  page,ident=await fixture('container',45);await send({'type':'CHOOSE','tabId':ident});await page.locator('.note-item').first.click(position={'x':40,'y':60})
  info=await send({'type':'INFO','tabId':ident});assert info['selected']
  job=await start(ident);job=await wait_job(ident);await record('selected inner scrolling container',job,45);await page.close();pages.pop(ident)
  page,ident=await fixture('infinite',90);job=await start(ident);job=await wait_job(ident);await record('infinite append and delayed loading',job,90);await page.close();pages.pop(ident)
  # 500 notes while DOM rows are actively removed outside the viewport.
  page,ident=await fixture('virtual',500);await start(ident)
  first=await wait_job(ident,tiles_at_least=3);await send({'type':'PAUSE','jobId':first['id']});paused=await wait_job(ident)
  assert paused['status']=='paused' and paused['tileCount']>=3
  await page.bring_to_front();await send({'type':'START','tabId':ident,'resume':paused['id']});job=await wait_job(ident);await record('500 virtualized notes / pause and resume',job,500)
  assert (await page.evaluate('testState()'))['rendered']<50
  review500=await context.new_page();await review500.goto(origin+'/review.html?job='+job['id'])
  await review500.wait_for_function('typeof job!=="undefined" && job && tiles.length>0')
  await review500.locator('#pngMode').select_option('split');await review500.locator('#pdfMode').select_option('paged')
  for button in ['png','pdf']:
   await review500.locator('#'+button).click();await review500.wait_for_function('!busy && document.getElementById("status").textContent.includes("已交给")',timeout=120000)
  large_pngs=list(OUTPUT.glob('*_'+job['id'][:8]+'_*.png'))
  assert len(large_pngs)>=3
  assert sum(Image.open(path).height for path in large_pngs)==sum(t['height'] for t in (await counts(job))['tiles'])
  assert all(Image.open(path).height<=10000 for path in large_pngs)
  results.append({'case':'500-note bounded PNG / PDF export','pngFiles':len(large_pngs),'pngHeight':sum(Image.open(path).height for path in large_pngs),'pdfFiles':len(list(OUTPUT.glob('*_'+job['id'][:8]+'_*.pdf')))})
  print('PASS 500-note PNG/PDF exports',flush=True)
  await review500.close();await page.bring_to_front()
  # Reload continuation scans again and deduplicates saved note IDs.
  await page.reload();await page.bring_to_front();await send({'type':'START','tabId':ident,'resume':job['id']});second=await wait_job(ident)
  await record('reload / rescan / note deduplication',second,500);await page.close();pages.pop(ident)
  # Missing images: strict mode stops before saving the affected viewport.
  page,ident=await fixture('broken',18);await start(ident);job=await wait_job(ident)
  assert job['status']=='paused' and job['tileCount']==0
  results.append({'case':'missing image stops strict capture','status':job['status'],'tiles':job['tileCount']});print('PASS broken image strict mode',flush=True)
  await page.bring_to_front();await start(ident,allowIncomplete=True,waitMs=3000);job=await wait_job(ident)
  assert job['tileCount']>0 and any(t['incomplete'] for t in (await counts(job))['tiles'])
  results.append({'case':'explicit incomplete capture flags missing image','status':job['status'],'tiles':job['tileCount']});print('PASS incomplete flag',flush=True)
  await page.close();pages.pop(ident)
  page,ident=await fixture('lazy',30)
  await control.evaluate('()=>{globalThis.realCommit=ArchiveDB.commit;ArchiveDB.commit=async()=>{throw new Error("模拟本地存储失败")};}')
  await start(ident);job=await wait_job(ident)
  assert job['status']=='paused' and job['tileCount']==0 and job['itemCount']==0
  assert not (await counts(job))['tiles']
  await control.evaluate('()=>{ArchiveDB.commit=realCommit;}')
  results.append({'case':'storage failure rolls back task counts','status':job['status'],'tiles':job['tileCount']});print('PASS storage rollback',flush=True)
  await page.close();pages.pop(ident)
  page,ident=await fixture('lazy',60);await start(ident);started=await wait_job(ident,tiles_at_least=2)
  await page.mouse.wheel(0,100);job=await wait_job(ident)
  assert job['status']=='paused' and job['tileCount']>=2
  results.append({'case':'trusted manual scroll pauses capture','status':job['status'],'tiles':job['tileCount']});print('PASS manual scroll interruption',flush=True)
  await page.close();pages.pop(ident)
  page,ident=await fixture('lazy',18,'no');await start(ident);job=await wait_job(ident)
  assert job['status']=='bottom';results.append({'case':'no end marker does not claim complete','status':job['status']});print('PASS ambiguous bottom',flush=True)
  (OUTPUT/'results.json').write_text(json.dumps({'browser':browser.version,'method':'Real Chromium rendering and CDP capture with test-only extension API bridge; extension installation blocked by environment administrator.','cases':results},ensure_ascii=False,indent=2))
  await browser.close();server.shutdown()
if __name__=='__main__':asyncio.run(main())
