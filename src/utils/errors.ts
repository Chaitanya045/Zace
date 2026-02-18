import type { LlmProviderErrorClass } from "../llm/compat";

export class AgentError extends Error {
  public readonly code: string;
  public override readonly cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "AgentError";
  }
}

export class ToolExecutionError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super(message, "TOOL_EXECUTION_ERROR", cause);
    this.name = "ToolExecutionError";
  }
}

export class ValidationError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super(message, "VALIDATION_ERROR", cause);
    this.name = "ValidationError";
  }
}

export class LlmError extends AgentError {
  public readonly errorClass?: LlmProviderErrorClass;
  public readonly statusCode?: number;
  public readonly providerCode?: string;
  public readonly providerMessage?: string;
  public readonly responseBody?: string;
  public readonly responseFormatUnsupported?: boolean;

  constructor(
    message: string,
    cause?: unknown,
    details?: {
      errorClass?: LlmProviderErrorClass;
      statusCode?: number;
      providerCode?: string;
      providerMessage?: string;
      responseBody?: string;
      responseFormatUnsupported?: boolean;
    }
  ) {
    super(message, "LLM_ERROR", cause);
    this.name = "LlmError";
    this.errorClass = details?.errorClass;
    this.statusCode = details?.statusCode;
    this.providerCode = details?.providerCode;
    this.providerMessage = details?.providerMessage;
    this.responseBody = details?.responseBody;
    this.responseFormatUnsupported = details?.responseFormatUnsupported;
  }
}
