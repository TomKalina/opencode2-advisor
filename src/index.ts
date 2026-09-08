import { Plugin } from "@opencode/plugin";

import {
  CONTINUE_WITHOUT_ADVISOR_GUIDANCE,
  MAX_CALLS_PER_SESSION,
  advisorPrompt,
  buildTranscript,
  consumeCallBudget,
  createBoundedCounter,
  errorText,
  redactSecrets,
  restoreCallBudget,
  splitModel,
  validateAdvisorArgs,
  type BoundedCounter,
} from "./core/advisor-core.js";

type Context = Plugin.Context;

const PLUGIN_ID = "opencode2-advisor";
const DEFAULT_AGENT = "opencode-advisor";
const FALLBACK_AGENT = "explore";
const DEFAULT_TIMEOUT_MS = 300_000;

type AdvisorOptions = {
  /** "provider/model[#variant]" — model the advisor runs on. Unset: child keeps the inherited model. */
  model?: string;
  /** Read-only agent id the child session switches to. Default: "opencode-advisor", fallback: "explore". */
  agent?: string;
  /** Per-session consultation budget. Default: 10. */
  maxCalls?: number;
  /** Milliseconds to wait for the child session to finish. Default: 300000. */
  timeoutMs?: number;
};

type AdvisorArgs = { question?: unknown; context?: unknown };

const AGENT_MISSING_MESSAGE =
  "Advisor is not configured: no read-only advisor agent was found. " +
  "Install the opencode-advisor agent (opencode2-advisor/agents/opencode-advisor.md) into your OpenCode agents " +
  `directory (~/.config/opencode/agents/ or .opencode/agents/) and retry. ${CONTINUE_WITHOUT_ADVISOR_GUIDANCE}`;

const TOOL_DESCRIPTION =
  "Consult a separate read-only advisor session running a different model for strategic second opinions. " +
  "The advisor receives a recent, size-capped transcript of this conversation plus your question, and may " +
  "inspect the workspace with read-only tools (read/glob/grep/web). It never edits files or runs commands. " +
  "Call advisor: (1) before committing to a non-obvious approach, architecture choice, or broad/risky edit; " +
  "(2) when stuck — recurring errors, an approach that is not converging, results contradicting expectations; " +
  "(3) before declaring a non-trivial task complete. Skip it on short reactive turns where tool output directly " +
  "determines the next action. Give the advice serious weight; override a specific recommendation only with " +
  "primary-source evidence. Arguments: question (required, at most 4000 characters) — what you need advice on; " +
  "context (optional, at most 12000 characters) — extra detail the transcript may not contain.";

function normalizeOptions(raw: unknown): AdvisorOptions {
  const options: AdvisorOptions = {};
  if (!raw || typeof raw !== "object") return options;
  const record = raw as Record<string, unknown>;
  if (typeof record.model === "string" && record.model.trim()) options.model = record.model.trim();
  if (typeof record.agent === "string" && record.agent.trim()) options.agent = record.agent.trim();
  if (typeof record.maxCalls === "number" && Number.isFinite(record.maxCalls) && record.maxCalls >= 1) {
    options.maxCalls = Math.floor(record.maxCalls);
  }
  if (typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs) && record.timeoutMs >= 1000) {
    options.timeoutMs = Math.floor(record.timeoutMs);
  }
  return options;
}

function parseModel(ref: string | undefined): { providerID: string; id: string; variant?: string } | undefined {
  if (!ref) return undefined;
  const hash = ref.indexOf("#");
  const base = hash >= 0 ? ref.slice(0, hash) : ref;
  const variant = hash >= 0 ? ref.slice(hash + 1) : undefined;
  const split = splitModel(base);
  if (!split) return undefined;
  return variant
    ? { providerID: split.providerID, id: split.modelID, variant }
    : { providerID: split.providerID, id: split.modelID };
}

async function resolveReadOnlyAgent(ctx: Context, preferred: string | undefined): Promise<string | undefined> {
  const candidates = [preferred ?? DEFAULT_AGENT, FALLBACK_AGENT];
  const tried = new Set<string>();
  for (const id of candidates) {
    if (tried.has(id)) continue;
    tried.add(id);
    const agent = await ctx.agent.get({ agentID: id }).catch(() => undefined);
    const value = agent as { id?: string; data?: { id?: string } } | undefined;
    if (value && (value.id || value.data?.id || value.data)) return id;
  }
  return undefined;
}

async function waitWithTimeout(fn: () => Promise<void>, timeoutMs: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`advisor child session timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lastAssistantText(messages: unknown): string {
  const list = Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message?.type !== "assistant") continue;
    const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

async function consult(
  ctx: Context,
  sessionID: string,
  input: AdvisorArgs,
  options: AdvisorOptions,
  callCounts: BoundedCounter,
): Promise<{ content: string; metadata?: Record<string, unknown> }> {
  const maxCalls = options.maxCalls ?? MAX_CALLS_PER_SESSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const valid = validateAdvisorArgs(input);
  if (!valid.ok) return { content: valid.message };

  const budget = consumeCallBudget(callCounts, sessionID, maxCalls);
  if (!budget.allowed) return { content: budget.message };

  const child = { sessionID: "", created: false, started: false };
  try {
    const agentID = await resolveReadOnlyAgent(ctx, options.agent);
    if (!agentID) return { content: AGENT_MISSING_MESSAGE };

    const transcript = buildTranscript(await ctx.session.context({ sessionID }));

    const question = String(input.question ?? "");
    const title = `advisor: ${question.slice(0, 60).replace(/\s+/g, " ").trim() || "consultation"}`;
    const created = await ctx.session.create({ title });
    child.sessionID =
      (created as { id?: string; data?: { id?: string } }).id ?? (created as { data?: { id?: string } }).data?.id ?? "";
    if (!child.sessionID) throw new Error("advisor child session was created without an id");
    child.created = true;

    await ctx.session.switchAgent({ sessionID: child.sessionID, agent: agentID });
    const model = parseModel(options.model);
    if (model) await ctx.session.switchModel({ sessionID: child.sessionID, model });

    const promptText = advisorPrompt(
      { question, context: typeof input.context === "string" ? input.context : undefined },
      transcript,
      { directory: ctx.location?.directory ?? "(unknown)", worktree: "(n/a)" },
    );
    await ctx.session.prompt({ sessionID: child.sessionID, text: promptText });
    child.started = true;

    await waitWithTimeout(
      () => ctx.session.wait({ sessionID: child.sessionID }),
      timeoutMs,
      () => {
        ctx.session.interrupt({ sessionID: child.sessionID, continue: false }).catch(() => {});
      },
    );

    const advice = lastAssistantText(await ctx.session.context({ sessionID: child.sessionID }));
    if (!advice) return { content: `Advisor returned no text. ${CONTINUE_WITHOUT_ADVISOR_GUIDANCE}` };
    return {
      content: redactSecrets(advice),
      metadata: {
        advisorAgent: agentID,
        advisorModel: options.model ?? "inherited",
        advisorSession: child.sessionID,
      },
    };
  } catch (error) {
    if (!child.started) restoreCallBudget(callCounts, sessionID, 0);
    return {
      content: `Advisor consultation failed: ${errorText(error)}. ${CONTINUE_WITHOUT_ADVISOR_GUIDANCE}`,
    };
  }
}

export default {
  id: PLUGIN_ID,
  async setup(ctx: Context) {
    const options = normalizeOptions(ctx.options);
    const callCounts = createBoundedCounter();
    console.log(
      `[${PLUGIN_ID}] loaded (model: ${options.model ?? "inherited"}, agent: ${options.agent ?? DEFAULT_AGENT}, maxCalls: ${options.maxCalls ?? MAX_CALLS_PER_SESSION})`,
    );

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "advisor",
        description: TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "What you need strategic advice on (max 4000 characters).",
            },
            context: {
              type: "string",
              description: "Optional extra detail the conversation transcript may not contain (max 12000 characters).",
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown, toolCtx) => {
          const input = (rawInput ?? {}) as AdvisorArgs;
          const result = await consult(ctx, toolCtx.sessionID, input, options, callCounts);
          return { content: result.content, metadata: result.metadata };
        },
      });
    });
  },
};
