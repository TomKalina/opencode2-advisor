# opencode2-advisor

An `advisor()` tool for [OpenCode 2](https://opencode.ai/v2/docs/) (`opencode2`): when your agent is mid-task, it can consult a **different model in a separate read-only session** and get a strategic second opinion before committing to an approach.

```
executor session (your agent)
  └─ calls advisor(question, context)
       └─ fresh child session "advisor: <question>"
            ├─ seeded with a recent, size-capped, redacted transcript of the conversation
            ├─ switched to a read-only agent (no edit / no shell / no subagents)
            ├─ switched to the advisor model (e.g. a Codex-class model)
            └─ answers: recommendation / rationale / risks / next steps
       └─ advice (redacted) returns to the executor; the child session stays, titled "advisor: …"
```

## Why

A model reviewing its own work shares its own blind spots. The advisor runs a *different* model on the *same* context:

- **Context, automatically.** The plugin builds a recent, size-capped (90k chars) transcript of the conversation and redacts it before the advisor sees it — the executor does not have to hand-write a brief, and the advisor's prompt stays a predictable size even in long sessions.
- **Read-only, enforced.** The child runs a dedicated advisor agent whose permissions deny `edit`, `shell`, `subagent`, and MCP tools. The advisor can inspect the workspace (`read`/`glob`/`grep`/`webfetch`) but cannot change anything.
- **Budgeted.** At most 10 consultations per session (configurable). The counter is bounded and fail-closed: churn can never refund a spent budget.
- **Redacted.** Questions, context, and the advisor's response pass through a secret redactor (tokens, keys, `Authorization` headers, PEM blocks, URL userinfo, secret-like query params) before the advice reaches the executor.
- **Prompt-injection fenced.** Everything the executor supplies is wrapped in unique `ADVISOR_UNTRUSTED_*` boundaries and explicitly marked as evidence, never instructions.

## Install

### 1. The plugin

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "opencode2-advisor", "options": { "model": "github-copilot/gpt-5.3-codex#high" } }
  ]
}
```

Or from a local checkout:

```jsonc
{ "plugins": ["/absolute/path/to/opencode2-advisor"] }
```

### 2. The advisor agent

The plugin switches the child session to a read-only agent. Copy the bundled one into your agents directory (or add it under `agents` in your config):

```sh
cp agents/opencode-advisor.md ~/.config/opencode/agents/
```

If no advisor agent is found the tool fails closed with instructions (it falls back to the built-in read-only `explore` agent, so the plugin still works without step 2 — the bundled agent just gives better advisor behavior).

### 3. Restart

```sh
opencode2 service restart
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | `string` | inherited | Advisor model as `provider/model[#variant]`. **Set this** — the whole point is a different model than the executor's. |
| `agent` | `string` | `opencode-advisor` | Read-only agent id the child session runs under (fallback: `explore`). |
| `maxCalls` | `number` | `10` | Consultations allowed per session. |
| `timeoutMs` | `number` | `300000` | Wait time for the child session to finish, then it is interrupted. |

## Tool contract

```jsonc
// advisor
{
  "question": "What you need strategic advice on (required, ≤4000 chars)",
  "context": "Optional extra detail the transcript may not contain (≤12000 chars)"
}
```

The tool description tells the executor *when* to call it: before committing to a non-obvious approach or a broad/risky edit, when stuck (recurring errors, non-converging approach), and before declaring a non-trivial task done — and *not* on short reactive turns.

Failure modes are fail-open for the executor: a failed or timed-out consultation returns a short "continue without advisor guidance" message (plus the error), and a consultation that never started does not consume budget.

## Security model

- The advisor **cannot** edit files, write files, run shell commands, spawn subagents, or use MCP tools (agent-level permission denies, defense in depth on top of the read-only prompt).
- The agent prompt forbids fetching localhost / loopback / link-local / RFC1918 / cloud-metadata URLs.
- All executor-supplied data is fenced as untrusted; the advisor treats it as evidence only.
- Secrets are redacted in both directions (in: question/context/transcript, out: advice).
- Per-session call budget with a bounded, non-refunding counter (fail-closed under churn).
- Child sessions are titled `advisor: <question>` so they are identifiable and easy to archive; the plugin never mutates the parent session.

### Why a transcript and not a session fork?

OpenCode 2's plugin context exposes a *scoped* session API (`create`, `context`, `prompt`, `wait`, `switchAgent`, `switchModel`, `interrupt`, …) — there is currently no `session.fork` or `session.remove` on it. The transcript path is the design that works on the supported surface, and it has real advantages of its own: the advisor's prompt is **bounded** (a 500k-token session does not become a 500k-token advisor call), **redacted** (the redactor runs at transcript build time), and **deterministic** in cost. If the plugin API later exposes fork/remove, it can be added as an option.

## Architecture

```
src/index.ts               V2 plugin: registers the advisor() tool, drives the
                           context → create → switchAgent → switchModel →
                           prompt → wait → context flow (≈280 lines)
src/core/advisor-core.js   Vendored pure core (no opencode imports): redaction,
                           budget, validation, transcript, fenced prompt —
                           see NOTICE.md (MIT, Michael Crescenzo)
agents/opencode-advisor.md Read-only advisor agent definition
test/core.test.ts          Unit tests for the core helpers this plugin relies on
```

The plugin has **no runtime dependencies** — the `@opencode/plugin` import is type-only (the server injects the plugin context at load time). It ships TypeScript source directly; `opencode2` loads `.ts` plugin entries natively.

## Compatibility

Targeted at the OpenCode 2 beta (`opencode2`, `@opencode/plugin` 0.0.0-beta-192xx). The V2 plugin API is explicitly in flux — after upgrading `opencode2`, run `npm test && npm typecheck` and check the log line `[opencode2-advisor] loaded (…)` at service start. The plugin only uses the documented plugin-context surface (`tool.transform`, `session.create/context/prompt/wait/interrupt/switchAgent/switchModel`, `agent.get`), so it should keep working across beta bumps; if a field it reads from messages or agents changes shape, the worst case is a degraded transcript, not a crash.

**API drift data points** (verified 2026-09-08, `@opencode-ai/plugin` 1.18.15 `v2/promise` preview types vs the running `opencode2` beta-19234 / `@opencode/plugin` 0.0.0-beta-19296 types):

| preview (1.18.15) | beta (19234+) |
| --- | --- |
| `ctx.aisdk.language(cb)` | `ctx.aisdk.hook.language(cb)` |
| `model.modalities.input` | `model.capabilities.input` |

The definition shape (`{ id, setup }`) did not change, so preview-era plugins still *parse* — they crash at runtime on the moved hook (`ctx.aisdk.language is not a function`). The language hook callback receives the same `{ model, language?: LanguageModelV3 }` payload, and the new registration also accepts an optional `{ providerID }` scope. Porting advice: resolve the hook tolerantly (`aisdk.hook?.language ?? aisdk.language`) and fail soft, so the plugin stays loadable across both host generations.

## Credits

- Core logic (redaction, budget, validation, transcript, prompt) vendored from [`@mcrescenzo/opencode-advisor`](https://github.com/mcrescenzo/opencode-advisor) by Michael Crescenzo (MIT) — see [NOTICE.md](./NOTICE.md).
- The "advisor" concept for OpenCode and prior V1 implementations: [`opencode-advisor`](https://github.com/jwh9456/opencode-advisor), [`@stefanobalocco/opencode-advisor`](https://github.com/StefanoBalocco/opencode-advisor), [`@u007/opencode-advisor`](https://github.com/u007/opencode-advisor) — all OpenCode V1 plugins, none of which work on OpenCode 2 (the V2 plugin API is a breaking change); this project is the V2-native port.

## License

[MIT](./LICENSE) — see [NOTICE.md](./NOTICE.md) for the vendored-core attribution.
