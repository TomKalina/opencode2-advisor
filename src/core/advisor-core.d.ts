// Type declarations for the vendored advisor core (plain ESM JavaScript).
// Source: @mcrescenzo/opencode-advisor v0.2.0 — see NOTICE.md.

export const ADVISOR_TOOL: string;
export const ADVISOR_AGENT: string;
export const TRANSCRIPT_CHAR_LIMIT: number;
export const MAX_CALLS_PER_SESSION: number;
export const MAX_QUESTION_CHARS: number;
export const MAX_CONTEXT_CHARS: number;
export const CONTINUE_WITHOUT_ADVISOR_GUIDANCE: string;
export const MAX_TRACKED_SESSIONS: number;

export function budgetReachedMessage(maxCalls?: number): string;
export function sessionTrackingCapacityMessage(): string;

export interface BoundedCounter {
  get(key: string): number | undefined | symbol;
  set(key: string, value: number): BoundedCounter;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  markExhausted(key: string, value: number): BoundedCounter;
  unmarkExhausted(key: string): BoundedCounter;
  readonly size: number;
}

export function createBoundedCounter(maxEntries?: number): BoundedCounter;
export function addToBoundedSet(set: Set<string>, value: string, maxEntries: number): boolean;
export function consumeCallBudget(
  callCounts: BoundedCounter,
  sessionID: string,
  maxCalls?: number,
): { allowed: true; count: number } | { allowed: false; count: number; message: string };
export function restoreCallBudget(callCounts: BoundedCounter, sessionID: string, previousCount: number): void;
export function validateAdvisorArgs(args: {
  question?: unknown;
  context?: unknown;
}): { ok: true } | { ok: false; message: string };
export function textPart(text: string, options?: Record<string, unknown>): Record<string, unknown>;
export function splitModel(model: string | undefined): { providerID: string; modelID: string } | undefined;
export function globMatches(pattern: string, value: string): boolean;
export function resolveSessionRequestShape(ctx: unknown): "v1" | "v2" | undefined;
export function responseText(result: unknown): string;
export function safeJson(value: unknown, maxChars?: number): string;
export function errorText(error: unknown): string;
export function partTypes(parts?: unknown[]): string;
export function messageAgent(message: unknown): string | undefined;
export function redactSecrets(text: string): string;
export function partText(part: unknown): string;
export function buildTranscript(messages: unknown[]): string;
export function advisorPrompt(
  args: { question: string; context?: string },
  transcript: string,
  toolContext: { directory?: unknown; worktree?: unknown },
): string;
