# AGENTS.md – Zace Coding Agent Repository Overview

## Agent Personality

You are a **precise, disciplined, and safety-first coding agent**.

- Think step by step and prefer small, reversible changes.
- Never assume project intent — infer from code, config, and prompts.
- Be explicit about uncertainty and ask for clarification when required.
- Prefer correctness, determinism, and clarity over cleverness.
- You may reason internally, but only act through defined tools.
- Never perform destructive actions without explicit user intent.
- Follow existing patterns in the repository strictly.

You are not a chatbot.  
You are an **autonomous coding agent operating in a local codebase**.

---

## Project Description

**Zace** is a CLI coding agent built with **Bun** and **TypeScript**.

Zace operates as a **planner–executor agent** that:

- Interprets a user’s task
- Plans incremental code changes
- Uses a constrained set of tools (filesystem, shell, git)
- Iterates until the task is complete or blocked

Zace is designed to be:

- Deterministic
- Auditable
- Safe by default
- Model-agnostic

The agent **never directly touches the system** — all side effects are mediated through explicit tools.

---

## Technology Stack

### Runtime & Language

- **Bun**: JavaScript runtime, package manager, and task runner  
- **TypeScript**: Strictly typed development with no implicit `any`

### CLI & DX

- **Commander**: CLI argument parsing and subcommands  
- **dotenv**: Environment variable loading  

### Agent Safety & Validation

- **Zod**: Runtime schema validation for:
  - Tool calls
  - Environment variables
  - Agent state

### Code Quality

- **ESLint v9 (Flat Config)**: Linting with explicit globals and no hidden defaults  
- **eslint-plugin-perfectionist**: Deterministic ordering for imports, objects, unions, and enums  
- **Prettier**: Formatting only (no responsibility overlap with ESLint)  

---

## Project Architecture

### High-Level Design

User Intent  
↓  
Planner (LLM)  
↓  
Executor (Tool Calls)  
↓  
State + Memory  
↓  
Repeat  

The LLM **never performs side effects directly**.

---

### Directory Structure


```text
src/
├── index.ts              # CLI entrypoint (no business logic)
│
├── cli/                  # CLI wiring and command definitions
│   └── program.ts
│
├── agent/                # Core agent logic
│   ├── loop.ts           # Planner–executor loop
│   ├── planner.ts        # Task planning
│   ├── executor.ts       # Tool execution orchestration
│   ├── state.ts          # Agent state machine
│   └── memory.ts         # In-memory messages & summaries
│
├── llm/                  # Model abstraction layer
│   ├── client.ts         # LLM client wrapper
│   └── types.ts          # Request/response types
│
├── tools/                # Side-effect boundary
│   ├── fs.ts             # File system operations
│   ├── shell.ts          # Shell command execution
│   ├── git.ts            # Git helpers (status, diff)
│   └── index.ts          # Tool registry
│
├── prompts/              # Versioned prompts
│   ├── system.ts
│   ├── planner.ts
│   └── executor.ts
│
├── types/                # Shared contracts
│   ├── tool.ts           # Zod schemas for tool calls
│   ├── agent.ts          # Agent state types
│   └── config.ts         # Runtime config types
│
├── config/               # Boot-time configuration
│   └── env.ts            # Environment validation (Zod)
│
└── utils/                # Pure utilities
    ├── logger.ts
    └── errors.ts



---

## Key Architectural Rules

### 1. Tool Boundary (Critical)

- The agent **must not** import `fs`, `child_process`, or Bun shell APIs directly.
- All side effects **must** go through `src/tools/*`.
- Tools are:
  - Named
  - Typed
  - Zod-validated
  - Auditable

---

### 2. Memory Model

Zace uses **ephemeral, in-memory memory by default**:

- Messages exist only for the lifetime of a single run
- File summaries are cached during execution
- No database is used in Phase 1

Persistence (if added later) must:

- Be filesystem-based first
- Be explicit and opt-in
- Never store raw chain-of-thought

---

### 3. Planner vs Executor

Planning and execution are intentionally split:

**Planner**
- Understands the task
- Decides *what* to do

**Executor**
- Decides *how* to do it
- Invokes tools
- Handles errors and retries

Never merge these responsibilities.

---

### 4. Prompt Discipline

Prompts are **first-class code**:

- Versioned
- Reviewed
- Minimal
- Explicit about constraints

Never inline prompts inside logic.

---

## Development Workflow

### Local Development

```bash
# Install dependencies
bun install

# Run the CLI locally
bun run src/index.ts "your task here"

# Run linting
bun lint

# Auto-fix lint issues
bun lint:fix
```

---

## Linting & Formatting

This project uses ESLint flat config exclusively.

- No `.eslintrc`
- No `.eslintignore`
- All ignores live in `eslint.config.js`
- Globals (`console`, `process`, `Bun`) are explicitly declared
- If lint fails, fix the code, not the rules.

---

## Contribution Guidelines

These rules exist to keep the agent predictable, safe, and maintainable.

### 1. General Principles

- Prefer clarity over cleverness
- Keep diffs minimal and reviewable
- Avoid implicit behavior
- Never bypass validation layers
- Favor small, composable functions
- Fail fast and loudly on invalid state

### 2. TypeScript Rules

- `strict` mode is non-negotiable
- No `any` unless justified and documented
- Prefer discriminated unions
- Use Zod schemas as the source of truth

### 3. Agent Logic Rules

- The agent loop must be bounded (max steps)
- Every tool call must be validated
- Every tool result must be fed back into memory
- The agent must stop when blocked or uncertain

### 4. Error Handling

- Throw errors, don't swallow them
- Errors should be descriptive and actionable
- Do not hide tool failures
- Prefer early termination over guessing

### 5. Configuration & Environment

- All environment variables must be validated at startup
- Missing or invalid config should crash immediately
- Never access `process.env` directly outside `config/env.ts`

## When Unsure

If you are uncertain:

- Read existing code and follow the pattern
- Prefer the safer option
- Ask the user for clarification
- Do nothing rather than guess

---

## Final Note

Zace is intentionally conservative.

Speed, intelligence, and persistence come after:

- Safety
- Determinism
- Control

Build the agent you would trust to touch your own production code.