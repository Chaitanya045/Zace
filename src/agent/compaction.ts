import type { LlmMessage } from "../llm/types";
import type { AgentConfig } from "../types/config";

import { LlmClient } from "../llm/client";
import { logStep } from "../utils/logger";
import { Memory } from "./memory";

const COMPACTION_PROMPT = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`;

export type CompactionResult = {
  compacted: boolean;
  contextWindowTokens?: number;
  inputTokens?: number;
  reason: string;
  usageRatio?: number;
};

function buildCompactionMessages(memory: Memory): LlmMessage[] {
  return [
    ...memory.getMessages(),
    {
      content: COMPACTION_PROMPT,
      role: "user",
    },
  ];
}

function shouldCompact(
  inputTokens: number,
  contextWindowTokens: number,
  triggerRatio: number
): { shouldCompact: boolean; usageRatio: number } {
  const usageRatio = inputTokens / contextWindowTokens;
  return {
    shouldCompact: usageRatio >= triggerRatio,
    usageRatio,
  };
}

export async function maybeCompactContext(input: {
  client: LlmClient;
  config: AgentConfig;
  memory: Memory;
  plannerInputTokens?: number;
  stepNumber: number;
}): Promise<CompactionResult> {
  if (!input.config.compactionEnabled) {
    return {
      compacted: false,
      reason: "compaction_disabled",
    };
  }

  const contextWindowTokens = await input.client.getModelContextWindowTokens();
  if (contextWindowTokens === undefined || contextWindowTokens <= 0) {
    return {
      compacted: false,
      reason: "missing_context_window",
    };
  }

  const inputTokens = input.plannerInputTokens ?? input.memory.estimateTokenCount();
  const decision = shouldCompact(
    inputTokens,
    contextWindowTokens,
    input.config.compactionTriggerRatio
  );

  if (!decision.shouldCompact) {
    return {
      compacted: false,
      contextWindowTokens,
      inputTokens,
      reason: "below_threshold",
      usageRatio: decision.usageRatio,
    };
  }

  const messageCountBefore = input.memory.getMessages().length;
  if (messageCountBefore <= input.config.compactionPreserveRecentMessages + 1) {
    return {
      compacted: false,
      contextWindowTokens,
      inputTokens,
      reason: "insufficient_history",
      usageRatio: decision.usageRatio,
    };
  }

  try {
    logStep(
      input.stepNumber,
      `Context usage ${Math.round(decision.usageRatio * 100)}% reached compaction threshold ${Math.round(input.config.compactionTriggerRatio * 100)}%.`
    );

    const summaryResponse = await input.client.chat({
      messages: buildCompactionMessages(input.memory),
    });
    const compacted = input.memory.compactWithSummary(
      summaryResponse.content,
      input.config.compactionPreserveRecentMessages
    );

    return {
      compacted,
      contextWindowTokens,
      inputTokens,
      reason: compacted ? "compacted" : "compaction_not_applied",
      usageRatio: decision.usageRatio,
    };
  } catch (error) {
    logStep(
      input.stepNumber,
      `Context compaction failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    return {
      compacted: false,
      contextWindowTokens,
      inputTokens,
      reason: "compaction_failed",
      usageRatio: decision.usageRatio,
    };
  }
}
