# Server-side compaction

Adds `/compaction` to select **auto**, **pi**, or **server** for the next compaction. `auto` uses the official OpenAI Responses/Codex compaction endpoint where supported and ordinary Pi compaction for other models. No dependencies to install; Pi supplies the SDK. Load through the normal extensions directory or `pi -e ./pi/extensions/server-side-compaction/index.ts`, then `/reload` after edits.

## Behavior

Pi still owns `/compact [instructions]`, automatic thresholds, overflow recovery, the cut point, and recent-history retention. Server mode replaces only generation of the older-prefix summary:

```text
current instructions/tools + endpoint checkpoint bundle + unchanged Pi recent tail
```

The request uses Pi's original structured older prefix, including previous checkpoints, full tool outputs, images and reasoning signatures. It does **not** use Pi's readable-summary prompt, conversation-to-text serialization or 2,000-character tool-output truncation. The retained recent tail is not sent to the endpoint. Prefix fidelity follows the installed provider's normal normalization; arbitrary later extension transformations can still differ. No cache hit or shared generation/compaction KV cache is guaranteed.

All validated endpoint output is replayed in order, including preserved older user messages as well as the encrypted item. Ciphertext is never decoded or treated as text. Current tools/system state and new messages are preserved independently of the checkpoint.

Official adapters only:

- `openai` + `openai-responses`: `https://api.openai.com/v1/responses/compact`.
- `openai-codex` + `openai-codex-responses`: `https://chatgpt.com/backend-api/codex/responses/compact`, when supported by the account/model/backend.

Azure, Chat Completions, arbitrary proxies/hosts and other providers fall back to Pi. The Codex unary route is conditional; this extension does not implement Codex CLI's newer streamed `compaction_trigger` flow. Real API-key and Codex endpoint availability has **not** been validated by the deterministic tests.

Endpoint errors, unknown response types, unsupported transport overrides, and conservatively over-budget prefixes visibly fall back to readable Pi compaction. No silent shortening or endpoint retry loop. Cancellation cancels instead of starting fallback work. If an encrypted checkpoint exists, fallback reconstructs the original readable history rather than summarizing a placeholder. Failed conversion preserves the old checkpoint.

## Commands

| Command | Effect |
| --- | --- |
| `/compaction` / `/compaction status` | Show selected policy, effective next backend, and checkpoint type. |
| `/compaction auto` | Server on supported OpenAI models; Pi elsewhere. |
| `/compaction pi` | Use readable Pi compaction next time. |
| `/compaction server` | Prefer server; fall back visibly when unavailable. |
| `/compaction reset` | Clear branch override; use configured defaults. |
| `/compaction portable` | Explicitly reconstruct and save a readable summary of the encrypted prefix. |
| `/compact [instructions]` | Existing Pi command executes the selected backend. |

Changing policy does not compact immediately or replace the current checkpoint. Overrides follow the active session branch and survive reload/resume. Forked branches inherit only their own ancestry.

### Model switching and portability

Encrypted checkpoints are conservatively scoped to provider/API/model/endpoint/account. When switching to an incompatible model, a user-facing dialog offers **convert and switch** or **cancel**. Conversion uses one or more normal summarization calls; there is no second readable summary on ordinary server compaction. Cancel/failure keeps the previous compatible model. Pi reports model changes after applying them, so attempted/restored model-change records can remain in history.

`/compaction pi` still uses an existing compatible encrypted checkpoint for generation until the next compaction. That next compaction lazily reconstructs the old prefix into a readable summary. It does not attempt to decrypt ciphertext.

**Before disabling/uninstalling this extension, run `/compaction portable`.** Its readable summary is saved as a real model-visible custom message, so stock Pi can still read it. While the extension is loaded it projects that text into the original summary slot, avoiding duplicate context. Disabling without conversion leaves only a nonsemantic marker in stock Pi's summary slot and loses the encrypted prefix from model context (original session log remains stored).

**Accounting limitation:** regular server/native compaction usage is included in Pi totals. Standalone portability conversion (including accepted model-switch conversion) records its usage once in the portable message's `details.usage`, with a visible notice, but **Pi's native cost totals do not include it**: its public extension API has no standalone usage-append operation. This limitation is explicitly approved and is not described as free usage.

Conversion requires original source history. Missing/corrupt anchors block replay/conversion instead of silently dropping history; navigate/recover the source branch if needed. Context edits to a portable record (including deletion) are rejected rather than resurrecting stale summary text; restore that record/source branch before continuing. Large histories use ordered bounded readable-summary chunks; indivisible oversized tool groups fail safely.

## Configuration

Optional extension-owned files (never created automatically):

1. `<effective Pi agent directory>/server-side-compaction.json` (`PI_CODING_AGENT_DIR` respected).
2. `<project>/.pi/server-side-compaction.json`, only when Pi trusts the project.

```json
{
  "mode": "auto",
  "providers": { "openai": "auto" },
  "models": { "openai/gpt-example": "pi" },
  "timeoutMs": 120000,
  "maxResponseBytes": 33554432
}
```

Precedence: branch command > exact `provider/modelId` > provider > configured mode > built-in `auto`. Project values override user values; override maps merge by exact key. Unknown keys/invalid values disable server selection with a warning, even if a branch requested server. Timeout range: 1,000–600,000 ms; response limit: 1 KiB–128 MiB; configuration files limited to 1 MiB.

Authentication uses Pi's fresh credential resolver; never copies auth.json. Tokens are not persisted. Account/key fingerprints and output ciphertext are stored in session checkpoint details; preserved endpoint user messages are ordinary session data. API-key rotation is conservatively treated as a compatibility change. Redirects/foreign resolved endpoints are rejected, auth/response bodies are not echoed. Provider-specific `auth.env` transport overrides are unsupported and trigger Pi fallback. Requests use Node's global fetch; no claim is made of parity with all Pi-managed proxy/transport settings.

## Subagents and noninteractive modes

The extension works in ordinary workers and isolated workflow roots when loaded there, unless excluded through worker extension settings. State and asynchronous operations are factory/session-local. Worker automatic compaction is headless; it never opens confirmation dialogs or implicitly accepts conversion cost. Incompatible worker/headless model changes restore the compatible model when available; request-time guards block incompatible replay otherwise. Explicit `/compaction portable` can be used by a headless client before switching.

TUI appends a grey `• server compaction (auto)`, `• pi compaction (auto)`, `• server compaction (override)` or `• pi compaction (override)` beside the native model/effort display. `auto` means automatic policy; explicit `pi`/`server` selection is an override. The label describes the next backend selected by policy (individual endpoint failures can still fall back). On narrow terminals it hides instead of truncating the native stats/model. No separate status row is added. TUI/RPC notifications report status/fallback. Without UI, notices are stored as non-context `server-side-compaction.notice.v1` session entries, avoiding prompt pollution and stdout protocol corruption.

## Verification

```sh
node --test pi/extensions/server-side-compaction/test.cjs pi/extensions/server-side-compaction/*.test.cjs
node pi/extensions/server-side-compaction/check-types.cjs
node --test tests/pi-compatibility.cjs
```

The strict type check reuses the existing `subagents` development TypeScript dependency (install via the repository's documented setup if absent). Tests use installed Pi sessions, real provider serialization, deterministic fake providers and mocked HTTP—no paid calls. They cover workers, prefix fidelity, endpoint validation, reconstruction and safe switching. Real-terminal confirmation/cancel/accept was exercised with the disposable `smoke.cjs` fixture; captures are in `plans/artifacts/compaction-*.{txt,svg}`. Live endpoint availability/cache behavior still requires separate opt-in manual checks.
