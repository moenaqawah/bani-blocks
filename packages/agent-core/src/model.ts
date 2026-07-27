import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { AppError } from "@bani/shared";

export interface ModelEnv {
  AI_PROVIDER: string;
  AI_MODEL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GROQ_API_KEY?: string;
}

/**
 * Return a provider-agnostic LanguageModel based on the AI_PROVIDER env var.
 * Only `google` needs to work on day one; the other three branches must compile
 * and be reachable, because swapping providers per client is the whole point.
 */
export function getModel(env: ModelEnv) {
  switch (env.AI_PROVIDER) {
    case "google":
      return createGoogleGenerativeAI({
        apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      })(env.AI_MODEL);

    case "openai":
      if (!env.OPENAI_API_KEY) {
        throw new AppError("CONFIG", "OPENAI_API_KEY is required when AI_PROVIDER=openai");
      }
      return createOpenAI({ apiKey: env.OPENAI_API_KEY })(env.AI_MODEL);

    case "anthropic":
      if (!env.ANTHROPIC_API_KEY) {
        throw new AppError("CONFIG", "ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");
      }
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(env.AI_MODEL);

    case "groq":
      if (!env.GROQ_API_KEY) {
        throw new AppError("CONFIG", "GROQ_API_KEY is required when AI_PROVIDER=groq");
      }
      return createGroq({ apiKey: env.GROQ_API_KEY })(env.AI_MODEL);

    default:
      throw new AppError("CONFIG", `unknown AI_PROVIDER: ${env.AI_PROVIDER}`);
  }
}
