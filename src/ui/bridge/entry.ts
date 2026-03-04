import type { BridgeClientMessage } from "./protocol";

import { LlmClient } from "../../llm/client";
import { getAgentConfig } from "../../types/config";
import { BridgeController } from "./controller";
import { startLineJsonRpcServer } from "./line-json-rpc";

function redirectConsoleToStderr(): void {
  const methods: Array<"debug" | "error" | "info" | "log" | "warn"> = [
    "debug",
    "error",
    "info",
    "log",
    "warn",
  ];

  methods.forEach((method) => {
    console[method] = (...args: unknown[]) => {
      const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
      process.stderr.write(`${line}\n`);
    };
  });
}

redirectConsoleToStderr();

let controller: BridgeController | undefined;

const server = startLineJsonRpcServer({
  onClose: async () => {
    await controller?.shutdown();
    process.exit(0);
  },
  onRequest: async (request: BridgeClientMessage) => {
    if (request.method === "init") {
      const config = getAgentConfig();
      const client = new LlmClient(config);
      controller = new BridgeController({
        client,
        config,
        emitEvent: (event) => {
          server.sendEvent(event);
        },
        sessionFilePath: request.params.sessionFilePath,
        sessionId: request.params.sessionId,
      });

      return await controller.init();
    }

    if (!controller) {
      throw new Error("Bridge controller is not initialized. Send init first.");
    }

    switch (request.method) {
      case "submit":
        return await controller.submit(request.params);
      case "interrupt":
        return await controller.interrupt();
      case "list_sessions":
        return await controller.listSessions();
      case "switch_session":
        return await controller.switchSession(request.params.sessionId);
      case "new_session":
        return await controller.newSession();
      case "approval_reply":
        return await controller.approvalReply(request.params.decision);
      case "permission_reply":
        return await controller.permissionReply(request.params.reply);
      case "shutdown": {
        await controller.shutdown();
        setTimeout(() => {
          process.exit(0);
        }, 10);
        return {
          ok: true,
        };
      }
      default:
        throw new Error("Unsupported bridge request.");
    }
  },
});

void server;
