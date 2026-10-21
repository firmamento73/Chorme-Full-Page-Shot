"""Test-only real flattened CDP sessions, mirroring chrome.debugger routing.
This does not load the native extension or control the user's browser.
"""
import asyncio,json,websockets
class Transport:
 def __init__(self,ws,control):
  self.ws,self.control=ws,control;self.serial=0;self.pending={};self.roots={};self.tabs={};self.child_tabs={};self.events=set();self.child_commands=0
  self.reader=asyncio.create_task(self.read())
 @classmethod
 async def connect(cls,url,control):return cls(await websockets.connect(url,max_size=None,proxy=None),control)
 async def read(self):
  async for raw in self.ws:
   msg=json.loads(raw)
   if 'id' in msg:
    future=self.pending.pop(msg['id'],None)
    if future:
     if 'error' in msg:future.set_exception(RuntimeError(msg['error']['message']))
     else:future.set_result(msg.get('result',{}))
   elif 'method' in msg:
    sid=msg.get('sessionId');tab=self.tabs.get(sid,self.child_tabs.get(sid))
    if tab is not None:
     if msg['method']=='Target.attachedToTarget':self.child_tabs[msg['params']['sessionId']]=tab
     source={'tabId':tab}
     if sid!=self.roots.get(tab):source['sessionId']=sid
     event=[source,msg['method'],msg.get('params',{})]
     task=asyncio.create_task(self.control.evaluate('args=>{for(const fn of globalThis.testDebugEvents||[])fn(...args);}',event));self.events.add(task);task.add_done_callback(self.events.discard)
 async def send(self,method,params=None,session=None):
  self.serial+=1;ident=self.serial;future=asyncio.get_running_loop().create_future();self.pending[ident]=future
  message={'id':ident,'method':method,'params':params or {}}
  if session:message['sessionId']=session
  await self.ws.send(json.dumps(message));return await asyncio.wait_for(future,30)
 async def attach(self,tab,page,context):
  targets=(await self.send('Target.getTargets'))['targetInfos']
  matches=[t for t in targets if t['type']=='page' and t['url']==page.url]
  assert len(matches)==1,matches
  target=matches[0]['targetId']
  response=await self.send('Target.attachToTarget',{'targetId':target,'flatten':True});sid=response['sessionId'];self.roots[tab]=sid;self.tabs[sid]=tab
 async def command(self,target,method,params):
  sid=target.get('sessionId',self.roots[target['tabId']])
  if 'sessionId' in target:self.child_commands+=1
  return await self.send(method,params,sid)
 async def detach(self,tab):
  sid=self.roots.pop(tab,None)
  if sid:
   self.tabs.pop(sid,None)
   for child in [k for k,v in self.child_tabs.items() if v==tab]:self.child_tabs.pop(child,None)
   await self.send('Target.detachFromTarget',{'sessionId':sid})
 async def close(self):
  if self.events:await asyncio.gather(*list(self.events),return_exceptions=True)
  await self.ws.close();await self.reader
