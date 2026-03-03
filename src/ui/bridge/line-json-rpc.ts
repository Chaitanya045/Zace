import { createInterface } from "node:readline";

import type { BridgeClientMessage, BridgeEvent } from "./protocol";

import {
  bridgeClientMessageSchema,
  bridgeEventEnvelopeSchema,
  bridgeResponseSchema,
} from "./protocol";

type StartLineJsonRpcServerInput = {
  onClose?: () => Promise<void> | void;
  onRequest: (request: BridgeClientMessage) => Promise<unknown>;
};

export type LineJsonRpcServer = {
  sendEvent: (event: BridgeEvent) => void;
};

function writeResponse(payload: unknown): void {
  const validated = bridgeResponseSchema.safeParse(payload);
  if (!validated.success) {
    process.stderr.write(`Invalid bridge response payload: ${validated.error.message}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(validated.data)}\n`);
}

export function startLineJsonRpcServer(input: StartLineJsonRpcServerInput): LineJsonRpcServer {
  const rl = createInterface({
    crlfDelay: Infinity,
    input: process.stdin,
  });

  const sendEvent = (event: BridgeEvent): void => {
    const envelope = {
      event,
      type: "event" as const,
    };
    const validated = bridgeEventEnvelopeSchema.safeParse(envelope);
    if (!validated.success) {
      process.stderr.write(`Invalid bridge event payload: ${validated.error.message}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify(validated.data)}\n`);
  };

  rl.on("line", (line) => {
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        sendEvent({
          message: "Bridge received invalid JSON request.",
          type: "error",
        });
        return;
      }

      const validated = bridgeClientMessageSchema.safeParse(parsed);
      if (!validated.success) {
        sendEvent({
          message: `Bridge request validation failed: ${validated.error.message}`,
          type: "error",
        });
        return;
      }

      const request = validated.data;
      try {
        const result = await input.onRequest(request);
        writeResponse({
          id: request.id,
          result,
          success: true as const,
          type: "response" as const,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeResponse({
          error: message,
          id: request.id,
          success: false as const,
          type: "response" as const,
        });
      }
    })();
  });

  rl.on("close", () => {
    void input.onClose?.();
  });

  return {
    sendEvent,
  };
}
