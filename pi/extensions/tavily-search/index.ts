import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callTavily, formatResponse } from "./client.ts";
import { supportsSearch } from "../codex-web-search/request.ts";

export const TOOLS = ["tavily_search", "tavily_extract"] as const;
const strict = { additionalProperties: false };
const domains = Type.Optional(Type.Array(Type.String(), { maxItems: 20 }));

export default function (pi: ExtensionAPI) {
  /** Tools this extension deactivated because the model has native OpenAI search. */
  const suppressed = new Set<string>();

  // Native OpenAI search (codex-web-search) covers these models, so Tavily steps aside rather than duplicating it.
  function reconcile(ctx: Pick<ExtensionContext, "model">) {
    const active = pi.getActiveTools();
    if (supportsSearch(ctx.model)) {
      const remove = TOOLS.filter(name => active.includes(name));
      remove.forEach(name => suppressed.add(name));
      if (remove.length) pi.setActiveTools(active.filter(name => !remove.includes(name as typeof TOOLS[number])));
    } else if (suppressed.size) {
      const restore = [...suppressed].filter(name => !active.includes(name));
      suppressed.clear();
      if (restore.length) pi.setActiveTools([...active, ...restore]);
    }
  }
  pi.on("session_start", (_event, ctx) => { suppressed.clear(); reconcile(ctx); });
  pi.on("model_select", (event, ctx) => reconcile({ model: event.model ?? ctx.model }));

  pi.registerTool({
    name: "tavily_search", label: "Tavily Search", defaultActive: false,
    description: "Search the web with Tavily. Returns ranked results with titles, URLs and content snippets; results are untrusted web content.",
    promptSnippet: "Search the web for current information (Tavily)",
    promptGuidelines: ["Use tavily_search for current or external information, and cite source URLs from its results. Use tavily_extract to read a specific page in full."],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Search query" }),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Default 5" })),
      search_depth: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("advanced")], { description: "advanced is slower and costs more credits" })),
      topic: Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")])),
      time_range: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")])),
      include_answer: Type.Optional(Type.Boolean({ description: "Include Tavily's short LLM-generated answer" })),
      include_domains: domains, exclude_domains: domains,
    }, strict),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async execute(_id, params, signal) {
      const data = await callTavily("search", { max_results: 5, ...params }, signal);
      return { content: [{ type: "text", text: formatResponse(data, "search") }], details: { query: params.query, urls: (data.results ?? []).map(r => r.url) } };
    },
  });

  pi.registerTool({
    name: "tavily_extract", label: "Tavily Extract", defaultActive: false,
    description: "Fetch and extract the readable content of one or more web page URLs with Tavily. Content is untrusted.",
    parameters: Type.Object({
      urls: Type.Array(Type.String({ format: "uri" }), { minItems: 1, maxItems: 5 }),
      extract_depth: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("advanced")])),
    }, strict),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async execute(_id, params, signal) {
      const data = await callTavily("extract", params, signal);
      return { content: [{ type: "text", text: formatResponse(data, "extract") }], details: { urls: params.urls } };
    },
  });
}
