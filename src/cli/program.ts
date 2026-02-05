import { Command } from "commander";

import { runAgentLoop } from "../agent/loop";
import { LlmClient } from "../llm/client";
import { getAgentConfig } from "../types/config";
import { initializeLogger } from "../utils/logger";

export function runCli(): void {
  const program = new Command();

  program
    .name("forge")
    .description("CLI coding agent")
    .version("0.1.0")
    .argument("<task>", "Task for the coding agent")
    .option("-s, --stream", "Stream LLM output as it is generated")
    .option("-v, --verbose", "Verbose output")
    .action(async (task: string, options: { stream?: boolean; verbose?: boolean }) => {
      try {
        // Load and validate configuration
        const config = getAgentConfig();
        if (options.stream) {
          config.stream = true;
        }
        if (options.verbose) {
          config.verbose = true;
        }

        // Initialize logger
        initializeLogger(config);

        // Create LLM client
        const client = new LlmClient(config);

        // Run the agent loop
        console.log(`\n🔨 Forge: ${task}\n`);
        const result = await runAgentLoop(client, config, task);

        // Output results
        console.log(`\n${result.success ? "✅" : "❌"} ${result.message}\n`);

        if (result.context.steps.length > 0) {
          console.log(`Steps executed: ${result.context.steps.length}`);
          console.log(`Final state: ${result.finalState}\n`);
        }

        process.exit(result.success ? 0 : 1);
      } catch (error) {
        console.error("\n❌ Fatal error:", error instanceof Error ? error.message : String(error));
        if (error instanceof Error && error.stack) {
          console.error(error.stack);
        }
        process.exit(1);
      }
    });

  program.parse();
}
