import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodemodeOutputItem, CodemodeResult } from "@earendil-works/pi-codemode";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
export async function outputFile(data: string | Buffer, extension: string): Promise<string> {
  const path=join(tmpdir(),"pi-workflow-"+randomUUID()+extension);
  await writeFile(path,data,{mode:0o600,flag:"wx"}); return path;
}
export async function formatOutput(result: CodemodeResult, error: string | undefined, tokens: number, generated: number) {
  const output: CodemodeOutputItem[]=[...result.output];
  if (result.ok && result.value !== undefined) output.push({type:"text",text:typeof result.value === "string" ? result.value : JSON.stringify(result.value)});
  const total=output.filter(item=>item.type === "text" && !item.console).length;
  const items: Array<TextContent | ImageContent>=[];
  const consoleLines: string[]=[];
  let index=0;
  for (const item of output) {
    if (item.type === "image") items.push(item);
    else if (item.console) consoleLines.push(item.text);
    else items.push({type:"text",text:total>1 ? "==> text "+(++index)+"/"+total+" <==\n"+item.text : item.text});
  }
  if (consoleLines.length) items.push({type:"text",text:"<console_output>\n"+consoleLines.join("\n")+"\n</console_output>"});
  if (error) items.push({type:"text",text:"Script error:\n"+error});
  if (generated && !items.some(item=>item.type === "image")) items.push({type:"text",text:"Note: models.generateImages() returned "+generated+" image(s) not shown. Show output image blocks with image(block)."});
  const combined=items.filter(item=>item.type === "text").map(item=>item.text).join("\n");
  const budget=tokens*4;
  let fullOutputPath: string | undefined;
  let truncated=items;
  if (combined.length>budget) {
    let note: string;
    try {fullOutputPath=await outputFile(combined,".txt");note="[Full output: "+fullOutputPath+" (read with offset/limit)]";}
    catch(error) {note="[Could not save full output: "+String(error)+"]";}
    const head=Math.floor(budget/2),tail=budget-head;
    truncated=[{type:"text",text:"Warning: truncated output (original token count: "+Math.ceil(combined.length/4)+")\n\n"+
      combined.slice(0,head)+"…"+Math.ceil((combined.length-budget)/4)+" tokens truncated…"+(tail?combined.slice(-tail):"")+"\n\n"+note},...items.filter(item=>item.type === "image")];
  }
  const content: Array<TextContent | ImageContent>=[];
  const images=new Map<string, string>();
  for (const item of truncated) {
    if (item.type === "image") {
      let path=images.get(item.data);
      let note: string;
      try {
        if (!path) {
          const extension=({"image/png":".png","image/jpeg":".jpg","image/gif":".gif","image/webp":".webp"} as Record<string,string>)[item.mimeType];
          if (!extension) throw new Error("Unsupported image type");
          path=await outputFile(Buffer.from(item.data,"base64"),extension);images.set(item.data,path);
        }
        note="[Image saved to "+path+"]";
      } catch(error) { note="[Image could not be saved: "+String(error)+"]"; }
      content.push({type:"text",text:note},item);
    } else {
      const previous=content.at(-1);
      if (previous?.type === "text") previous.text+="\n"+item.text; else content.push({...item});
    }
  }
  return {content,fullOutputPath};
}
