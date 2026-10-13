const {realpathSync,mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {dirname,resolve,join}=require('node:path');
const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const root=resolve(dirname(realpathSync(execFileSync('which',['pi'],{encoding:'utf8'}).trim())),'../..');
const esbuild=require(require.resolve('esbuild',{paths:[root]}));
const output=mkdtempSync(join(tmpdir(),'pi-workflow-tests-'));
let sequence=0;
process.on('exit',()=>rmSync(output,{recursive:true,force:true}));
async function load(file){
  const built=await esbuild.build({entryPoints:[join(__dirname,file)],bundle:true,platform:'node',format:'esm',write:false,
    plugins:[{name:'host',setup(build){build.onResolve({filter:/^(@earendil-works\/pi-|typebox)/},async args=>{
      if(args.pluginData?.skip)return;
      const path=args.path === '@earendil-works/pi-coding-agent' ? join(root,'dist/index.js') :
        (await build.resolve(args.path,{kind:'import-statement',resolveDir:args.path.startsWith('@earendil-works/pi-codemode') ? __dirname : root,pluginData:{skip:true}})).path;
      return {path,external:true};
    });}}]});
  const path=join(output,++sequence+'.mjs');writeFileSync(path,built.outputFiles[0].text);
  return import(pathToFileURL(path).href);
}
function fixture(options={}){
  const entries=[],calls=[],progress=[],agents=[],agentCalls=[],updates=[];
  let callback,closeCount=0,counter=0;
  const listeners=new Set();
  const host={id:'fixture-run',async registerAgents(definitions){agents.push(...definitions)},
    async agent(prompt,template,name,signal,onUpdate){
      const generated=(name ?? template)+'-'+(++counter);agentCalls.push({prompt,template,name:generated});
      onUpdate?.({name:generated,groupId:'group-'+counter,status:'queued'});
      if(options.agent)return options.agent(prompt,template,generated,signal,onUpdate);
      onUpdate?.({name:generated,groupId:'group-'+counter,status:'running'});
      return {name:generated,text:prompt};
    },
    updateProgress(details){callback=details;progress.push(details);for(const listener of listeners)listener()},
    async close(){closeCount++;callback=undefined;for(const listener of listeners)listener()},
  };
  const api={version:1,openRun(){return host},getProgress(){return callback?[{id:host.id,owner:'main',details:callback}]:[]},
    subscribeProgress(listener){listeners.add(listener);return()=>listeners.delete(listener)}};
  const tools=options.tools ?? [];
  const ctx={cwd:process.cwd(),mode:'print',hasUI:false,tools,sessionManager:{getBranch:()=>entries},modelRegistry:options.models ?? {},
    async executeTool(name,args,{signal}){calls.push({name,args,signal});if(options.executeTool)return options.executeTool(name,args,signal);
      return {toolCall:{id:'nested'},isError:false,result:{content:[{type:'text',text:JSON.stringify(args)}],details:undefined}}}};
  const pi={getAllTools:()=>options.metadata ?? tools,appendEntry(type,data){entries.push({type:'custom',customType:type,data})}};
  return {api,ctx,pi,entries,calls,progress,agents,agentCalls,updates,get closeCount(){return closeCount},onUpdate:update=>updates.push(update)};
}
module.exports={load,root,fixture};
