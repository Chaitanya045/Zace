import { describe, expect, test } from "bun:test";

import { classifyProviderError } from "../../src/llm/compat";

describe("llm compat error classification", () => {
  test("classifies response_format unsupported", () => {
    const errorClass = classifyProviderError({
      providerMessage: "response_format json_schema is not supported",
      responseFormatUnsupported: true,
      statusCode: 400,
    });
    expect(errorClass).toBe("response_format_unsupported");
  });

  test("classifies invalid message shape", () => {
    const errorClass = classifyProviderError({
      providerMessage: "Invalid messages: role 'tool' is unsupported",
      statusCode: 400,
    });
    expect(errorClass).toBe("invalid_message_shape");
  });

  test("classifies rate limit", () => {
    const errorClass = classifyProviderError({
      providerMessage: "Too many requests",
      statusCode: 429,
    });
    expect(errorClass).toBe("rate_limit");
  });
});
