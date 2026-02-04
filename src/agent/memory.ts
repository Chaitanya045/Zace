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
