import { renderToolSample, toCodemodeIdentifier, type CodemodeTool } from "@earendil-works/pi-codemode";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { record, string } from "./types.ts";
export function toolSample(tool: CodemodeTool, info?: ToolInfo): string {
  return renderToolSample({...tool,description:[tool.description,...(info?.promptGuidelines ?? [])].filter(Boolean).join("\n")});
}
function namespaceMatches(name: string, query: string): boolean {
  return name === query || toCodemodeIdentifier(name) === query || name.split("__").at(-1) === query || toCodemodeIdentifier(name).split("__").at(-1) === query;
}
const words=(text:string):string[]=>text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
/** Local BM25 formatting/search glue for Pi 1.1.0; no private host imports. */
export function discoveryGlobals(tools: CodemodeTool[], metadata: readonly ToolInfo[]): CodemodeTool[] {
  const entry=(tool:CodemodeTool)=>({name:toCodemodeIdentifier(tool.name),description:tool.description ?? ""});
  const info=(tool:CodemodeTool)=>metadata.find(item=>item.name === tool.name);
  return [
    {name:"describeTool",spread:true,execute:raw=>{
      if (!Array.isArray(raw) || raw.length !== 1) throw new Error("Expected a tool name");
      const name=string(raw[0],"name");
      return tools.find(tool=>tool.name === name || toCodemodeIdentifier(tool.name) === name)?.description;
    }},
    {name:"describeNamespace",spread:true,execute:raw=>{
      if (!Array.isArray(raw) || raw.length !== 1) throw new Error("Expected a namespace name");
      const name=string(raw[0],"name");
      const members=tools.filter(tool=>{const ns=info(tool)?.namespace;return ns && namespaceMatches(ns.name,name)});
      const ns=members.length ? info(members[0])?.namespace : undefined;
      return ns ? {...ns,tools:members.map(tool=>toCodemodeIdentifier(tool.name))} : undefined;
    }},
    {name:"searchTools",spread:true,execute:raw=>{
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2 || typeof raw[0] !== "string") throw new Error("Expected query and optional search options");
      const options=raw[1] == null ? {} : record(raw[1],["limit","namespace"]);
      const limit=options.limit ?? 8;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
      const namespace=options.namespace == null ? undefined : string(options.namespace,"namespace");
      const candidates=tools.filter(tool=>!namespace || (!!info(tool)?.namespace && namespaceMatches(info(tool)!.namespace!.name,namespace)));
      const documents=candidates.map(tool=>words(tool.name+" "+(tool.description ?? "")+" "+(info(tool)?.namespace?.description ?? "")));
      const average=documents.reduce((sum,d)=>sum+d.length,0)/Math.max(1,documents.length);
      const terms=words(raw[0]);
      const scored=candidates.map((tool,index)=>{
        const doc=documents[index]; let score=0;
        for (const term of terms) {
          const frequency=doc.filter(word=>word === term).length;
          const count=documents.filter(d=>d.includes(term)).length;
          const idf=Math.log(1+(documents.length-count+0.5)/(count+0.5));
          score+=idf*frequency*2.2/(frequency+1.2*(0.25+0.75*doc.length/(average||1)));
        }
        return {tool,score,index};
      });
      return scored.filter(item=>item.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,limit).map(item=>entry(item.tool));
    }},
  ];
}
