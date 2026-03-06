import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmClient } from "../../src/llm/client";
import type { LlmMessage } from "../../src/llm/types";
import type { AgentContext } from "../../src/types/agent";

import { analyzeToolResult } from "../../src/agent/executor";
import { plan } from "../../src/agent/planner";
import { ensureBrainStructure } from "../../src/brain";

async function seedBrainWorkspace(workspaceRoot: string): Promise<void> {
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "# Zace\n\nZace is a CLI coding agent built with Bun + TypeScript.\n", "utf8");
  await ensureBrainStructure({ workspaceRoot });
  await writeFile(join(workspaceRoot, ".zace", "brain", "knowledge.md"), [
    "# Knowledge Memory",
    "",
    "Authentication uses JWT bearer tokens.",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, ".zace", "working_memory.json"), JSON.stringify({
    activePlanStepId: "step-1",
    currentStep: "inspect auth.ts",
    goal: "fix login bug",
    lastUpdatedAt: "2026-03-06T12:00:00.000Z",
    recentDecisions: [],
    relevantFiles: ["src/auth.ts"],
    sessionId: "chat-test",
  }, null, 2) + "\n", "utf8");
  await writeFile(join(workspaceRoot, ".zace", "planner", "current_plan.json"), JSON.stringify({
    currentStepId: "step-1",
    goal: "fix login bug",
    steps: [
      {
        id: "step-1",
        relevantFiles: ["src/auth.ts"],
        status: "in_progress",
        title: "Inspect auth token validation",
      },
    ],
    updatedAt: "2026-03-06T12:00:00.000Z",
  }, null, 2) + "\n", "utf8");
}

function createPlannerContext(): AgentContext {
  return {
    currentStep: 0,
    fileSummaries: new Map([["src/auth.ts", "Authentication and token validation flow"]]),
    maxSteps: 4,
    scriptCatalog: new Map(),
    steps: [],
    task: "inspect auth token validation",
  };
}

describe("brain context integration", () => {
  test("planner request includes persistent brain context", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-plan-"));
    const originalCwd = process.cwd();
    let seenMessages: LlmMessage[] = [];

    try {
      await seedBrainWorkspace(workspaceRoot);
      process.chdir(workspaceRoot);

      const llmClient = {
        chat: async (request: { messages: LlmMessage[] }) => {
          seenMessages = request.messages;
          return {
            content: JSON.stringify({
              action: "continue",
              reasoning: "Inspect repository state first.",
              toolCall: {
                arguments: {
                  command: "rg -n auth src",
                },
                name: "bash",
              },
            }),
          };
        },
      } as unknown as LlmClient;

      await plan(llmClient, createPlannerContext(), {
        getMessages: () => [
          {
            content: "system prompt",
            role: "system",
          },
        ],
      });

      const brainMessage = seenMessages.find((message) =>
        message.content.includes("PERSISTENT BRAIN CONTEXT (PLANNER)")
      );
      expect(brainMessage).toBeDefined();
      expect(brainMessage?.content).toContain("Authentication uses JWT bearer tokens.");
    } finally {
      process.chdir(originalCwd);
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test("executor analysis request includes persistent brain context", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-executor-"));
    const originalCwd = process.cwd();
    let seenMessages: LlmMessage[] = [];

    try {
      await seedBrainWorkspace(workspaceRoot);
      process.chdir(workspaceRoot);

      const llmClient = {
        chat: async (request: { messages: LlmMessage[] }) => {
          seenMessages = request.messages;
          return {
            content: JSON.stringify({
              analysis: "The command failed because auth validation is still broken.",
              retryDelayMs: 0,
              shouldRetry: false,
            }),
          };
        },
      } as unknown as LlmClient;

      await analyzeToolResult(
        llmClient,
        {
          arguments: {
            command: "bun test auth",
          },
          name: "bash",
        },
        {
          output: "auth token validation failed",
          success: false,
        }
      );

      expect(seenMessages[0]?.content).toContain("PERSISTENT BRAIN CONTEXT (EXECUTOR)");
      expect(seenMessages[0]?.content).toContain("Authentication uses JWT bearer tokens.");
    } finally {
      process.chdir(originalCwd);
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test("planner repair calls stay lean and omit persistent brain context", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "zace-brain-plan-repair-"));
    const originalCwd = process.cwd();
    const seenMessages: LlmMessage[][] = [];

    try {
      await seedBrainWorkspace(workspaceRoot);
      process.chdir(workspaceRoot);

      const llmClient = {
        chat: async (request: { messages: LlmMessage[] }) => {
          seenMessages.push(request.messages);
          if (seenMessages.length === 1) {
            return {
              content: "Planning: malformed output",
            };
          }

          return {
            content: JSON.stringify({
              action: "continue",
              reasoning: "Inspect repository state first.",
              toolCall: {
                arguments: {
                  command: "rg -n auth src",
                },
                name: "bash",
              },
            }),
          };
        },
      } as unknown as LlmClient;

      await plan(llmClient, createPlannerContext(), {
        getMessages: () => [
          {
            content: "system prompt",
            role: "system",
          },
        ],
      });

      expect(seenMessages.length).toBeGreaterThanOrEqual(2);
      expect(
        seenMessages[0]?.some((message) => message.content.includes("PERSISTENT BRAIN CONTEXT (PLANNER)"))
      ).toBeTrue();
      expect(
        seenMessages[1]?.some((message) => message.content.includes("PERSISTENT BRAIN CONTEXT (PLANNER)"))
      ).toBeFalse();
    } finally {
      process.chdir(originalCwd);
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
