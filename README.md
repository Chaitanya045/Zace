# Zace

Zace is a CLI coding agent built with Bun + TypeScript.  
It runs as a planner-executor loop where the model decides the next action and all side effects go through typed tools.

## Current behavior

- Tool surface:
  - `execute_command`
  - `search_session_messages`
  - `write_session_message`
- Cross-platform shell execution:
  - Unix-like: `sh -c`
  - Windows: `powershell.exe -Command`
- Runtime script reuse under `.zace/runtime/scripts`
- Script metadata registry at `.zace/runtime/scripts/registry.tsv`
- OpenRouter-backed LLM client
- Provider-compatibility transport normalization for planner/executor/safety/compaction LLM calls
- Ink-based chat UI with shadcn-inspired minimal terminal design
- Runtime project-doc discovery (no fixed built-in doc path list)
- Automatic context compaction when planner context reaches 80% usage
- Session message journaling for active `--session` runs
- Session history tools: `search_session_messages`, `write_session_message`
- Non-TTY automatic fallback to plain chat mode
- Runtime LSP diagnostics feedback after file changes (via marker + git delta)

## Requirements

- Bun (1.3+ recommended)
- OpenRouter API key + model

## Setup

1. Install dependencies:

```bash
bun install
```

2. Configure environment variables (for example in `.env`):

```bash
OPENROUTER_API_KEY=your_api_key
OPENROUTER_MODEL=your_model_id

# optional overrides
AGENT_MAX_STEPS=10
AGENT_EXECUTOR_ANALYSIS=on_failure
AGENT_STREAM=true
AGENT_VERBOSE=false
AGENT_LSP_ENABLED=true
AGENT_LSP_SERVER_CONFIG_PATH=.zace/runtime/lsp/servers.json
AGENT_LSP_WAIT_FOR_DIAGNOSTICS_MS=3000
AGENT_LSP_MAX_DIAGNOSTICS_PER_FILE=20
AGENT_LSP_MAX_FILES_IN_OUTPUT=5
AGENT_LSP_AUTO_PROVISION=true
AGENT_LSP_PROVISION_MAX_ATTEMPTS=2
AGENT_LSP_BOOTSTRAP_BLOCK_ON_FAILED=true
AGENT_COMPACTION_ENABLED=true
AGENT_COMPACTION_TRIGGER_RATIO=0.8
AGENT_COMPACTION_PRESERVE_RECENT_MESSAGES=12
AGENT_PLANNER_OUTPUT_MODE=auto
AGENT_PLANNER_SCHEMA_STRICT=true
AGENT_PLANNER_MAX_INVALID_ARTIFACT_CHARS=4000
AGENT_LLM_COMPAT_NORMALIZE_TOOL_ROLE=true
AGENT_COMPLETION_VALIDATION_MODE=strict
AGENT_COMPLETION_REQUIRE_LSP=false
AGENT_GATE_DISALLOW_MASKING=true
# Optional override if automatic model context lookup fails:
# AGENT_CONTEXT_WINDOW_TOKENS=200000
LLM_PROVIDER=openrouter

# command safety policy
AGENT_REQUIRE_RISKY_CONFIRMATION=true
AGENT_RISKY_CONFIRMATION_TOKEN=ZACE_APPROVE_RISKY
AGENT_COMMAND_ARTIFACTS_DIR=.zace/runtime/logs/commands
AGENT_TOOL_OUTPUT_LIMIT_CHARS=4000
AGENT_COMMAND_ALLOW_PATTERNS=
AGENT_COMMAND_DENY_PATTERNS=
```

## Architecture

- Agent loop orchestration:
  - `/Users/chaitanya/Work/forge/src/agent/loop.ts` (compat facade)
  - `/Users/chaitanya/Work/forge/src/agent/core/run-agent-loop.ts` (runtime orchestration)
- Planner domain:
  - `/Users/chaitanya/Work/forge/src/agent/planner.ts` (compat facade)
  - `/Users/chaitanya/Work/forge/src/agent/planner/plan.ts`
  - `/Users/chaitanya/Work/forge/src/agent/planner/parser.ts`
  - `/Users/chaitanya/Work/forge/src/agent/planner/schema.ts`
  - `/Users/chaitanya/Work/forge/src/agent/planner/repair.ts`
  - `/Users/chaitanya/Work/forge/src/agent/planner/invalid-artifacts.ts`
- Shell tool domain:
  - `/Users/chaitanya/Work/forge/src/tools/shell.ts` (compat facade)
  - `/Users/chaitanya/Work/forge/src/tools/shell/index.ts`
  - `/Users/chaitanya/Work/forge/src/tools/shell/process-lifecycle.ts`
  - `/Users/chaitanya/Work/forge/src/tools/shell/changed-files.ts`
- LLM compatibility pipeline:
  - `/Users/chaitanya/Work/forge/src/llm/compat/index.ts`
  - `/Users/chaitanya/Work/forge/src/llm/compat/normalize-messages.ts`
  - `/Users/chaitanya/Work/forge/src/llm/compat/classify-error.ts`

## Usage

Start chat UI (default command):

```bash
bun run src/index.ts
```

Chat alias (same behavior):

```bash
bun run src/index.ts chat
```

With common options:

```bash
bun run src/index.ts --stream --verbose --executor-analysis always
```

Resume a specific session:

```bash
bun run src/index.ts --session my_session
```

CLI options:

- `--executor-analysis <mode>`: `always | on_failure | never`
- `--session <id>`: use a specific session id; if omitted, a session id is auto-generated
- `-s, --stream`: stream model output
- `-v, --verbose`: verbose logs

Notes:

- `zace` now starts chat mode by default.
- One-shot `zace "<task>"` flow is removed.
- In non-interactive terminals (CI/pipes/dumb TERM), Zace automatically falls back to plain chat mode.

## Command safety policy

Zace enforces command policy at execution time.

- Destructive command detection is LLM-driven.
- If a command is classified destructive, Zace asks for explicit approval with choices:
  - allow once
  - always allow for this session
  - always allow for this workspace
  - deny
- Legacy confirmation token still works: `AGENT_RISKY_CONFIRMATION_TOKEN`.
- Pending approval requests are persisted in the session JSONL and can be resolved on the next user message.
- Deny patterns can hard-block commands.
- Allow patterns can restrict execution to an approved set.

Environment variables:

- `AGENT_REQUIRE_RISKY_CONFIRMATION` (`true|false`)
- `AGENT_RISKY_CONFIRMATION_TOKEN` (default: `ZACE_APPROVE_RISKY`)
- `AGENT_APPROVAL_MEMORY_ENABLED` (`true|false`)
- `AGENT_APPROVAL_RULES_PATH` (default: `.zace/runtime/policy/approvals.json`)
- `AGENT_PENDING_ACTION_MAX_AGE_MS` (default: `3600000`)
- `AGENT_COMMAND_ALLOW_PATTERNS` (regex list separated by `;;`)
- `AGENT_COMMAND_DENY_PATTERNS` (regex list separated by `;;`)

Starter patterns (also included in `.env.example`):

- Denylist:
  - `\bsudo\b`
  - `\bsu\b`
  - `\bcurl\b[^\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b`
  - `\bwget\b[^\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b`
  - `\bmkfs\b`
  - `\bdd\b`
  - `\bshutdown\b`
  - `\breboot\b`
  - `\bpoweroff\b`
- Optional strict allowlist (set only if you want explicit command whitelisting):
  - `^rg\b`
  - `^grep\b`
  - `^git\s+status\b`
  - `^git\s+diff\b`
  - `^bun\s+lint(?::fix)?\b`
  - `^bun\s+-e\b`

## Completion gates

Zace now enforces completion gates before accepting `COMPLETE`.

- No hard-coded lint/typecheck/test commands are used.
- Gates are LLM-driven unless explicitly provided by the user.
- Task-level `DONE_CRITERIA` / `COMPLETION_GATES` parsing is kept only as explicit compatibility fallback.
- Planner can infer checks from any language/project layout and include them in the completion response:
  - `GATES: <command_1>;;<command_2>`
- If any gate fails, the agent continues working instead of completing.
- If no gates are required, planner can explicitly respond with:
  - `GATES: none`
- In `strict` mode, `GATES: none` is blocked after file changes; at least one real validation gate must run after the latest write.
- In `strict` mode, masked gates are rejected (`|| true`, `|| echo`, `; true`, `&& true`, `exit 0`).
- If no gates are supplied, completion is blocked until gates are provided (or explicitly set to `none`).
- The agent should only return `BLOCKED` with an explicit reason if it cannot make the gates pass.

Task-defined gates:

- Add a line in your task:
  - `DONE_CRITERIA: cmd:make lint;;cmd:make test`
- Or custom commands:
  - `DONE_CRITERIA: cmd:pnpm lint,cmd:pnpm test`
- You can also use `;;` as separator for long commands:
  - `DONE_CRITERIA: cmd:poetry run ruff check .;;cmd:poetry run pytest`

## Robust execution

- Retries are LLM-driven per failed attempt (`shouldRetry` + `retryDelayMs` from executor analysis).
- Retries are bounded by remaining step budget and optional command-level arguments:
  - `maxRetries`
  - `retryMaxDelayMs`
- Shell output is captured as full artifacts and summarized with truncation in tool output.
- Full logs are written to `AGENT_COMMAND_ARTIFACTS_DIR` with per-command files:
  - `<id>.stdout.log`
  - `<id>.stderr.log`
  - `<id>.combined.log`
- Tool output includes explicit execution metadata blocks (`[execution]`) including timeout/abort lifecycle state.
- When output is truncated, tool output includes actionable inspection hints (`tail`, `sed`, `rg`) using full artifact paths.
- Truncation limit is controlled by `AGENT_TOOL_OUTPUT_LIMIT_CHARS` (or per-command `outputLimitChars`).

## Runtime script protocol

The planner is instructed to create and reuse scripts when needed.

- Script folder: `.zace/runtime/scripts`
- Registry file: `.zace/runtime/scripts/registry.tsv`
- Script metadata markers in command output:
  - `ZACE_SCRIPT_REGISTER|<script_id>|<script_path>|<purpose>`
  - `ZACE_SCRIPT_USE|<script_id>`
  - `ZACE_FILE_CHANGED|<path>` (one line per modified file)

Zace discovers existing scripts on startup and syncs registry metadata during execution.

## LSP diagnostics feedback

- LSP runtime is generic and server-config driven (no built-in language catalog).
- LLM may only author/update `servers.json`; runtime deterministically validates schema, probes servers, and blocks completion on unresolved bootstrap.
- Server definitions are loaded from:
  - `.zace/runtime/lsp/servers.json`
- The shell tool collects changed files from:
  - marker lines (`ZACE_FILE_CHANGED|<path>`)
  - git snapshot delta (post-run minus pre-run dirty-file set)
- If changed files are found and LSP is enabled, Zace:
  - probes changed files in active LSP clients
  - collects diagnostics
  - appends capped diagnostics blocks into tool output
- Tool artifacts include machine-readable LSP metadata:
  - `lspStatus`
  - `lspStatusReason`
  - `lspProbeAttempted`
  - `lspProbeSucceeded`
- `lspStatus` semantics:
  - `no_active_server` / `failed`: bootstrap required and completion is blocked.
  - `no_applicable_files` / `no_changed_files` / `disabled`: neutral (no bootstrap escalation).
- If no active server is available for applicable source changes, Zace marks LSP bootstrap as pending and blocks `COMPLETE` until `.zace/runtime/lsp/servers.json` is created/updated and diagnostics run again.
- Planner is instructed to generate/update runtime LSP config via shell based on the repository before completing.

Example `servers.json`:

```json
{
  "servers": [
    {
      "id": "typescript",
      "command": ["bunx", "typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"],
      "rootMarkers": ["package.json", "tsconfig.json"]
    }
  ]
}
```

## Sessions

Session files are stored as JSONL:

- Directory: `.zace/sessions`
- File: `.zace/sessions/<session-id>.jsonl`
- Stored records:
  - user/assistant messages
  - run summaries
  - run metadata (state, steps, duration, timestamps, task)
  - pending actions (approval/loop-guard workflow state)
  - approval rules (session/workspace memory)

Use the same `--session <id>` value across runs to continue conversation context.

For active session runs:

- Every in-run memory message is appended to `.zace/sessions/<session-id>.jsonl`.
- The planner can retrieve older context via `search_session_messages`.
- The planner can persist durable checkpoints via `write_session_message`.
- If `--session` is not provided, chat mode creates a valid session id automatically.

## Context compaction

- Zace checks planner prompt usage against the active model context window.
- When usage reaches `AGENT_COMPACTION_TRIGGER_RATIO` (default `0.8`), it asks the model to summarize prior history.
- Memory is compacted to:
  - system prompt
  - compaction summary
  - recent messages (`AGENT_COMPACTION_PRESERVE_RECENT_MESSAGES`)
- Context window is resolved from OpenRouter model metadata; use `AGENT_CONTEXT_WINDOW_TOKENS` as an explicit fallback.
- Compaction works with session history tools, so older details can be fetched from disk on demand.

## UI

- Renderer: Ink (`ink` + `react`)
- Layout: 3-pane minimal interface (header/status, timeline, composer)
- Stream mode: buffered at 33ms for smooth incremental token rendering
- Controls: Enter submit, `/status`, `/reset`, `/exit`, `Ctrl+C`
- Design language: shadcn-inspired terminal style (monochrome + subtle accent)

## Development

Run lint:

```bash
bun lint
```

Auto-fix lint:

```bash
bun lint:fix
```

Format:

```bash
bun run format
```

Type-check:

```bash
bunx tsc --noEmit
```

Run tests:

```bash
bun test
```

## Project structure

```text
src/
├── agent/       # planner/executor loop + state + runtime script registry logic
├── cli/         # commander CLI wiring
├── config/      # environment validation
├── llm/         # OpenRouter client abstraction
├── prompts/     # system/planner/executor prompts
├── tools/       # typed tool boundary (shell + session history)
├── types/       # shared contracts
├── ui/          # Ink UI runtime + plain fallback + theme/components
└── utils/       # logger/errors
```
