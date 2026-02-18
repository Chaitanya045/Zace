import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";

type ProcessSignal = Exclude<Parameters<typeof process.kill>[1], number | undefined>;

export interface SpawnedCommandResult {
  aborted: boolean;
  durationMs: number;
  exitCode: null | number;
  lifecycleEvent: "abort" | "none" | "timeout";
  signal: null | ProcessSignal;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

type AbortSignalLike = {
  aborted: boolean;
  addEventListener: (
    type: "abort",
    listener: () => void,
    options?: {
      once?: boolean;
    }
  ) => void;
  removeEventListener: (type: "abort", listener: () => void) => void;
};

function getShellInvocation(command: string): { args: string[]; executable: string } {
  if (process.platform === "win32") {
    return {
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      executable: "powershell.exe",
    };
  }

  return {
    args: ["-c", command],
    executable: "sh",
  };
}

function buildCommandEnvironment(commandEnv?: Record<string, string>): Record<string, string | undefined> {
  if (!commandEnv) {
    return process.env as Record<string, string | undefined>;
  }

  return {
    ...process.env,
    ...commandEnv,
  };
}

function collectStreamOutput(stream: Readable): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    stream.on("error", rejectOutput);
    stream.on("end", () => {
      resolveOutput(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function killUnixProcessTree(pid: number, signal: ProcessSignal): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fallback to direct process kill if process group kill is unavailable.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // process already exited
  }
}

async function killWindowsProcessTree(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolveKill) => {
    const killArgs = ["/PID", String(pid), "/T"];
    if (force) {
      killArgs.push("/F");
    }
    const killProcess = spawn("taskkill", killArgs, {
      stdio: "ignore",
      windowsHide: true,
    });
    killProcess.once("error", () => {
      resolveKill();
    });
    killProcess.once("exit", () => {
      resolveKill();
    });
  });
}

async function killProcessTree(pid: number, signal: ProcessSignal): Promise<void> {
  if (pid <= 0 || !Number.isFinite(pid)) {
    return;
  }

  if (process.platform === "win32") {
    await killWindowsProcessTree(pid, signal === "SIGKILL");
    return;
  }

  killUnixProcessTree(pid, signal);
}

export function getShellLabel(): string {
  if (process.platform === "win32") {
    return "powershell";
  }

  return "sh";
}

export async function runSpawnedShellCommand(input: {
  abortSignal?: AbortSignalLike;
  command: string;
  commandEnv?: Record<string, string>;
  timeoutMs: number;
  workingDirectory: string;
}): Promise<SpawnedCommandResult> {
  const { args, executable } = getShellInvocation(input.command);
  const processHandle: ChildProcessWithoutNullStreams = spawn(executable, args, {
    cwd: input.workingDirectory,
    detached: process.platform !== "win32",
    env: buildCommandEnvironment(input.commandEnv),
    stdio: "pipe",
    windowsHide: true,
  });

  const startedAt = Date.now();
  const stdoutPromise = collectStreamOutput(processHandle.stdout);
  const stderrPromise = collectStreamOutput(processHandle.stderr);

  let lifecycleEvent: SpawnedCommandResult["lifecycleEvent"] = "none";
  let aborted = false;
  let terminationRequested = false;
  let timedOut = false;
  let forceKillTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const terminateProcessTree = (event: "abort" | "timeout"): void => {
    if (terminationRequested) {
      return;
    }
    terminationRequested = true;
    lifecycleEvent = event;
    aborted = event === "abort";
    timedOut = event === "timeout";
    const pid = processHandle.pid ?? 0;

    void killProcessTree(pid, "SIGTERM").finally(() => {
      forceKillTimeoutId = setTimeout(() => {
        void killProcessTree(pid, "SIGKILL");
      }, 1_000);
    });
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (input.timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      terminateProcessTree("timeout");
    }, input.timeoutMs);
  }

  const abortListener = (): void => {
    terminateProcessTree("abort");
  };
  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      abortListener();
    } else {
      input.abortSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  const exitInfo = await new Promise<{ exitCode: null | number; signal: null | ProcessSignal }>(
    (resolveExit, rejectExit) => {
      processHandle.once("error", (error) => {
        rejectExit(error);
      });
      processHandle.once("close", (exitCode, signal) => {
        resolveExit({
          exitCode,
          signal,
        });
      });
    }
  ).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (forceKillTimeoutId) {
      clearTimeout(forceKillTimeoutId);
    }
    if (input.abortSignal) {
      input.abortSignal.removeEventListener("abort", abortListener);
    }
  });

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const durationMs = Math.max(0, Date.now() - startedAt);

  return {
    aborted,
    durationMs,
    exitCode: exitInfo.exitCode,
    lifecycleEvent,
    signal: exitInfo.signal,
    stderr,
    stdout,
    timedOut,
  };
}

export type { ProcessSignal };
