const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,writeFile,symlink,mkdir,rm}=require('node:fs/promises');
const {tmpdir,homedir}=require('node:os');
const {join}=require('node:path');
const {load}=require('./test-helper.cjs');
test('strict path-only model-only sequential tool',async()=>{
 const {default:extension}=await load('index.ts');
 const tools=[],events=[];
 extension({registerTool:tool=>tools.push(tool),on:(...args)=>events.push(args)});
 assert.equal(tools[0].name,'workflow');assert.equal(tools[0].exposure,'model-only');assert.equal(tools[0].executionMode,'sequential');
 assert.equal(tools[0].parameters.additionalProperties,false);
 assert.deepEqual(Object.keys(tools[0].parameters.properties),['path']);
 assert.match(tools[0].description,/Do not use workflow unless directed/);
});
test('source regular JS relative absolute symlink and strict input limits',async()=>{
 const {readSource}=await load('source.ts'),dir=await mkdtemp(join(tmpdir(),'workflow-source-'));
 try{
  await writeFile(join(dir,'body.js'),'return 4');
  await symlink(join(dir,'body.js'),join(dir,'link.js'));
  assert.equal((await readSource({path:'body.js'},dir)).source,'return 4');
  assert.equal((await readSource({path:join(dir,'link.js')},'/')).source,'return 4');
  for(const value of [{}, {path:''},{path:'body.js',extra:1},{path:'body.txt'},{path:'missing.js'}])await assert.rejects(readSource(value,dir));
  await mkdir(join(dir,'directory.js'));await assert.rejects(readSource({path:'directory.js'},dir),/regular/);
  if(process.platform !== 'win32'){require('node:child_process').execFileSync('mkfifo',[join(dir,'pipe.js')]);await assert.rejects(readSource({path:'pipe.js'},dir),/regular/);}
  await writeFile(join(dir,'big.js'),' '.repeat(1024*1024+1));await assert.rejects(readSource({path:'big.js'},dir),/1 MiB/);
  const tilde=join(homedir(),'.pi-workflow-test-'+process.pid+'.js');await writeFile(tilde,'return 2');
  try{assert.equal((await readSource({path:'~/'+tilde.split('/').at(-1)},'/')).path,tilde)}finally{await rm(tilde)}
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('missing workspace capability fails clearly without unmanaged agents',async()=>{
 const {default:extension}=await load('index.ts'),dir=await mkdtemp(join(tmpdir(),'workflow-capability-'));
 let tool;
 extension({registerTool:value=>tool=value,on:()=>{},events:{emit:()=>{}}});
 try{await writeFile(join(dir,'a.js'),'return 1');await assert.rejects(tool.execute('id',{path:'a.js'},undefined,undefined,{cwd:dir,mode:'print'}),/workspace capability/)}
 finally{await rm(dir,{recursive:true,force:true})}
});
