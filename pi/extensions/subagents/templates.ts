import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseDocument, isMap, isScalar } from "yaml";
import { object, pathFrom, strings } from "./config";
import { applyModifiers, modifiers } from "./modifiers";
import type { Template } from "./types";
export const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export function validName(name: string): void {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("Names must start with a letter and contain at most 64 letters, digits, underscores or hyphens");
}
function inherit(value: unknown, field: string): string {
  if (value === undefined || value === null || value === "") return "parent";
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error(field + " must be a nonempty trimmed string");
  return value;
}
function bool(value: unknown, field: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error(field + " must be boolean");
  return value;
}
export function parseTemplate(text: string, source: string): Template {
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Template exceeds 128 KiB");
  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length) throw new Error([...document.errors, ...document.warnings].map(e => e.message).join("; "));
  return normalizeTemplate(document.toJS({ maxAliasCount: 32 }), source, false);
}
export function normalizeTemplate(raw: unknown, source: string, boundSerializedSize = true): Template {
  if (boundSerializedSize) {
    const encoded = JSON.stringify(raw);
    if (!encoded || Buffer.byteLength(encoded) > 128 * 1024) throw new Error("Template exceeds 128 KiB");
  }
  const data = object(raw, ["name", "description", "selectable", "model", "tools", "skills", "prompt", "subagents"], source);
  if (typeof data.name !== "string") throw new Error("name must be a string");
  validName(data.name);
  if (data.description !== undefined && typeof data.description !== "string") throw new Error("description must be a string");
  const model = object(data.model ?? {}, ["name", "thinking"], "model");
  const tools = object(data.tools ?? {}, ["include_defaults", "extra"], "tools");
  const skills = object(data.skills ?? {}, ["include_defaults", "extra_paths"], "skills");
  const children = object(data.subagents ?? {}, ["include_defaults", "extra", "default"], "subagents");
  const name = inherit(model.name, "model.name"), thinking = inherit(model.thinking, "model.thinking");
  if (!["parent", "global"].includes(name) && !/^[^/]+\/.+$/.test(name)) throw new Error("Explicit model must be provider/model-id");
  if (!["parent", "global", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error("Invalid thinking level");
  if (data.prompt !== undefined && typeof data.prompt !== "string") throw new Error("prompt must be a string");
  const include_defaults = bool(children.include_defaults === undefined ? false : children.include_defaults, "subagents.include_defaults");
  const extra = modifiers(children.extra ?? [], "subagents.extra", validName);
  const allowed = applyModifiers([], extra);
  if (children.default !== undefined) {
    if (typeof children.default !== "string") throw new Error("subagents.default must be a template name");
    validName(children.default);
    if (!(include_defaults ? applyModifiers([children.default], extra) : allowed).includes(children.default)) throw new Error("subagents.default must be in the resolved child templates");
  }
  return {
    name: data.name, ...(data.description !== undefined ? {description: data.description as string} : {}),
    selectable: bool(data.selectable, "selectable"), source, model: { name, thinking },
    tools: { include_defaults: bool(tools.include_defaults, "tools.include_defaults"), extra: modifiers(tools.extra ?? [], "tools.extra") },
    skills: { include_defaults: bool(skills.include_defaults, "skills.include_defaults"), extra_paths: strings(skills.extra_paths ?? [], "skills.extra_paths").map(p => pathFrom(dirname(source), p)) },
    prompt: data.prompt as string ?? "",
    subagents: { include_defaults, extra, allowed, default: children.default as string | undefined },
  };
}
async function files(path: string): Promise<string[]> {
  let info;
  try { info = await stat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  if (info.isFile()) return /\.ya?ml$/.test(path) ? [path] : [];
  if (!info.isDirectory()) return [];
  // Only direct YAML children: no symlink-directory recursion or accidental node_modules scans.
  return (await readdir(path, { withFileTypes: true })).filter(e => e.isFile() && /\.ya?ml$/.test(e.name)).map(e => resolve(path, e.name)).sort();
}
export async function discoverTemplates(paths: string[]): Promise<{templates: Map<string, Template>; diagnostics: string[]}> {
  const templates = new Map<string, Template>(), diagnostics: string[] = [];
  for (const path of paths) {
    const tier = new Map<string, Template>(), invalid = new Set<string>();
    for (const file of await files(path)) {
      const text = await readFile(file, "utf8");
      try {
        const template = parseTemplate(text, file);
        if (tier.has(template.name) || invalid.has(template.name)) { invalid.add(template.name); tier.delete(template.name); throw new Error("Duplicate template name " + template.name); }
        tier.set(template.name, template);
      } catch (e) {
        // Inspect scalar name nodes without expanding aliases, including flow maps/comments/duplicate keys.
        const document = parseDocument(text.slice(0, 128 * 1024));
        if (isMap(document.contents)) for (const pair of document.contents.items) {
          if (isScalar(pair.key) && pair.key.value === "name" && isScalar(pair.value) && typeof pair.value.value === "string" && NAME.test(pair.value.value)) {
            invalid.add(pair.value.value); tier.delete(pair.value.value);
          }
        }
        diagnostics.push(file + ": " + (e as Error).message);
      }
    }
    for (const name of invalid) templates.delete(name);
    for (const [name, template] of tier) { if (templates.has(name)) diagnostics.push(name + " overridden by " + template.source); templates.set(name, template); }
  }
  // Transitively quarantine templates referring to invalid/missing children.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, template] of templates) if ([...applyModifiers([], template.subagents.extra), ...(template.subagents.default ? [template.subagents.default] : [])].some(n => !templates.has(n))) {
      diagnostics.push(template.source + ": missing child template"); templates.delete(name); changed = true;
    }
  }
  // Expand only after quarantine so defaults never retain invalid definitions.
  for (const template of templates.values()) {
    template.subagents.allowed = applyModifiers(template.subagents.include_defaults ? templates.keys() : [], template.subagents.extra);
  }
  return {templates, diagnostics};
}
