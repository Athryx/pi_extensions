const {test}=require('node:test');
const assert=require('node:assert/strict');
const {load}=require('./test-helper.cjs');
const context=(mode,worker=false)=>({mode,sessionManager:{getBranch:()=>worker?[{type:'custom',customType:'subagents.identity.v1',data:{role:'worker'}}]:[]}});

test('interactive tool marker preserves schema/guidance and guards direct execution',async()=>{
  const {interactiveTool,isInteractiveTool}=await load('../shared/interactive.ts');
  let calls=0;
  const definition={name:'example',label:'Example',description:'Example',promptSnippet:'Snippet',promptGuidelines:['Guideline'],parameters:{type:'object',properties:{},additionalProperties:false},async execute(){calls++;return {content:[],details:undefined};}};
  const tool=interactiveTool(definition);
  assert.equal(isInteractiveTool(tool),true);
  assert.equal(isInteractiveTool(definition),false);
  assert.equal(tool.parameters,definition.parameters);
  assert.deepEqual(tool.promptGuidelines,['Guideline']);
  await tool.execute('id',{},undefined,undefined,context('tui'));
  for(const ctx of [context('print'),context('rpc'),context('tui',true)]) await assert.rejects(tool.execute('id',{},undefined,undefined,ctx),/interactive agent/);
  assert.equal(calls,1);
});

test('interactive registration suppresses every tool usage snippet outside the main TUI',async()=>{
  const {registerInteractiveTool}=await load('../shared/interactive.ts');
  const tool={name:'example',label:'Example',description:'Example',exposure:'model-only',promptSnippet:'Snippet',promptGuidelines:['Guideline'],parameters:{type:'object',properties:{},additionalProperties:false},async execute(){return {content:[],details:undefined};}};
  for(const ctx of [context('tui'),context('print'),context('rpc'),context('tui',true)]){
    let registered;
    registerInteractiveTool({registerTool:t=>registered=t},tool,ctx);
    assert.equal(registered.interactiveOnly,true);
    const interactive=ctx.mode==='tui'&&ctx.sessionManager.getBranch().length===0;
    assert.equal(registered.exposure,interactive?'model-only':'hidden');
    assert.equal(registered.promptSnippet,interactive?'Snippet':undefined);
    assert.deepEqual(registered.promptGuidelines,interactive?['Guideline']:undefined);
  }
});

test('interactive sections preserve unrelated content and remove stale worker/headless guidance',async()=>{
  const {interactiveSection}=await load('../shared/interactive.ts');
  const sections={existing:'Preserved'};
  interactiveSection(sections,'workflow','Instructions',context('tui'));
  assert.deepEqual(sections,{existing:'Preserved',workflow:'Instructions'});
  interactiveSection(sections,'workflow','Instructions',context('tui',true));
  assert.deepEqual(sections,{existing:'Preserved'});
  sections.workflow='Stale';
  interactiveSection(sections,'workflow','Instructions',context('print'));
  assert.deepEqual(sections,{existing:'Preserved'});
});
