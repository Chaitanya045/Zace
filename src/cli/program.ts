import { Command } from "commander";

export function runCli() {
  const program = new Command();

  program
    .name("forge")
    .description("Claude-Code–style CLI coding agent")
    .version("0.1.0")
    .argument("<task>", "Task for the coding agent")
    .option("-v, --verbose", "Verbose output")
    .action((task) => {
      console.log("Task:", task);
    });

  program.parse();
}
