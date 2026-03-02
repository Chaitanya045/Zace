import { PermissionNext } from "./next";

type Key = string;

function makeKey(permission: string, pattern: string): Key {
  return `${permission}::${pattern}`;
}

export type PermissionMemory = {
  allowOnce(permission: string, pattern: string): void;
  consumeOnce(permission: string, pattern: string): boolean;
  rememberAlways(rules: PermissionNext.Ruleset): void;
  ruleset(): PermissionNext.Ruleset;
};

export function createPermissionMemory(initial?: PermissionNext.Ruleset): PermissionMemory {
  const alwaysRules: PermissionNext.Ruleset = [...(initial ?? [])];
  const once = new Set<Key>();

  return {
    allowOnce(permission, pattern) {
      once.add(makeKey(permission, pattern));
    },
    consumeOnce(permission, pattern) {
      const key = makeKey(permission, pattern);
      if (!once.has(key)) {
        return false;
      }
      once.delete(key);
      return true;
    },
    rememberAlways(rules) {
      alwaysRules.push(...rules);
    },
    ruleset() {
      return [...alwaysRules];
    },
  };
}

export function createPermissionMemoryFromPendingReply(input: {
  initial?: PermissionNext.Ruleset;
  reply?: PermissionNext.Reply;
  permission: string;
  patterns: string[];
}): PermissionMemory {
  const memory = createPermissionMemory(input.initial);
  if (!input.reply) {
    return memory;
  }

  if (input.reply === "once") {
    for (const pattern of input.patterns) {
      memory.allowOnce(input.permission, pattern);
    }
    return memory;
  }

  if (input.reply === "always") {
    memory.rememberAlways(
      input.patterns.map((pattern) => ({
        action: "allow" as const,
        pattern,
        permission: input.permission,
      }))
    );
  }

  return memory;
}
