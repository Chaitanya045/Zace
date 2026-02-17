import { describe, expect, test } from "bun:test";

import { ensureUserFacingQuestion } from "../../src/agent/loop";

describe("loop user-facing ask_user message", () => {
  test("appends a follow-up question when planner text is not a question", () => {
    const message = ensureUserFacingQuestion(
      "The user sent a greeting 'hello' which is not an actionable task."
    );
    expect(message).toBe(
      "The user sent a greeting 'hello' which is not an actionable task. What should I do next?"
    );
  });

  test("keeps existing question unchanged", () => {
    const message = ensureUserFacingQuestion("Which file path should I modify?");
    expect(message).toBe("Which file path should I modify?");
  });
});
