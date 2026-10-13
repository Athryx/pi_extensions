import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, extname } from "node:path";
import { homedir } from "node:os";
import { record, string } from "./types.ts";
export async function readSource(input: unknown, cwd: string): Promise<{path:string;source:string}> {
  const data=record(input,["path"]);
  let path=string(data.path,"path");
  if (path === "~" || path.startsWith("~/")) path=homedir()+path.slice(1);
  path=resolve(cwd,path);
  if (extname(path) !== ".js") throw new Error("Workflow source must be a .js file: "+path);
  // Nonblocking open prevents a misleading .js FIFO/device from hanging before fstat.
  const file=await open(path,constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat=await file.stat();
    if (!stat.isFile()) throw new Error("Workflow source must be a regular file: "+path);
    if (stat.size>1024*1024) throw new Error("Workflow source exceeds 1 MiB: "+path);
    // Bounded read from the same descriptor also catches concurrent file growth.
    const data=Buffer.alloc(1024*1024+1);
    let offset=0;
    while(offset<data.length) {
      const {bytesRead}=await file.read(data,offset,data.length-offset,null);
      if (!bytesRead) break;
      offset+=bytesRead;
    }
    if (offset>1024*1024) throw new Error("Workflow source exceeds 1 MiB: "+path);
    return {path,source:data.subarray(0,offset).toString("utf8")};
  } finally {await file.close();}
}
