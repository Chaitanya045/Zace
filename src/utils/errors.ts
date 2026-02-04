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
  constructor(message: string, cause?: unknown) {
    super(message, "LLM_ERROR", cause);
    this.name = "LlmError";
  }
}
