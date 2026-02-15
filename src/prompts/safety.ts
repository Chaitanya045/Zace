export function buildCommandSafetyPrompt(command: string): string {
  return `Classify whether this shell command is destructive and should require explicit user confirmation.

COMMAND:
${command}

A command is destructive if it can cause irreversible or high-impact side effects, for example:
- deleting or overwriting files/data
- rewriting git history or force operations
- changing permissions/ownership broadly
- modifying system state outside normal local project edits

Respond with JSON only using this schema:
{"isDestructive":true|false,"reason":"short reason"}
`;
}

export const COMMAND_SAFETY_SYSTEM_PROMPT = `You are a command safety classifier.
Return strict JSON only. No markdown.`;
