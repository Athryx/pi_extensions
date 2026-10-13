import { Text, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { progressLines, isDetails } from "./widget.ts";
import type { WorkflowDetails } from "./types.ts";
class ResultComponent implements Component {
  private lines: string[]=[];
  private width=-1;
  private text?:Text;
  constructor(private plain:string,private theme:Theme) {}
  setTheme(theme:Theme):void {if(theme !== this.theme){this.theme=theme;this.invalidate()}}
  invalidate():void {this.width=-1;this.text=undefined}
  render(width:number):string[] {
    if(this.width===width)return this.lines;
    this.text ??= new Text(this.theme.fg("toolOutput",this.plain),0,0);
    this.lines=this.text.render(width);this.width=width;return this.lines;
  }
}
const cache=new WeakMap<WorkflowDetails,Map<string,ResultComponent>>();
export function renderWorkflowResult(result:{content: readonly {type:string;text?:string}[];details?:unknown},expanded:boolean,theme:Theme):Component {
  const details=result.details;
  if (!isDetails(details)) return new Text(theme.fg("toolOutput",result.content.filter(item=>item.type === "text").map(item=>item.text ?? "").join("\n")),0,0);
  let entries=cache.get(details);if(!entries){entries=new Map();cache.set(details,entries)}
  const key=details.revision+"|"+expanded;
  const cached=entries.get(key);if(cached){cached.setTheme(theme);return cached}
  const summary="Workflow · "+details.sourcePath+" · "+details.status;
  const body=expanded ? [summary,...progressLines(details,true),...result.content.filter(item=>item.type === "text").map(item=>item.text ?? "")].join("\n") : [summary,...progressLines(details).slice(1,4)].join("\n");
  const component=new ResultComponent(body,theme);
  if(entries.size>=2)entries.clear();
  entries.set(key,component);return component;
}
