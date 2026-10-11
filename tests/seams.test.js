const {test}=require('node:test');const assert=require('node:assert/strict');const S=require('../seams.js');
function frame(y,height=300,width=80){const data=new Uint8ClampedArray(width*height*4);for(let j=0;j<height;j++)for(let x=0;x<width;x++){const i=(j*width+x)*4,n=y+j;data[i]=((Math.imul(n+1,2654435761)>>>24)+x*17)%251;data[i+1]=((Math.imul(n+1,1597334677)>>>24)+x*29)%251;data[i+2]=((Math.imul(n+1,3812015801)>>>24)+x*3)%251;data[i+3]=255;}return {width,height,data};}
test('pixel matching finds overlap without any DOM anchors',()=>{const m=S.match(frame(0),frame(180),{expected:120});assert.equal(m.join,true);assert.equal(m.skip,120);});
test('actual content offset overrides inaccurate DOM scroll estimate',()=>{const m=S.match(frame(0),frame(171),{expected:120});assert.equal(m.join,true);assert.equal(m.skip,129);});
test('repainted bottom is replaced at a verified earlier seam',()=>{const a=frame(0),b=frame(180);a.data.fill(255,280*80*4);const m=S.match(a,b,{expected:120});assert.equal(m.join,true);assert(m.trim>=20);assert.equal(m.skip+m.trim,120);});
test('flat backgrounds are not guessed without geometric references',()=>{const a=frame(0);a.data.fill(255);assert.equal(S.match(a,a,{expected:120}).join,false);assert.equal(S.match(a,a,{expected:120,geometry:true}).join,true);});
test('same position must be identical across the entire frame',()=>{const a=frame(0),b=frame(0);assert.equal(S.match(a,b,{expected:300,samePosition:true}).skip,300);b.data[20*80*4]=0;assert.equal(S.match(a,b,{expected:300,samePosition:true}).join,false);});
test('unrelated frames are not silently appended',()=>{assert.equal(S.match(frame(0),frame(1200),{expected:120}).join,false);});

test('same-position late loading replaces the changed suffix rather than duplicating the viewport',()=>{const a=frame(0),b=frame(0);a.data.fill(255,280*80*4);const m=S.match(a,b,{expected:300,samePosition:true});assert.equal(m.join,true);assert.equal(m.skip,280);assert.equal(m.trim,20);});
