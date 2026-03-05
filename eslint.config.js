import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import perfectionist from "eslint-plugin-perfectionist";

const RESTRICTED_SIDE_EFFECT_IMPORT_PATHS = [
    {
        message: "Import side-effect modules via src/tools/* wrappers instead.",
        name: "child_process"
    },
    {
        message: "Import side-effect modules via src/tools/* wrappers instead.",
        name: "fs"
    },
    {
        message: "Import side-effect modules via src/tools/* wrappers instead.",
        name: "fs/promises"
    },
    {
        message: "Import side-effect modules via src/tools/* wrappers instead.",
        name: "node:child_process"
    },
    {
        message: "Import side-effect modules via src/tools/* wrappers instead.",
        name: "node:fs"
    },
    {
        message: "Import side-effect modules via src/tools/* wrappers instead.",
        name: "node:fs/promises"
    }
];

const TEMPORARY_SIDE_EFFECT_RULE_EXCEPTIONS = [
    "src/agent/approval.ts",
    "src/agent/completion.ts",
    "src/agent/core/run-loop/command-safety.ts",
    "src/agent/planner/invalid-artifacts.ts",
    "src/config/env.ts",
    "src/lsp/client.ts",
    "src/lsp/config.ts",
    "src/tools/**/*.ts",
    "src/ui/index.ts"
];

export default [
    /* 🚫 Global ignores */
    {
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/.bun/**",
            "**/bun.lockb"
        ]
    },

    /* Base JS rules */
    js.configs.recommended,

    /* TypeScript rules */
    {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module"
            },
            globals: {
                Bun: "readonly",
                Buffer: "readonly",
                clearTimeout: "readonly",
                console: "readonly",
                exports: "readonly",
                fetch: "readonly",
                TextDecoder: "readonly",
                global: "readonly",
                module: "readonly",
                process: "readonly",
                require: "readonly",
                setTimeout: "readonly",
                Timer: "readonly",
                __dirname: "readonly",
                __filename: "readonly"
            }
        },
        plugins: {
            "@typescript-eslint": tsPlugin,
            perfectionist
        },
        rules: {
            /* 🧠 TypeScript sanity */
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_"
                }
            ],
            "@typescript-eslint/no-explicit-any": "warn",

            /* 🔥 Perfectionist rules */
            "perfectionist/sort-imports": [
                "error",
                {
                    type: "natural",
                    groups: [
                        "type-import",
                        ["value-builtin", "value-external"],
                        "type-internal",
                        "value-internal",
                        ["type-parent", "type-sibling", "type-index"],
                        ["value-parent", "value-sibling", "value-index"],
                        "ts-equals-import",
                        "unknown"
                    ],
                    newlinesBetween: 1
                }
            ],


            "perfectionist/sort-objects": ["error", { type: "natural" }],
            "perfectionist/sort-union-types": ["error", { type: "natural" }],
            "perfectionist/sort-intersection-types": ["error", { type: "natural" }],
            "perfectionist/sort-enums": ["error", { type: "natural" }]
        }
    },
    {
        files: ["src/**/*.ts", "src/**/*.tsx"],
        rules: {
            /*
             * Phase 1 guardrail: prevent adding new side-effect imports/env access
             * outside approved boundary files. Existing exceptions are temporary.
             */
            "no-restricted-imports": [
                "error",
                {
                    paths: RESTRICTED_SIDE_EFFECT_IMPORT_PATHS
                }
            ],
            "no-restricted-properties": [
                "error",
                {
                    message: "Use config/env helpers instead of direct process.env access.",
                    object: "process",
                    property: "env"
                },
                {
                    message: "Use src/tools/* shell wrappers instead of direct Bun.$ usage.",
                    object: "Bun",
                    property: "$"
                },
                {
                    message: "Use src/tools/* shell wrappers instead of direct Bun.file usage.",
                    object: "Bun",
                    property: "file"
                },
                {
                    message: "Use src/tools/* shell wrappers instead of direct Bun.shell usage.",
                    object: "Bun",
                    property: "shell"
                },
                {
                    message: "Use src/tools/* shell wrappers instead of direct Bun.spawn usage.",
                    object: "Bun",
                    property: "spawn"
                },
                {
                    message: "Use src/tools/* shell wrappers instead of direct Bun.spawnSync usage.",
                    object: "Bun",
                    property: "spawnSync"
                },
                {
                    message: "Use src/tools/* shell wrappers instead of direct Bun.write usage.",
                    object: "Bun",
                    property: "write"
                }
            ]
        }
    },
    {
        files: TEMPORARY_SIDE_EFFECT_RULE_EXCEPTIONS,
        rules: {
            "no-restricted-imports": "off",
            "no-restricted-properties": "off"
        }
    }
];
