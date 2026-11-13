# Tavily search

Adds `tavily_search` and `tavily_extract` for models without native web search. It is the counterpart of [`codex-web-search`](../codex-web-search/README.md): on routes where OpenAI's hosted search applies (built-in `openai` Responses and `openai-codex`, same check as `supportsSearch`), both Tavily tools are deactivated on session start and on model switch, and restored when you switch to another model. Only tools this extension removed are restored; tools you never selected stay off. Proxies and other providers keep Tavily.

## Enable

Tools register inactive. Add them to default tools (`"defaultTools": ["+tavily_search", "+tavily_extract"]`), use `pi --tools +tavily_search,+tavily_extract`, or select them in an agent template. Run `/reload` afterwards.

## API key

`TAVILY_API_KEY`, or `{"apiKey": "tvly-..."}` in `<agent-dir>/tavily-search.json` (normally `~/.pi/agent/tavily-search.json`). The environment variable wins.

## Tools

- `tavily_search`: `query`, optional `max_results` (1–20, default 5), `search_depth`, `topic`, `time_range`, `include_answer`, `include_domains`, `exclude_domains`.
- `tavily_extract`: `urls` (1–5), optional `extract_depth`.

Unknown arguments are rejected. Results are marked as untrusted and output is truncated (40 KB total). Advanced depth costs more Tavily credits.

## Verification

```sh
node --test pi/extensions/tavily-search/test.cjs
node pi/extensions/tavily-search/check-types.cjs
```
