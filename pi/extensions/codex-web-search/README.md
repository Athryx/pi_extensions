# Codex web search

Enables OpenAI's hosted `web_search` within Pi's existing model request. It uses the selected provider's authentication, transport and model. It does not make a second model request or call a standalone internal search endpoint.

Supported routes are Pi's built-in `openai` provider with the Responses API (API key or supported ChatGPT sign-in), and the existing legacy `openai-codex` Responses provider. Model/account/workspace policy still determines whether OpenAI permits search. Other providers and custom proxies receive no search declaration. Switching back to a supported model restores search without changing the tool selection.

## Enable

The extension registers `web_search` inactive. This checkout adds it to default tools:

```json
{"defaultTools": ["+codemode", "+workflow", "+web_search"]}
```

Use `pi --tools +web_search` for one invocation. Agent templates inherit default tools, or select it explicitly:

```yaml
tools:
  include_defaults: false
  extra: [web_search]
```

`extra: [-web_search]` removes it. CLI restrictions remain authoritative. Search is hosted by OpenAI and is never a local function callable through codemode or tool search. Selecting `workflow` does not direct its invocation.

Run `/reload` after installing/changing the extension or adding it to default tools. There are no extension-local dependencies to install; Pi supplies the host packages.

## Mode configuration

Live search is the default. To use cached/indexed results instead, save this in `<agent-dir>/codex-web-search.json` (normally `~/.pi/agent/codex-web-search.json`):

```json
{"mode": "cached"}
```

A trusted project's `.pi/codex-web-search.json` overrides the user default. Only `mode`, with value `live` or `cached`, is accepted. An empty object inherits the previous default. Invalid/unreadable configuration disables search, reports a diagnostic, and allows normal conversation. Configuration is read on session startup/reload.

`live` sets `external_web_access: true`; `cached` sets it to `false`. Cached mode uses OpenAI's index, not a cache of your past searches. [OpenAI web search documentation](https://developers.openai.com/api/docs/guides/tools-web-search#live-internet-access).

## Commands

| Command | Action |
| --- | --- |
| `/web-search` or `/web-search toggle` | Toggle live ↔ cached |
| `/web-search live` | Use live access |
| `/web-search cached` | Use cached results |
| `/web-search status` | Show mode, its source and current availability |
| `/web-search reset` | Clear the conversation override |

Commands apply only to the current conversation's branch and survive reload/resume. Forks inherit their branch's override; tree navigation restores the selected branch's override. New conversations and workers start with the configured default, independently of the parent conversation. Commands never write configuration files or activate an unselected/forbidden tool. Changes apply to the next request; an active request retains its starting mode.

## Results and accounting

Completed turns store a bounded, expandable summary of search queries/actions and source URLs. URL citation annotations become Markdown links in the final assistant message. Summaries and links remain readable when switching providers or reopening the conversation, including without this extension. Search failures/cancellation remain normal provider outcomes; there is no automatic retry without search.

With the `ui` extension in compact or compact-code mode, native activity streams into tool rows above the associated assistant response: blue `searched` followed by the query, and blue `viewed web page` followed by the URL for an explicit page-open action. An initial `web search ⋯` placeholder updates once the provider supplies its query/action. Find-in-page actions show `searched web page <URL> · <pattern>`. Search-result URLs alone never produce page-view rows. The shared [provider-tools reporter](../shared/README.md#streamed-provider-tools) persists these rows in assistant metadata for resume and live worker viewing; the trailing source summary is suppressed in compact mode to avoid duplicate rows. Older histories retain their saved structured or mixed-action summary rendering. Collapsed/expanded modes retain the normal summary with sources.

Search summaries preserve portable URLs rather than replaying opaque native search-reference objects. Refer to the source URLs in subsequent turns. Metadata and renderer caches are bounded; unchanged summaries reuse rendered lines on spinner redraws.

Hosted search uses the active provider's billing or subscription limits. Pi accounts for normal response tokens, but its calculated token cost may omit separate hosted-search fees. Cached mode has no separately published API discount. [API pricing](https://developers.openai.com/api/docs/pricing#built-in-tools).

## Verification

```sh
node --test pi/extensions/codex-web-search/test.cjs pi/extensions/codex-web-search/*.test.cjs
node pi/extensions/codex-web-search/check-types.cjs
```

Tests use the installed Pi host, actual Responses serializers and stream normalization, deterministic local SSE responses, and real worker loadouts. They make no paid model calls. Run the repository-wide verification commands from the root README as well.
