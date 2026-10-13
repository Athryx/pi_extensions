const test=require('node:test');
const assert=require('node:assert/strict');
const {load,fixture,root}=require('./test-helper.cjs');
const {join}=require('node:path');
const {pathToFileURL}=require('node:url');
test('fake non-LLM registry only host-resolved credentials, redacted catalog and usage',async()=>{
 const {executeWorkflow}=await load('codemode-adapter.ts');
 const model={provider:'test',id:'classifier',headers:{Authorization:'secret'},baseUrl:'https://trusted',input:['text']};
 let invoked;
 const registry={
  getModelsOfType:()=>[model],
  getAvailableOfType:async()=>[model],
  getModelOfType:(type,p,id)=>type==='classifier'&&p==='test'&&id==='classifier'?model:undefined,
  async classify(resolved,context,{signal}){assert.strictEqual(resolved,model);assert.equal(resolved.baseUrl,'https://trusted');assert.equal(signal.aborted,false);invoked=context;
   return {answers:{ok:{type:'bool',probability:1}},stopReason:'stop',usage:{input:2,output:3,totalTokens:5,cost:{total:0.2}}}}
 };
 const f=fixture({models:registry});
 const result=await executeWorkflow(`
 const catalog=await models.getAvailableOfType("classifier");
 text(catalog);
 return await workflow.sequence([async(_,w)=>w.models.classify({provider:"test",id:"classifier",baseUrl:"https://evil",headers:{Auth:"evil"}},
  {state:{safe:true},questions:{ok:{type:"bool",instructions:"Check",criteria:{true:"yes",false:"no"}}}})]);`,
 '/models.js',new AbortController().signal,f.ctx,f.pi,f.api);
 const text=result.content.map(c=>c.text).join('\n');
 assert.equal(result.isError,undefined);assert.doesNotMatch(text,/Authorization|secret/);assert.match(text,/"probability":1/);
 assert.deepEqual(invoked.state,{safe:true});assert.equal(result.usage.totalTokens,5);assert.equal(result.usage.cost.total,0.2);
});
test('models limiter max four across root and branch scoped calls; no paid provider',async()=>{
 const {executeWorkflow}=await load('codemode-adapter.ts');
 const model={provider:'test',id:'image',input:['text']};
 let active=0,max=0,count=0;
 const f=fixture({models:{
  getModelOfType:()=>model,
  async generateImages(resolved,context,{signal}){
   active++;max=Math.max(max,active);count++;
   await new Promise(resolve=>setTimeout(resolve,15));active--;
   return {output:[{type:'text',text:'fake'}],stopReason:'stop'};
  },
 }});
 const result=await executeWorkflow(`
 return await workflow.parallel(Array.from({length:9},()=>async w=>w.models.generateImages({provider:"test",id:"image"},{input:[{type:"text",text:"fake"}]})));
 `,'/models.js',new AbortController().signal,f.ctx,f.pi,f.api);
 assert.equal(result.isError,undefined);assert.equal(max,4);assert.equal(count,9);
});
test('parallel cancels active and queued scoped model calls and allows fallback',async()=>{
 const {executeWorkflow}=await load('codemode-adapter.ts');
 let active=0,stopped=0;
 const f=fixture({models:{getModelOfType:()=>({provider:'test',id:'image'}),
  async generateImages(model,context,{signal}){active++;return new Promise(resolve=>{
   const done=()=>{stopped++;resolve({output:[],stopReason:'aborted'})};
   signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
  })},
 }});
 const result=await executeWorkflow(`
 try{await workflow.parallel([
  ...Array.from({length:8},()=>async w=>w.models.generateImages({provider:"test",id:"image"},{input:[{type:"text",text:"fake"}]})),
  async w=>{await w.set_status("Fail branch");throw Error("stop")}
 ])}catch(e){text(e.message)}return "fallback";
 `,'/models.js',new AbortController().signal,f.ctx,f.pi,f.api);
 assert.equal(result.isError,undefined);assert.ok(active<=4);assert.equal(stopped,active);assert.match(result.content.map(c=>c.text).join(''),/fallback/);
});
test('public installed built-in codemode parity for output/store/nested results',async()=>{
 const {createCodemodeExtension}=await import(pathToFileURL(join(root,'dist/index.js')).href);
 const {executeWorkflow}=await load('codemode-adapter.ts');
 for(const mode of ['on','only']){
  const f=fixture({tools:[{name:'demo',description:'Read demo',parameters:{type:'object'},outputSchema:{type:'object'}}],
   executeTool:async()=>({toolCall:{id:'nested'},isError:false,result:{content:[{type:'text',text:'text'}],structuredContent:{ok:1}}})});
  let builtin;
  createCodemodeExtension({mode,models:false})({...f.pi,registerTool:tool=>builtin=tool});
  const source='text("before");console.log("hello",2);store("key",{a:1});return await tools.demo({})';
  const direct=await builtin.execute('builtin',{code:source},new AbortController().signal,undefined,f.ctx);
  const workflow=await executeWorkflow(source,'/parity.js',new AbortController().signal,f.ctx,f.pi,f.api);
  assert.equal(direct.isError,workflow.isError);
  assert.deepEqual(direct.content.slice(1),workflow.content.slice(1));
  assert.deepEqual(f.entries.map(e=>e.data),[{set:{key:{a:1}},delete:[]},{set:{key:{a:1}},delete:[]}]);
 }
});
