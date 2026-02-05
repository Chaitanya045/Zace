import { z } from "zod";

const envSchema = z.object({

    AGENT_MAX_STEPS: z.coerce.number().int().positive().default(10),
    AGENT_STREAM: z.coerce.boolean().default(false),
    AGENT_VERBOSE: z.coerce.boolean().default(false),
    LLM_PROVIDER: z.literal("openrouter"),

    OPENROUTER_API_KEY: z.string().min(1),
    OPENROUTER_MODEL: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("❌ Invalid environment configuration:");
    console.error(z.treeifyError(parsed.error));
    process.exit(1);
}

export const env = parsed.data;