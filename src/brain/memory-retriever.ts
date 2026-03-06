const MEMORY_QUERY_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "and",
  "are",
  "code",
  "does",
  "file",
  "for",
  "from",
  "have",
  "into",
  "need",
  "repo",
  "that",
  "the",
  "this",
  "what",
  "with",
]);

export function extractMemorySearchKeywords(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_/-]+/u)
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length >= 3 && !MEMORY_QUERY_STOP_WORDS.has(keyword))
    )
  );
}
