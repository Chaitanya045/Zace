type SessionTitlePromptInput = {
  sessions: Array<{
    firstUserMessage: string;
    sessionId: string;
  }>;
};

export const SESSION_TITLE_SYSTEM_PROMPT = [
  "You generate concise session names for coding assistant chats.",
  "Rules:",
  "1. Return strict JSON only.",
  '2. Output format: {"titles":[{"sessionId":"<id>","title":"<name>"}]}',
  "3. Keep each title short and specific (max 60 chars).",
  "4. Single line only. No quotes around the title text.",
  "5. Do not invent details not implied by the message.",
].join("\n");

export function buildSessionTitlePrompt(input: SessionTitlePromptInput): string {
  const lines = input.sessions
    .map((session) => `- ${session.sessionId}: ${session.firstUserMessage}`)
    .join("\n");

  return [
    "Generate titles for these sessions based on the first user message.",
    "Sessions:",
    lines,
  ].join("\n");
}
