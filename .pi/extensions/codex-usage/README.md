# Codex usage

Displays subscription-wide remaining usage on its own line below Pi's native footer cost/model row:

```text
$0.000 (sub)  …
Codex left: weekly 60% · 5h 75%
```

- Polls on interactive startup and every minute; refreshes after agent runs (at most once per 30 seconds) and model changes.
- `/usage` polls immediately and displays the plan, remaining limits, reset times, code-review/additional limits, and credits when reported. No model request is made.
- Shows a 5-hour window only if the response explicitly reports a 5-hour limit. Weekly-only subscriptions show only weekly usage. Missing percentages are `?`, not invented totals; failed refreshes mark cached values `(stale)`.
- Preserves the native path, session name, tokens, cost, context, model, and other extensions' statuses. Uses a reversible, instance-local native-footer render adapter, not a replacement footer. A different extension's fully custom footer is not modified.
- Uses Pi's existing OpenAI Codex OAuth authentication and token-refresh handling. API keys are not supported. An OpenAI OAuth login works only if its token includes the Codex account claim and the usage endpoint accepts it; otherwise `/usage` explains how to reconnect with `/login → OpenAI Codex`.
- Queries `https://chatgpt.com/backend-api/wham/usage` with a 15-second request timeout. This unofficial endpoint can change or reject some login/subscription types. Billing dates and renewal details are not provided by it.
- Tokens are never displayed or persisted by this extension. Subscription results are UI-only and are not stored in the session or sent to the model. No background polling in RPC/print mode; `/usage` can still be used by clients supporting UI notifications.

Run `/reload` to load the extension in this project.

Tests:

```sh
node --test .pi/extensions/codex-usage/test.cjs .pi/extensions/codex-usage/lifecycle.test.cjs
```
