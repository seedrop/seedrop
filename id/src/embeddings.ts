export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface OllamaEmbeddingsOptions {
  /** Base URL of the Ollama HTTP API. Defaults to `http://localhost:11434`. */
  baseURL?: string;
  /** Embedding model name. Defaults to `nomic-embed-text`. */
  model?: string;
  /** Optional fetch override (useful for testing). */
  fetchImpl?: typeof fetch;
}

interface OllamaEmbedResponse {
  embeddings: number[][];
}

/**
 * Default embedding provider — talks to a local Ollama daemon's native
 * batch endpoint (POST {baseURL}/api/embed). Matches the CCL research
 * substrate's embedding setup (nomic-embed-text, 768-dim).
 */
export class OllamaEmbeddings implements EmbeddingProvider {
  private readonly baseURL: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaEmbeddingsOptions = {}) {
    this.baseURL = options.baseURL ?? "http://localhost:11434";
    this.model = options.model ?? "nomic-embed-text";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.fetchImpl(`${this.baseURL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: [...texts] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Ollama embeddings request failed: ${res.status} ${res.statusText}${
          body ? ` — ${body}` : ""
        }`,
      );
    }
    const data = (await res.json()) as OllamaEmbedResponse;
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama embeddings response malformed: expected ${texts.length} vectors, got ${data.embeddings?.length ?? "none"}`,
      );
    }
    return data.embeddings;
  }
}
