import { afterEach, describe, expect, test } from "bun:test";

import { createStreamBuffer } from "../../src/ui/buffer";

const TEST_INTERVAL_MS = 5;

describe("createStreamBuffer", () => {
  afterEach(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, TEST_INTERVAL_MS * 3);
    });
  });

  test("flushes buffered chunks on interval ticks", async () => {
    const flushed: Array<{ chunk: string; key: string }> = [];
    const buffer = createStreamBuffer<string>({
      intervalMs: TEST_INTERVAL_MS,
      onFlush: (key, chunk) => {
        flushed.push({ chunk, key });
      },
    });

    buffer.append("planner", "hello");
    buffer.append("planner", " world");

    await new Promise((resolve) => {
      setTimeout(resolve, TEST_INTERVAL_MS * 4);
    });

    buffer.dispose();

    expect(flushed.length).toBeGreaterThanOrEqual(1);
    expect(flushed[0]).toEqual({
      chunk: "hello world",
      key: "planner",
    });
  });

  test("flushKey emits final chunk immediately", async () => {
    const flushed: Array<{ chunk: string; key: string }> = [];
    const buffer = createStreamBuffer<string>({
      intervalMs: TEST_INTERVAL_MS * 20,
      onFlush: (key, chunk) => {
        flushed.push({ chunk, key });
      },
    });

    buffer.append("executor", "done");
    buffer.flushKey("executor");
    buffer.dispose();

    expect(flushed).toEqual([
      {
        chunk: "done",
        key: "executor",
      },
    ]);
  });
});
