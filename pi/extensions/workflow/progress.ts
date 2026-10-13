import { label, type NodeKind, type NodeStatus, type ProgressNode, type WorkflowDetails } from "./types.ts";
export class Progress {
  private nodes = new Map<string, ProgressNode>();
  private counter = 0;
  revision = 0;
  readonly root: string;
  constructor(readonly id: string, readonly sourcePath: string, private publish: (details: WorkflowDetails) => void) {
    this.root = this.add(undefined, "workflow", "Workflow");
    this.mutate(this.root, {status:"running",startedAt:Date.now()});
  }
  add(parent: string | undefined, kind: NodeKind, name: string): string {
    if (this.nodes.size >= 10000) throw new Error("Workflow progress node limit (10000) exceeded");
    const id = this.id + "/" + this.counter++;
    this.nodes.set(id, {id,parent,kind,label:label(name,kind),status:"pending",children:[]});
    if (parent) this.get(parent).children.push(id);
    this.revision++;
    return id;
  }
  get size(): number { return this.nodes.size; }
  mutateMany(updates: Array<[string, Partial<ProgressNode>]>): void {
    for (const [id,update] of updates) Object.assign(this.get(id),update);
    if(updates.length){this.revision++;this.emit();}
  }
  get(id: string): ProgressNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error("Unknown workflow scope");
    return node;
  }
  mutate(id: string, update: Partial<ProgressNode>): void {
    Object.assign(this.get(id), update); this.revision++; this.emit();
  }
  isBelow(id: string, ancestor: string): boolean {
    for (let node: ProgressNode | undefined = this.get(id); node; node = node.parent ? this.get(node.parent) : undefined)
      if (node.id === ancestor) return true;
    return false;
  }
  snapshot(): WorkflowDetails {
    return {id:this.id,sourcePath:this.sourcePath,revision:this.revision,status:this.get(this.root).status,
      nodes:[...this.nodes.values()].map(node=>({...node,children:[...node.children]}))};
  }
  emit(): void { this.publish(this.snapshot()); }
  terminal(id: string, status: NodeStatus): void {
    this.mutate(id, {status,endedAt:Date.now()});
  }
}
