import { useEffect, useRef } from "react";

import { createStreamBuffer, type StreamBuffer } from "../buffer";

type UseBufferedStreamInput<Key extends string> = {
  intervalMs?: number;
  onFlush: (key: Key, chunk: string) => void;
};

export function useBufferedStream<Key extends string>(
  input: UseBufferedStreamInput<Key>
): StreamBuffer<Key> {
  const onFlushRef = useRef(input.onFlush);
  onFlushRef.current = input.onFlush;

  const bufferRef = useRef<null | StreamBuffer<Key>>(null);
  if (!bufferRef.current) {
    bufferRef.current = createStreamBuffer<Key>({
      intervalMs: input.intervalMs,
      onFlush: (key, chunk) => {
        onFlushRef.current(key, chunk);
      },
    });
  }

  useEffect(() => {
    return () => {
      bufferRef.current?.dispose();
    };
  }, []);

  return bufferRef.current;
}
