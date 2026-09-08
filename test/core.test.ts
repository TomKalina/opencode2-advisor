import { describe, expect, it } from "vitest";
import {
  MAX_CALLS_PER_SESSION,
  MAX_QUESTION_CHARS,
  advisorPrompt,
  buildTranscript,
  consumeCallBudget,
  createBoundedCounter,
  redactSecrets,
  restoreCallBudget,
  validateAdvisorArgs,
} from "../src/core/advisor-core.js";

describe("redactSecrets", () => {
  it("redacts raw API tokens", () => {
    expect(redactSecrets("key: sk-abcdefghijklmnopqrstuvwx00")).toBe("key: [REDACTED TOKEN]");
  });

  it("redacts Authorization headers", () => {
    const out = redactSecrets("Authorization: Bearer abcdef1234567890XYZ");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("abcdef1234567890XYZ");
  });

  it("redacts PEM private key blocks", () => {
    const block = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(redactSecrets(`secret ${block} tail`)).toBe("secret [REDACTED PRIVATE KEY] tail");
  });

  it("redacts secret-like query parameters", () => {
    const out = redactSecrets("https://example.com/cb?next=/x&token=abc123secret");
    expect(out).toContain("token=[REDACTED]");
    expect(out).not.toContain("abc123secret");
  });

  it("redacts userinfo in URLs", () => {
    expect(redactSecrets("https://user:pass12345@example.com/x")).toContain("[REDACTED]:[REDACTED]@");
  });

  it("passes through clean text", () => {
    expect(redactSecrets("plain advice about testing")).toBe("plain advice about testing");
  });
});

describe("validateAdvisorArgs", () => {
  it("rejects a missing question", () => {
    expect(validateAdvisorArgs({}).ok).toBe(false);
  });

  it("rejects an overlong question", () => {
    expect(validateAdvisorArgs({ question: "x".repeat(MAX_QUESTION_CHARS + 1) }).ok).toBe(false);
  });

  it("rejects a non-string context", () => {
    expect(validateAdvisorArgs({ question: "q", context: 42 }).ok).toBe(false);
  });

  it("accepts valid arguments", () => {
    expect(validateAdvisorArgs({ question: "is this safe?", context: "ctx" })).toEqual({ ok: true });
  });
});

describe("call budget", () => {
  it("allows up to the per-session maximum, then denies", () => {
    const counts = createBoundedCounter();
    for (let i = 0; i < MAX_CALLS_PER_SESSION; i += 1) {
      expect(consumeCallBudget(counts, "s1").allowed).toBe(true);
    }
    const denied = consumeCallBudget(counts, "s1");
    expect(denied.allowed).toBe(false);
    // a different session is unaffected
    expect(consumeCallBudget(counts, "s2").allowed).toBe(true);
  });

  it("restore refunds exactly one call", () => {
    const counts = createBoundedCounter();
    consumeCallBudget(counts, "s1");
    restoreCallBudget(counts, "s1", 0);
    expect(consumeCallBudget(counts, "s1").count).toBe(1);
  });
});

describe("buildTranscript", () => {
  it("formats V2-shaped messages with roles and redacts secrets", () => {
    const transcript = buildTranscript([
      { type: "user", text: "hello, token=[sk-abcdefghijklmnopqrstuvwx00]" },
      { type: "assistant", agent: "build", content: [{ type: "text", text: "hi there" }] },
    ]);
    expect(transcript).toContain("USER:");
    expect(transcript).toContain("ASSISTANT (build):");
    expect(transcript).toContain("hi there");
    expect(transcript).not.toContain("sk-abcdefghijklmnopqrstuvwx00");
  });

  it("keeps the most recent content within the character limit", () => {
    const transcript = buildTranscript([
      { type: "user", text: "oldest" },
      { type: "assistant", agent: "build", content: [{ type: "text", text: "x".repeat(150_000) }] },
      { type: "user", text: "newest" },
    ]);
    expect(transcript.length).toBeLessThanOrEqual(90_000);
    expect(transcript).toContain("newest");
  });
});

describe("advisorPrompt", () => {
  it("fences all untrusted blocks with a unique boundary", () => {
    const prompt = advisorPrompt({ question: "Q?", context: "C?" }, "T?", { directory: "/tmp/work" });
    expect(prompt).toContain("ADVISOR_UNTRUSTED_QUESTION_");
    expect(prompt).toContain("Q?");
    expect(prompt).toContain("C?");
    expect(prompt).toContain("T?");
    expect(prompt).toContain("/tmp/work");
    const boundaries = [...prompt.matchAll(/ADVISOR_UNTRUSTED_\w+_[a-f0-9-]{36}/g)].map((m) => m[0]);
    const unique = new Set(boundaries);
    // four fences, each with an opening and a closing marker
    expect(boundaries.length).toBe(8);
    expect(unique.size).toBe(4);
  });
});
