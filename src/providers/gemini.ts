/**
 * Google Gemini Provider (v0.7.0)
 * Models: gemini-2.0-flash, gemini-2.0-pro
 */

export interface GeminiConfig {
  apiKey: string;
}

/**
 * Gemini API client via @google/generative-ai
 * TODO: Implement in v0.7.0
 * - Support streaming
 * - Tool use (function calling)
 * - Vision (image inputs)
 * - Fallback gracefully if GEMINI_API_KEY not set
 */
export class GeminiProvider {
  constructor(config: GeminiConfig) {}

  async chat(prompt: string): Promise<string> {
    throw new Error("Not implemented in v0.6.0 — planned for v0.7.0");
  }
}
