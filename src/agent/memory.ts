import type { LlmMessage } from "../llm/types";
import type { AgentStep } from "../types/agent";

type MessageSink = (message: LlmMessage) => Promise<void>;

type MemoryOptions = {
  messageSink?: MessageSink;
};

export class Memory {
  private messages: LlmMessage[] = [];
  private fileSummaries: Map<string, string> = new Map();
  private readonly messageSink?: MessageSink;
  private messageSinkError: Error | null = null;
  private messageSinkQueue: Promise<void> = Promise.resolve();

  constructor(options?: MemoryOptions) {
    this.messageSink = options?.messageSink;
  }

  addMessage(role: LlmMessage["role"], content: string): void {
    const message = { content, role };
    this.messages.push(message);
    this.enqueueMessageSink(message);
  }

  getMessages(): LlmMessage[] {
    return [...this.messages];
  }

  compactWithSummary(summary: string, preserveRecentMessages: number): boolean {
    const normalizedSummary = summary.trim();
    if (!normalizedSummary) {
      return false;
    }

    const systemMessage = this.messages.find((message) => message.role === "system");
    const nonSystemMessages = this.messages.filter((message) => message.role !== "system");

    if (nonSystemMessages.length <= preserveRecentMessages) {
      return false;
    }

    const recentMessages = nonSystemMessages.slice(-preserveRecentMessages);
    const summaryMessage: LlmMessage = {
      content: `Compacted conversation summary:\n${normalizedSummary}`,
      role: "assistant",
    };
    this.enqueueMessageSink(summaryMessage);

    this.messages = systemMessage
      ? [systemMessage, summaryMessage, ...recentMessages]
      : [summaryMessage, ...recentMessages];

    return true;
  }

  estimateTokenCount(): number {
    const totalCharacters = this.messages.reduce((sum, message) => sum + message.content.length, 0);
    return Math.ceil(totalCharacters / 4);
  }

  addFileSummary(path: string, summary: string): void {
    this.fileSummaries.set(path, summary);
  }

  getFileSummaries(): Map<string, string> {
    return new Map(this.fileSummaries);
  }

  getContextFromSteps(steps: AgentStep[]): string {
    return steps
      .slice(-5)
      .map(
        (step) =>
          `Step ${step.step}: ${step.state}\nReasoning: ${step.reasoning}${step.toolCall ? `\nTool: ${step.toolCall.name}` : ""}${step.toolResult ? `\nResult: ${step.toolResult.success ? "✓" : "✗"}` : ""}`
      )
      .join("\n\n");
  }

  clear(): void {
    this.messages = [];
    this.fileSummaries.clear();
  }

  async flushMessageSink(): Promise<void> {
    await this.messageSinkQueue;
    if (this.messageSinkError) {
      throw this.messageSinkError;
    }
  }

  private enqueueMessageSink(message: LlmMessage): void {
    if (!this.messageSink) {
      return;
    }

    this.messageSinkQueue = this.messageSinkQueue
      .catch(() => undefined)
      .then(async () => {
        if (!this.messageSink) {
          return;
        }

        try {
          await this.messageSink(message);
        } catch (error) {
          if (!this.messageSinkError) {
            this.messageSinkError =
              error instanceof Error
                ? error
                : new Error(`Unknown message sink error: ${String(error)}`);
          }
        }
      });
  }
}
