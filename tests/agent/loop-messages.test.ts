import { describe, expect, test } from "bun:test";

import { ensureUserFacingQuestion } from "../../src/agent/loop";

describe("loop user-facing ask_user message", () => {
  test("returns greeting clarification question for non-actionable text", () => {
    const message = ensureUserFacingQuestion(
      "The user sent a greeting 'hello' which is not an actionable task."
    );
    expect(message).toBe(
      "What concrete coding task would you like me to perform in this repository?"
    );
  });

  test("keeps existing question unchanged", () => {
    const message = ensureUserFacingQuestion("Which file path should I modify?");
    expect(message).toBe("Which file path should I modify?");
  });
});
