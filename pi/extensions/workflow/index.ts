import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestWorkflowAgentsAPI, type WorkflowAgentsAPI } from "../shared/workflow-agents.ts";
import { readSource } from "./source.ts";
import { executeWorkflow } from "./codemode-adapter.ts";
import { attachProgressWidget } from "./widget.ts";
import { renderWorkflowResult } from "./render.ts";
export default function workflowExtension(pi: ExtensionAPI):void {
  const active=new Set<AbortController>();
  let widgetAPI:WorkflowAgentsAPI|undefined,disposeWidget:(()=>void)|undefined;
  const cleanup=()=>{
    for (const controller of active) controller.abort(new Error("Workflow session invalidated"));
    disposeWidget?.();disposeWidget=undefined;widgetAPI=undefined;
  };
  pi.on("session_start",(_event,ctx)=>{
    cleanup();
    const api=requestWorkflowAgentsAPI(pi);
    if(api && ctx.mode === "tui"){widgetAPI=api;disposeWidget=attachProgressWidget(ctx,api);}
  });
  pi.on("session_shutdown",()=>cleanup());
  pi.on("session_tree",(_event,ctx)=>{
    cleanup();
    const api=requestWorkflowAgentsAPI(pi);
    if(api && ctx.mode === "tui"){widgetAPI=api;disposeWidget=attachProgressWidget(ctx,api);}
  });
  pi.registerTool({
    name:"workflow",label:"Workflow",exposure:"model-only",executionMode:"sequential",
    description:"Run a JS workflow file in the codemode sandbox with workflow helpers. Do not use workflow unless directed.",
    promptSnippet:"Run a directed JavaScript workflow file",
    promptGuidelines:["Do not use workflow unless directed.","Read the dynamic-workflows skill before authoring or changing workflows."],
    parameters:Type.Object({path:Type.String({minLength:1,description:"JS file path, relative to cwd or absolute"})},{additionalProperties:false}),
    async execute(_id,args,signal,onUpdate,ctx){
      if(!ctx)throw new Error("Workflow execution requires a session");
      const source=await readSource(args,ctx.cwd);
      const api=requestWorkflowAgentsAPI(pi);
      if(!api)throw new Error("Workflow requires an active subagents workspace capability");
      if(ctx.mode === "tui" && widgetAPI !== api){disposeWidget?.();widgetAPI=api;disposeWidget=attachProgressWidget(ctx,api);}
      const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
      signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
      active.add(controller);
      try{return await executeWorkflow(source.source,source.path,controller.signal,ctx,pi,api,onUpdate);}
      finally{active.delete(controller);signal?.removeEventListener("abort",abort);}
    },
    renderCall(args,theme){return new Text(theme.fg("toolTitle",theme.bold("workflow "))+theme.fg("muted",args.path ?? ""),0,0);},
    renderResult(result,options,theme){return renderWorkflowResult(result,options.expanded,theme);},
  });
}
