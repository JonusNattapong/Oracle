/**
 * Pluggable embedding provider interface.
 * Supports Ollama, Voyage, OpenAI, Gemini.
 */
export interface EmbeddingProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  embed(text: string): Promise<number[]>;
}

/**
 * Ollama local embedding (default, no cost).
 */
export class OllamaEmbedding implements EmbeddingProvider {
  name = "ollama";
  private endpoint: string;

  constructor(endpoint = "http://localhost:11434") {
    this.endpoint = endpoint;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.endpoint}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const data = (await res.json()) as { embedding: number[] };
    return data.embedding;
  }
}

/**
 * Voyage AI embeddings (requires API key).
 */
export class VoyageEmbedding implements EmbeddingProvider {
  name = "voyage";
  private apiKey: string;
  private model = "voyage-3";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: text }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`Voyage error: ${res.status}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }
}

/**
 * OpenAI embeddings (requires API key).
 */
export class OpenAIEmbedding implements EmbeddingProvider {
  name = "openai";
  private apiKey: string;
  private model = "text-embedding-3-small";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: text }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }
}

/**
 * Google Gemini embeddings (requires API key).
 */
export class GeminiEmbedding implements EmbeddingProvider {
  name = "gemini";
  private apiKey: string;
  private model = "models/embedding-001";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
    const data = (await res.json()) as { embedding: { values: number[] } };
    return data.embedding.values;
  }
}

/**
 * Provider registry with auto-detection.
 */
export class EmbeddingProviderRegistry {
  private providers: Map<string, EmbeddingProvider> = new Map();
  private available: EmbeddingProvider | null = null;

  register(provider: EmbeddingProvider): void {
    this.providers.set(provider.name, provider);
  }

  async detectAvailable(): Promise<EmbeddingProvider | null> {
    if (this.available) return this.available;

    // Try in order: Ollama (local), Voyage, OpenAI, Gemini
    for (const [, provider] of this.providers) {
      try {
        if (await provider.isAvailable()) {
          this.available = provider;
          return provider;
        }
      } catch {
        // Continue to next
      }
    }

    return null;
  }

  getProvider(name: string): EmbeddingProvider | undefined {
    return this.providers.get(name);
  }

  listAvailable(): string[] {
    return Array.from(this.providers.keys());
  }
}

/** Global registry instance. */
export const globalRegistry = new EmbeddingProviderRegistry();

// Auto-register built-in providers
globalRegistry.register(new OllamaEmbedding());
if (process.env.VOYAGE_API_KEY) {
  globalRegistry.register(new VoyageEmbedding(process.env.VOYAGE_API_KEY));
}
if (process.env.OPENAI_API_KEY) {
  globalRegistry.register(new OpenAIEmbedding(process.env.OPENAI_API_KEY));
}
if (process.env.GEMINI_API_KEY) {
  globalRegistry.register(new GeminiEmbedding(process.env.GEMINI_API_KEY));
}
