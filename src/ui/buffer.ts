export const STREAM_BUFFER_INTERVAL_MS = 33;

type StreamBufferInput<Key extends string> = {
  intervalMs?: number;
  onFlush: (key: Key, chunk: string) => void;
};

export type StreamBuffer<Key extends string> = {
  append: (key: Key, chunk: string) => void;
  dispose: () => void;
  flushAll: () => void;
  flushKey: (key: Key) => void;
};

export function createStreamBuffer<Key extends string>(
  input: StreamBufferInput<Key>
): StreamBuffer<Key> {
  const pendingChunks = new Map<Key, string>();
  const intervalMs = input.intervalMs ?? STREAM_BUFFER_INTERVAL_MS;

  const flushKey = (key: Key): void => {
    const chunk = pendingChunks.get(key);
    if (!chunk) {
      return;
    }

    pendingChunks.delete(key);
    input.onFlush(key, chunk);
  };

  const flushAll = (): void => {
    for (const key of pendingChunks.keys()) {
      flushKey(key);
    }
  };

  const timer = globalThis.setInterval(() => {
    flushAll();
  }, intervalMs);

  const append = (key: Key, chunk: string): void => {
    if (!chunk) {
      return;
    }

    const current = pendingChunks.get(key) ?? "";
    pendingChunks.set(key, `${current}${chunk}`);
  };

  const dispose = (): void => {
    globalThis.clearInterval(timer);
    flushAll();
    pendingChunks.clear();
  };

  return {
    append,
    dispose,
    flushAll,
    flushKey,
  };
}
