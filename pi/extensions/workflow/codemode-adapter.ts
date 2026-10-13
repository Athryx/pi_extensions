/**
 * Pi 1.1.0 compatibility glue using only public sandbox and SDK APIs.
 * The private built-in execute helper is deliberately not imported.
 */
import { CodemodeSandbox, parseCodemodeSource, toCodemodeIdentifier, type CodemodeTool, type CodemodeResult, type CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import type { ExtensionAPI, ExtensionToolContext, AgentToolUpdateCallback, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgentsAPI } from "../shared/workflow-agents.ts";
import { WorkflowRun } from "./run.ts";
import { runtimeSource, mapStack } from "./runtime-source.ts";
import { discoveryGlobals, toolSample } from "./discovery.ts";
import { modelExecutor, MODEL_METHODS } from "./models.ts";
import { emptyUsage, addUsage } from "./types.ts";
import { formatOutput } from "./output.ts";
export function readStore(branch: readonly unknown[]): Record<string,unknown> {
  const store=new Map<string,unknown>();
  for (const raw of branch) {
    const entry=raw as {type?: string;customType?: string;data?:{set?:unknown;delete?:unknown}};
    if (entry.type !== "custom" || entry.customType !== "codemode-store") continue;
    const data=entry.data;
    if (!data?.set || typeof data.set !== "object" || Array.isArray(data.set) ||
        !Array.isArray(data.delete) || !data.delete.every(key=>typeof key === "string")) continue;
    for (const key of data.delete) store.delete(key);
    for (const [key,value] of Object.entries(data.set)) store.set(key,value);
  }
  return Object.fromEntries(store);
}
export async function executeWorkflow(source: string, sourcePath: string, signal: AbortSignal,
  ctx: ExtensionToolContext, pi: Pick<ExtensionAPI,"getAllTools"|"appendEntry">, api: WorkflowAgentsAPI,
  onUpdate?: AgentToolUpdateCallback) {
  const start=performance.now(), parsed=parseCodemodeSource(source);
  const metadata: readonly ToolInfo[]=pi.getAllTools();
  const callable=ctx.tools.filter(tool=>tool.name !== "workflow" && tool.name !== "codemode");
  const usage=emptyUsage(), shown={generated:0}, models=modelExecutor(ctx,usage,shown);
  const toolExecutor=async(name:string,args:unknown,active:AbortSignal)=>{
    const tool=callable.find(tool=>tool.name === name || toCodemodeIdentifier(tool.name) === name);
    if (!tool) throw new Error("Tool is not available: "+name);
    const outcome=await ctx.executeTool(tool.name,args,{signal:active});
    const result=outcome.result;
    if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
    const text=result.content.filter(block=>block.type === "text").map(block=>block.text).join("\n");
    if (outcome.isError) throw new Error(text || "Tool "+tool.name+" failed");
    if (tool.name === "read") {
      const image=result.content.find(block=>block.type === "image");
      if (image) return {...image,note:text};
    }
    return text;
  };
  const host=api.openRun({sourcePath,signal});
  const run=new WorkflowRun(host,signal,sourcePath,details=>onUpdate?.({content:[],details}),toolExecutor,models);
  const tools: CodemodeTool[]=callable.map(tool=>{
    const declaration: CodemodeTool={
      name:tool.name,description:tool.description,inputSchema:tool.parameters as CodemodeJsonSchema,
      outputSchema:(tool.outputSchema as CodemodeJsonSchema | undefined) ?? {type:"string"},
      execute:(args,{signal})=>run.dispatch({op:"tool",scope:run.progress.root,name:tool.name,args},signal),
    };
    declaration.description=toolSample(declaration,metadata.find(info=>info.name === tool.name)); return declaration;
  });
  const globals: CodemodeTool[]=[
    ...discoveryGlobals(tools,metadata),
    ...MODEL_METHODS.map(name=>({name:"models."+name,spread:true,execute:(args:unknown,{signal}: {signal:AbortSignal})=>run.dispatch({op:"model",scope:run.progress.root,name,args},signal)})),
    {name:"__workflowHost",execute:(args,{signal})=>run.dispatch(args,signal)},
  ];
  const names=[...new Set(tools.flatMap(tool=>[tool.name,toCodemodeIdentifier(tool.name)]))];
  const prefix=runtimeSource(run.progress.root,names,MODEL_METHODS);
  const prefixLines=prefix.split("\n").length-1;
  const sandbox=new CodemodeSandbox({tools,globals,timeoutMs:parsed.options.timeoutMs ?? Infinity,memoryLimitBytes:256*1024*1024});
  let result: CodemodeResult;
  try { result=await sandbox.execute(prefix+parsed.code,{signal,store:readStore(ctx.sessionManager.getBranch())}); }
  catch(error) {result={ok:false,error:{kind:"sandbox",message:String(error)},output:[],calls:[]};}
  finally { await sandbox.close(); }
  const cancelledResult = (value: CodemodeResult): CodemodeResult => ({
    ok:false,error:{kind:"aborted",message:signal.reason instanceof Error ? signal.reason.message : "Workflow aborted"},
    output:value.output,calls:value.calls,
  });
  if(result.ok && signal.aborted)result=cancelledResult(result);
  await run.close(result.ok ? "completed" : result.error.kind === "aborted" ? "cancelled" : "failed",
    result.ok ? undefined : result.error.message);
  // Lifecycle invalidation can race host cleanup after the VM has already returned.
  if(result.ok && signal.aborted){result=cancelledResult(result);run.progress.terminal(run.progress.root,"cancelled");}
  addUsage(usage,run.usage);
  if (result.ok && (Object.keys(result.storeWrites.set).length || result.storeWrites.delete.length))
    pi.appendEntry("codemode-store",result.storeWrites);
  let error: string | undefined;
  if (!result.ok) {
    error=mapStack(result.error.stack ?? result.error.message,sourcePath,prefixLines);
    error+="\n\nTool calls made before failure (not undone): "+(result.calls.map(call=>call.name+" ("+call.status+")").join(", ") || "none");
  }
  const formatted=await formatOutput(result,error,parsed.options.maxOutputTokens ?? 10000,shown.generated);
  return {
    content:[{type:"text" as const,text:(result.ok ? "Script completed" : "Script failed")+"\nWall time "+((performance.now()-start)/1000).toFixed(1)+" seconds\nSource: "+sourcePath+"\nOutput:\n"},...formatted.content],
    details:{...run.progress.snapshot(),...(formatted.fullOutputPath ? {fullOutputPath:formatted.fullOutputPath} : {})},
    ...(usage.totalTokens || usage.cost.total ? {usage} : {}),
    ...(!result.ok ? {isError:true} : {}),
  };
}
