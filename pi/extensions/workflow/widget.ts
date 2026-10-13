import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgentsAPI, WorkflowProgress } from "../shared/workflow-agents.ts";
import type { WorkflowDetails, ProgressNode } from "./types.ts";
export function isDetails(value: unknown): value is WorkflowDetails {
  return !!value && typeof value === "object" && typeof (value as WorkflowDetails).id === "string" && Array.isArray((value as WorkflowDetails).nodes);
}
const clean=(value:string)=>value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,"").replace(/[\x00-\x1f\x7f-\x9f]/g," ");
const glyph=(node:ProgressNode)=>({pending:"○",queued:"◷",running:"●",completed:"✓",failed:"✗",cancelled:"×",skipped:"–"})[node.status];
export function progressLines(details: WorkflowDetails, expanded=false): string[] {
  const nodes=new Map(details.nodes.map(node=>[node.id,node]));
  const root=details.nodes[0];
  if (!root) return [];
  const lines: string[]=[];
  const pending=[{node:root,prefix:"",connector:""}];
  while(pending.length){
    const {node,prefix,connector}=pending.pop()!;
    let suffix="";
    if (node.kind === "sequence") {
      const active=node.activeStage === undefined ? undefined : nodes.get(node.children[node.activeStage]);
      const previous=node.previousStage === undefined ? undefined : nodes.get(node.children[node.previousStage]);
      suffix=(active ? " · active: "+clean(active.label) : "")+
        (previous && previous.id !== active?.id ? " · previous: "+clean(previous.label) : "");
    }
    lines.push(prefix+connector+glyph(node)+" "+clean(node.label)+(node.agentName?" · "+clean(node.agentName):"")+" · "+node.status+suffix);
    const visible=node.kind === "sequence" && !expanded ? node.children.filter((_,index)=>index === node.activeStage) : node.children;
    for(let index=visible.length-1;index>=0;index--){
      const child=nodes.get(visible[index]); if (!child) continue;
      const last=index === visible.length-1;
      pending.push({node:child,prefix:prefix.length >= 24 ? "… "+prefix.slice(-21) : prefix+(connector ? (connector === "└─ " ? "   " : "│  ") : ""),connector:last?"└─ ":"├─ "});
    }
  }
  return lines;
}
export class ProgressComponent implements Component {
  private key="";
  private lines: string[]=[];
  private epoch=0;
  /** Useful for deterministic cache regression tests. */
  layouts=0;
  constructor(private snapshots:()=>readonly WorkflowProgress[],private theme?:Theme,private maxRows=12,private expanded=false) {}
  invalidate():void {this.epoch++;this.key="";}
  render(width:number):string[] {
    const snapshots=this.snapshots().filter(snapshot=>isDetails(snapshot.details));
    const key=width+"|"+this.epoch+"|"+snapshots.map(snapshot=>snapshot.owner+":"+ (snapshot.details as WorkflowDetails).id+":"+(snapshot.details as WorkflowDetails).revision).join("|");
    if(key===this.key)return this.lines;
    this.layouts++;
    const all=snapshots.flatMap(snapshot=>[
      "Workflow · "+clean(snapshot.owner),
      ...progressLines(snapshot.details as WorkflowDetails,this.expanded),
    ]);
    const visible=all.length>this.maxRows ? [...all.slice(0,Math.max(0,this.maxRows-1)),"… "+(all.length-this.maxRows+1)+" more progress rows"] : all;
    this.lines=visible.map(line=>truncateToWidth(this.theme ? this.theme.fg("muted",line) : line,Math.max(0,width),""));
    this.key=key;return this.lines;
  }
}
export function attachProgressWidget(ctx:ExtensionContext,api:WorkflowAgentsAPI):()=>void {
  if (ctx.mode !== "tui") return ()=>{};
  let disposed=false, installed=false;
  let requestRender:(()=>void)|undefined;
  const update=()=>{
    if (disposed) return;
    const active=api.getProgress().some(snapshot=>isDetails(snapshot.details) && ["pending","queued","running"].includes(snapshot.details.status));
    if (active && !installed) {
      installed=true;
      ctx.ui.setWidget("workflow-progress",(tui,theme)=>{
        requestRender=()=>tui.requestRender();
        const themed=new ProgressComponent(()=>api.getProgress(),theme);
        // Host snapshots are revisioned; spinner redraws reuse the previous layout.
        return themed;
      },{placement:"aboveEditor"});
    } else if (!active && installed) {
      installed=false;ctx.ui.setWidget("workflow-progress",undefined);requestRender=undefined;
    }
    requestRender?.();
  };
  const unsubscribe=api.subscribeProgress(update);update();
  return ()=>{disposed=true;unsubscribe();if(installed)ctx.ui.setWidget("workflow-progress",undefined)};
}
