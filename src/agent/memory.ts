import type { LlmMessage } from "../llm/types";
import type { AgentStep } from "../types/agent";

export class Memory {
  private messages: LlmMessage[] = [];
  private fileSummaries: Map<string, string> = new Map();

  addMessage(role: LlmMessage["role"], content: string): void {
    this.messages.push({ content, role });
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
}
