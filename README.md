# Zace

Zace is a CLI coding agent built with Bun + TypeScript.  
It runs as a planner-executor loop where the model decides the next action and all side effects go through typed tools.

## Current behavior

- Shell-only tool surface (`execute_command`)
- Cross-platform shell execution:
  - Unix-like: `sh -c`
  - Windows: `powershell.exe -Command`
- Runtime script reuse under `.zace/runtime/scripts`
- Script metadata registry at `.zace/runtime/scripts/registry.tsv`
- OpenRouter-backed LLM client

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
AGENT_STREAM=false
AGENT_VERBOSE=false
LLM_PROVIDER=openrouter
```

## Usage

Run the agent:

```bash
bun run src/index.ts "your task here"
```

Start interactive chat mode:

```bash
bun run src/index.ts chat
```

With common options:

```bash
bun run src/index.ts "fix lint errors" --stream --verbose --executor-analysis always
```

Resume a persistent conversation:

```bash
bun run src/index.ts chat --session my_session
```

CLI options:

- `--executor-analysis <mode>`: `always | on_failure | never`
- `--session <id>`: persist and resume conversation from `.zace/sessions/<id>.jsonl`
- `-s, --stream`: stream model output
- `-v, --verbose`: verbose logs

## Runtime script protocol

The planner is instructed to create and reuse scripts when needed.

- Script folder: `.zace/runtime/scripts`
- Registry file: `.zace/runtime/scripts/registry.tsv`
- Script metadata markers in command output:
  - `ZACE_SCRIPT_REGISTER|<script_id>|<script_path>|<purpose>`
  - `ZACE_SCRIPT_USE|<script_id>`

Zace discovers existing scripts on startup and syncs registry metadata during execution.

## Sessions

Session files are stored as JSONL:

- Directory: `.zace/sessions`
- File: `.zace/sessions/<session-id>.jsonl`
- Stored records:
  - user/assistant messages
  - run summaries
  - run metadata (state, steps, duration, timestamps, task)

Use the same `--session <id>` value across runs to continue conversation context.

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

## Project structure

```text
src/
├── agent/       # planner/executor loop + state + runtime script registry logic
├── cli/         # commander CLI wiring
├── config/      # environment validation
├── llm/         # OpenRouter client abstraction
├── prompts/     # system/planner/executor prompts
├── tools/       # typed tool boundary (shell-only)
├── types/       # shared contracts
└── utils/       # logger/errors
```
