const {test}=require('node:test');const assert=require('node:assert/strict');const C=require('../core.js');
const shot=(position,anchors)=>({position,start:position,end:position+800,area:{x:0,y:0,width:1200,height:800},viewport:{width:1200,height:800,dpr:1.25},anchors});
test('overlap accepts real movement and rejects changed layout',()=>{
 const a=shot(0,[{key:'a',x:10,y:650,height:80},{key:'b',x:10,y:750,height:30}]);
 const b=shot(560,[{key:'a',x:10,y:90,height:80},{key:'b',x:10,y:190,height:30}]);
 assert.equal(C.seam(a,b).join,true);b.anchors[1].y+=10;assert.equal(C.seam(a,b).join,false);
});
test('blank overlap is independent and query/filter identity is retained',()=>{
 assert.equal(C.seam(shot(0,[]),shot(500,[])).join,false);
 assert.notEqual(C.identity('https://example.com/?folder=1'),C.identity('https://example.com/?folder=2'));
});
test('export splits without dropping or duplicating pixels and respects independent strips',()=>{
 const tiles=[{id:'a',strip:0,width:100,height:12500},{id:'b',strip:0,width:100,height:2000},{id:'c',strip:1,width:100,height:500}];
 const slices=C.slices(tiles,6000,600000);
 assert.deepEqual(slices.map(s=>s.height),[6000,6000,2500,500]);
 for(const t of tiles){const parts=slices.flatMap(s=>s.parts).filter(p=>p.id===t.id);let y=0;for(const p of parts){assert.equal(p.sy,y);y+=p.height;}assert.equal(y,t.height);}
});
test('untrusted card text and links are safe in standalone exports',()=>{
 assert.equal(C.safeLink('javascript:alert(1)'),'');assert.equal(C.safeLink('data:text/html,x'),'');
 assert(!C.escape('</script><img src=x onerror="alert(1)">').includes('<'));
});

test('long output names preserve extension',()=>{assert(C.outputName('标题'.repeat(120)+'.pdf').endsWith('.pdf'));assert(C.outputName('x'.repeat(120)+'.png').endsWith('.png'));});

test('resume ignores restored overlay revision but preserves content changes',()=>{
 const a={...shot(0,[]),ready:true,contentSignature:'body',signature:'overlay1'};
 const b={...a,signature:'overlay2'};assert.equal(C.sameContent(a,b),true);
 b.contentSignature='new body';assert.equal(C.sameContent(a,b),false);
});
test('continuous output retains every row and refuses ambiguous seams by default',()=>{
 const tiles=[{id:'a',strip:0,width:1200,height:900},{id:'b',strip:0,width:1200,height:630}];
 assert.equal(C.continuous(tiles).height,1530);
 tiles[1].strip=1;assert.throws(()=>C.continuous(tiles),/未确认/);
 assert.equal(C.continuous(tiles,true).height,1530);
 tiles[1].width=1000;assert.throws(()=>C.continuous(tiles,true),/宽度/);
});
