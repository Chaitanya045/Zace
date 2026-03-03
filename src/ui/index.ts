import { spawn, spawnSync } from "node:child_process";

import type { AgentConfig } from "../types/config";

type RunChatUiInput = {
  config: AgentConfig;
  sessionFilePath: string;
  sessionId: string;
};

function hasCommand(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function ensureTextualRuntimeAvailable(projectRoot: string): void {
  if (!hasCommand("uv")) {
    throw new Error(
      "Interactive UI requires `uv`. Install uv and run `uv sync` in the Zace repository."
    );
  }

  const textualCheck = spawnSync("uv", ["run", "python", "-c", "import textual"], {
    cwd: projectRoot,
    env: process.env,
    stdio: "ignore",
  });

  if (textualCheck.status !== 0) {
    throw new Error(
      "Interactive UI requires Python dependencies (Textual). Run `uv sync` and retry."
    );
  }
}

export function isInteractiveTerminal(): boolean {
  const term = process.env.TERM?.toLowerCase();
  if (term === "dumb") {
    return false;
  }

  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export async function runChatUi(input: RunChatUiInput): Promise<void> {
  const projectRoot = process.cwd();
  ensureTextualRuntimeAvailable(projectRoot);

  const uiConfig = {
    executorAnalysis: input.config.executorAnalysis,
    stream: input.config.stream,
    verbose: input.config.verbose,
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "uv",
      [
        "run",
        "python",
        "-m",
        "zace_tui.main",
        "--session-file-path",
        input.sessionFilePath,
        "--session-id",
        input.sessionId,
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ZACE_BRIDGE_COMMAND_JSON: JSON.stringify(["bun", "run", "src/ui/bridge/entry.ts"]),
          ZACE_UI_CONFIG_JSON: JSON.stringify(uiConfig),
          ZACE_WORKDIR: projectRoot,
        },
        stdio: "inherit",
      }
    );

    child.once("error", (error) => {
      reject(
        new Error(
          `Failed to launch Textual UI: ${error.message}. Ensure Python + uv are installed and run \`uv sync\`.`
        )
      );
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Textual UI exited unexpectedly (code=${String(code)} signal=${String(signal)}). Check stderr for details.`
        )
      );
    });
  });
}
