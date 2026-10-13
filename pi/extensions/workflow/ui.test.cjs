const test=require('node:test');
const assert=require('node:assert/strict');
const {load}=require('./test-helper.cjs');
test('progress render caches reuse and invalidates revisions, width, theme and views',async()=>{
 const {ProgressComponent}=await load('widget.ts');
 let details={id:'run',revision:1,status:'running',nodes:[{id:'r',kind:'workflow',label:'研究',status:'running',children:['s']},{id:'s',kind:'sequence',label:'Sequence',status:'running',children:['one','two'],activeStage:1,previousStage:0},{id:'one',kind:'stage',label:'Previous',status:'completed',children:[]},{id:'two',kind:'stage',label:'Active',status:'running',children:[]}]};
 const component=new ProgressComponent(()=>[{owner:'main',details}]);
 const a=component.render(80);assert.strictEqual(component.render(80),a);assert.equal(component.layouts,1);assert.match(a.join('\n'),/previous: Previous/);assert.match(a.join('\n'),/active: Active/);
 component.render(20);assert.equal(component.layouts,2);
 details.revision++;details.nodes[3].label='Updated';assert.match(component.render(80).join('\n'),/Updated/);assert.equal(component.layouts,3);
 component.invalidate();component.render(80);assert.equal(component.layouts,4);
 for(const width of [1,20,80,120]){const lines=component.render(width);const {visibleWidth}=await import(require('node:url').pathToFileURL(require.resolve('@earendil-works/pi-tui',{paths:[require('./test-helper.cjs').root]})).href);assert.ok(lines.every(line=>visibleWidth(line)<=width))}
});
test('compact rows bound fanout and strip controls',async()=>{
 const {ProgressComponent}=await load('widget.ts');
 const children=Array.from({length:20},(_,i)=>'b'+i);
 const details={id:'run',revision:1,status:'running',nodes:[{id:'r',kind:'parallel',label:'Fanout',status:'running',children},...children.map(id=>({id,kind:'branch',label:'\x1b[31mLong\nlabel',status:'queued',children:[]}))]};
 const component=new ProgressComponent(()=>[{owner:'main',details}]);
 const lines=component.render(80);assert.equal(lines.length,12);assert.match(lines.at(-1),/more progress rows/);assert.doesNotMatch(lines.join('\n'),/\x1b/);
});
test('widget modes and aggregated worker snapshots publish and cleanup',async()=>{
 const {attachProgressWidget}=await load('widget.ts');
 let calls=0,unsubscribe=0,listener,progress=[];
 const ctx={mode:'print',ui:{setWidget(){calls++}}},api={getProgress:()=>progress,subscribeProgress(fn){listener=fn;return()=>unsubscribe++}};
 attachProgressWidget(ctx,api)();assert.equal(calls,0);
 ctx.mode='tui';const dispose=attachProgressWidget(ctx,api);
 progress=[{owner:'worker',details:{id:'run',revision:1,status:'running',nodes:[]}}];listener();assert.equal(calls,1);
 progress=[];listener();assert.equal(calls,2);dispose();assert.equal(unsubscribe,1);
});
