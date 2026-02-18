export type LlmProviderErrorClass =
  | "invalid_message_shape"
  | "other"
  | "rate_limit"
  | "response_format_unsupported";

export function classifyProviderError(input: {
  providerCode?: string;
  providerMessage?: string;
  responseFormatUnsupported?: boolean;
  statusCode?: number;
}): LlmProviderErrorClass {
  if (input.responseFormatUnsupported) {
    return "response_format_unsupported";
  }

  if (input.statusCode === 429 || input.providerCode === "429") {
    return "rate_limit";
  }

  const haystack = `${input.providerCode ?? ""} ${input.providerMessage ?? ""}`.toLowerCase();
  if (!haystack.trim()) {
    return "other";
  }

  if (
    haystack.includes("rate limit") ||
    haystack.includes("too many requests") ||
    haystack.includes("quota exceeded")
  ) {
    return "rate_limit";
  }

  const mentionsMessageShape =
    haystack.includes("invalid messages") ||
    haystack.includes("invalid message") ||
    haystack.includes("message role") ||
    haystack.includes("tool role") ||
    haystack.includes("messages[") ||
    haystack.includes("message[") ||
    haystack.includes("role") ||
    haystack.includes("content");
  if ((input.statusCode === 400 || haystack.includes("400")) && mentionsMessageShape) {
    return "invalid_message_shape";
  }

  return "other";
}
