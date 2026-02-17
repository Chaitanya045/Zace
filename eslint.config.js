import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import perfectionist from "eslint-plugin-perfectionist";

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
    }
];
