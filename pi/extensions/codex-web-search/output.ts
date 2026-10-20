export const SEARCH_MESSAGE = "codex-web-search.results.v1";
export interface Source { title: string; url: string }
export type SearchOperation = ({ type: "search"; query: string } | { type: "open_page"; url: string } | { type: "find_in_page"; url: string; pattern: string }) & { status?: string };
export interface SearchDetails { mode: "live" | "cached"; actions: string[]; operations?: SearchOperation[]; sources: Source[]; outcome: "completed" | "aborted" | "error" }
interface Annotation extends Source { start?: number; end?: number }
interface Part { text: string; annotations: Annotation[] }
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const clean = (value: string): string => value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const short = (value: unknown, length = 1000): string => typeof value === "string" ? clean(value).slice(0, length) : "";
export function source(value: unknown): Source | undefined {
  const item = object(value);
  if (typeof item.url !== "string" || item.url.length > 8192 || /[\s\x00-\x1f\x7f]/.test(item.url)) return;
  try {
    const url = new URL(item.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    return { url: url.href, title: short(item.title, 300) || url.hostname };
  } catch { return; }
}
const label = (text: string) => text.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
export const sourceLink = (item: Source) => `[${label(item.title)}](<${item.url.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`;

function annotated(part: Part): string {
  let text = part.text;
  let boundary = text.length;
  const ordered = part.annotations.filter(a => Number.isInteger(a.start) && Number.isInteger(a.end))
    .sort((a, b) => b.start! - a.start!);
  for (const annotation of ordered) {
    const { start, end } = annotation;
    if (start! < 0 || end! < start! || end! > boundary) continue;
    const original = text.slice(start, end);
    // Citation offsets generally cover a provider marker, but may cover ordinary prose.
    const replacement = /^(?:\s*cite[\s\S]*?\s*|\s*\[\d+\]\s*|\s*)$/.test(original)
      ? sourceLink(annotation) : `${original} ${sourceLink(annotation)}`;
    text = text.slice(0, start) + replacement + text.slice(end);
    boundary = start!;
  }
  return text;
}

/** Bounded, request-local metadata. Never retain full provider response envelopes. */
export class SearchCapture {
  readonly actions = new Set<string>();
  readonly sources = new Map<string, Source>();
  readonly messages = new Map<string, Part[]>();
  readonly calls = new Map<string, string>();
  private operations = new Map<string, SearchOperation[]>();
  private textSize = 0;
  sawSearch = false;

  private addSource(value: unknown): Source | undefined {
    const item = source(value);
    if (item && (this.sources.has(item.url) || this.sources.size < 50)) this.sources.set(item.url, item);
    return item;
  }
  private item(value: unknown): void {
    const item = object(value);
    if (item.type === "web_search_call") {
      this.sawSearch = true;
      const action = object(item.action);
      const queries = Array.isArray(action.queries) ? action.queries.slice(0, 20) : [action.query];
      const descriptions = action.type === "open_page" ? [`Open ${short(action.url)}`]
        : action.type === "find_in_page" ? [`Find ${short(action.pattern)} in ${short(action.url)}`]
        : queries.filter(q => typeof q === "string").map(q => short(q));
      for (const description of descriptions) if (description && this.actions.size < 20) this.actions.add(description);
      // Keep action identity separate from source/citation URLs: a search hit is
      // not evidence that the model opened that page. Repeated stream snapshots
      // update a call's operations instead of creating duplicate display rows.
      if (typeof item.id === "string" && (this.operations.has(item.id) || this.operations.size < 50)) {
        if (!this.operations.has(item.id)) this.operations.set(item.id, []);
        const status = short(item.status, 40) || undefined;
        const operations: SearchOperation[] = [];
        if (action.type === "search") {
          for (const query of queries) if (typeof query === "string" && query.trim()) operations.push({ type: "search", query: short(query), status });
        } else if (action.type === "open_page" && typeof action.url === "string" && action.url.trim()) {
          operations.push({ type: "open_page", url: short(action.url, 8192), status });
        } else if (action.type === "find_in_page" && typeof action.url === "string" && typeof action.pattern === "string") {
          operations.push({ type: "find_in_page", url: short(action.url, 8192), pattern: short(action.pattern), status });
        }
        // An empty initial/terminal snapshot must not discard the call's known action.
        if (operations.length) this.operations.set(item.id, operations);
      }
      if (typeof item.id === "string" && (this.calls.has(item.id) || this.calls.size < 50)) this.calls.set(item.id, short(item.status, 40) || "in_progress");
      if (Array.isArray(action.sources)) for (const value of action.sources.slice(0, 50)) this.addSource(value);
    } else if (item.type === "message" && typeof item.id === "string" && Array.isArray(item.content) && !this.messages.has(item.id) && this.messages.size < 20) {
      const parts: Part[] = [];
      for (const value of item.content.slice(0, 100)) {
        const part = object(value);
        if (part.type !== "output_text" || typeof part.text !== "string") continue;
        const annotations: Annotation[] = [];
        for (const raw of (Array.isArray(part.annotations) ? part.annotations.slice(0, 200) : [])) {
          const a = object(raw);
          if (a.type !== "url_citation") continue;
          const link = this.addSource(a);
          if (link) annotations.push({ ...link, start: typeof a.start_index === "number" ? a.start_index : undefined, end: typeof a.end_index === "number" ? a.end_index : undefined });
        }
        if (this.textSize + part.text.length > 1024 * 1024) continue;
        this.textSize += part.text.length;
        parts.push({ text: part.text, annotations });
      }
      this.messages.set(item.id, parts);
    }
  }
  ingest(value: unknown): void {
    const event = object(value);
    if (event.type === "response.output_item.done") this.item(event.item);
    else if (event.type === "response.output_item.added" && object(event.item).type === "web_search_call") this.item(event.item);
    else if (["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) {
      const response = object(event.response);
      if (Array.isArray(response.output)) for (const value of response.output.slice(0, 100)) this.item(value);
    }
  }
  linkText(text: string, signature?: string): string {
    let id = signature;
    if (signature?.startsWith("{")) try { id = object(JSON.parse(signature)).id as string; } catch { /* Keep plain text when the signature is unknown. */ }
    const parts = id ? this.messages.get(id) : undefined;
    if (!parts || parts.map(p => p.text).join("") !== text) return text;
    return parts.map(annotated).join("");
  }
  details(mode: SearchDetails["mode"], outcome: SearchDetails["outcome"]): SearchDetails {
    return { mode, outcome, actions: [...this.actions], operations: [...this.operations.values()].flat().slice(0, 50), sources: [...this.sources.values()] };
  }
}

export function summary(details: SearchDetails): string {
  return [`Web search (${details.mode}, ${details.outcome})`,
    ...details.actions.map(action => `Query/action: ${action}`), ...details.sources.map(sourceLink)].join("\n");
}
