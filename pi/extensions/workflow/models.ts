import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierContext, ImagesContext, ModelType, Usage } from "@earendil-works/pi-ai";
import { addUsage, record, string } from "./types.ts";
export const MODEL_METHODS = ["getModelsOfType","getAvailableOfType","getModelOfType","classify","generateImages"];
function modelType(value: unknown): ModelType {
  if (value !== "chat" && value !== "image" && value !== "classifier") throw new Error("Unknown model type");
  return value;
}
function provider(value: unknown): string | undefined {
  return value == null ? undefined : string(value,"provider");
}
function sanitize<T extends object>(model: T): Omit<T,"headers"> {
  const result={...model}; delete (result as Record<string,unknown>).headers; return result;
}
function image(value: unknown): void {
  const data=record(value,["type","data","mimeType"]);
  if (data.type !== "image") throw new Error("Expected image block");
  string(data.data,"data"); string(data.mimeType,"mimeType");
}
export function classifierContext(value: unknown): ClassifierContext {
  const context=record(value,["state","images","questions"]);
  if (!context.state || typeof context.state !== "object" || Array.isArray(context.state)) throw new Error("Classifier state must be an object");
  if (context.images !== undefined) {
    if (!Array.isArray(context.images)) throw new Error("images must be an array");
    context.images.forEach(image);
  }
  if (!context.questions || typeof context.questions !== "object" || Array.isArray(context.questions) || !Object.keys(context.questions).length)
    throw new Error("Classifier questions must be a non-empty object");
  for (const value of Object.values(context.questions)) {
    const q=record(value,["type","instructions","criteria"]); if(typeof q.instructions !== "string") throw new Error("instructions must be a string");
    const strings=(v: unknown[])=>v.length && v.every(x=>typeof x === "string");
    if (q.type === "score") {
      if (!Array.isArray(q.criteria) || !strings(q.criteria)) throw new Error("Score criteria must be strings");
    } else if (q.type === "choice") {
      if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria) || !strings(Object.values(q.criteria))) throw new Error("Choice criteria must map labels to strings");
    } else if (q.type === "bool") {
      const criteria=record(q.criteria,["true","false"]);
      if (typeof criteria.true !== "string" || typeof criteria.false !== "string") throw new Error("Bool criteria require true/false strings");
    } else throw new Error("Unknown classifier question type");
  }
  return context as unknown as ClassifierContext;
}
export function imagesContext(value: unknown): ImagesContext {
  const context=record(value,["input"]);
  if (!Array.isArray(context.input) || !context.input.length) throw new Error("Image context input must be non-empty");
  for (const value of context.input) {
    if (value?.type === "text") {
      const block=record(value,["type","text"]); if(typeof block.text !== "string") throw new Error("text must be a string");
    } else image(value);
  }
  return context as unknown as ImagesContext;
}
/** FIFO cancellable admission: at most four active non-LLM calls, including scoped calls. */
class ModelLimiter {
  private active=0;
  private waiting: Array<()=>void>=[];
  async run<T>(signal: AbortSignal, work:()=>Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= 4 || this.waiting.length) {
      await new Promise<void>((resolve,reject)=>{
        const wake=()=>{signal.removeEventListener("abort",abort);this.active++;resolve()};
        const abort=()=>{const index=this.waiting.indexOf(wake);if(index>=0)this.waiting.splice(index,1);reject(signal.reason)};
        this.waiting.push(wake); signal.addEventListener("abort",abort,{once:true});
        if (signal.aborted) abort();
      });
    } else this.active++;
    try { signal.throwIfAborted(); return await work(); }
    finally { this.active--;this.waiting.shift()?.(); }
  }
}
export function modelExecutor(ctx: ExtensionToolContext, usage: Usage, shown: {generated: number}) {
  const limiter=new ModelLimiter(), registry=ctx.modelRegistry;
  return async (name: string, raw: unknown, signal: AbortSignal): Promise<unknown> => {
    if (!MODEL_METHODS.includes(name) || !Array.isArray(raw)) throw new Error("Invalid model operation");
    signal.throwIfAborted();
    const [first, second, third]=raw;
    if (name === "getModelsOfType" || name === "getAvailableOfType") {
      if (raw.length > 2) throw new Error("Unexpected model arguments");
      const type=modelType(first), p=provider(second);
      const models=name === "getModelsOfType" ? registry.getModelsOfType(type,p) : await registry.getAvailableOfType(type,p,{signal});
      return models.map(sanitize);
    }
    if (name === "getModelOfType") {
      if (raw.length !== 3) throw new Error("Expected type, provider, id");
      const model=registry.getModelOfType(modelType(first),string(second,"provider"),string(third,"id"));
      return model ? sanitize(model) : undefined;
    }
    if (raw.length !== 2 || !first || typeof first !== "object" || Array.isArray(first)) throw new Error("Expected model and context");
    // Extra catalog fields are intentionally ignored; never pass script URLs/headers to host credentials.
    const p=string(first.provider,"provider"), id=string(first.id,"id");
    if (name === "classify") {
      const model=registry.getModelOfType("classifier",p,id);
      if (!model) throw new Error("Unknown classifier model " + p + "/" + id);
      const context=classifierContext(second);
      return limiter.run(signal,async()=>{
        const result=await registry.classify(model,context,{signal}); addUsage(usage,result.usage); return result;
      });
    }
    const model=registry.getModelOfType("image",p,id);
    if (!model) throw new Error("Unknown image model " + p + "/" + id);
    const context=imagesContext(second);
    return limiter.run(signal,async()=>{
      const result=await registry.generateImages(model,context,{signal});
      addUsage(usage,result.usage); shown.generated+=result.output.filter(block=>block.type === "image").length;
      return result;
    });
  };
}
