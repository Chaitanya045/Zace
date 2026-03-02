function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function wildcardToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim();
  if (!normalized) {
    return /^$/u;
  }

  const parts = normalized.split("*").map((part) => escapeRegexLiteral(part));
  const source = `^${parts.join(".*")}$`;
  return new RegExp(source, "u");
}

export function wildcardMatch(input: {
  pattern: string;
  value: string;
}): boolean {
  return wildcardToRegExp(input.pattern).test(input.value);
}
