import { describe, it, expect, vi } from "vitest";
import { OllamaEmbeddings } from "../src/embeddings.js";

function mockResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("OllamaEmbeddings", () => {
  it("posts to /api/embed with model + input batch and returns the vectors", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ embeddings: [[1, 0, 0], [0, 1, 0]] }),
    );
    const e = new OllamaEmbeddings({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await e.embed(["a", "b"]);
    expect(out).toEqual([[1, 0, 0], [0, 1, 0]]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/api/embed");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      model: "nomic-embed-text",
      input: ["a", "b"],
    });
  });

  it("honours baseURL and model overrides", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ embeddings: [[1]] }));
    const e = new OllamaEmbeddings({
      baseURL: "https://embed.example.com",
      model: "mxbai-embed-large",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await e.embed(["x"]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://embed.example.com/api/embed");
    expect(JSON.parse((init as RequestInit).body as string).model).toBe("mxbai-embed-large");
  });

  it("returns an empty array for empty input without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const e = new OllamaEmbeddings({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await e.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the response is not ok", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ error: "model not found" }, { ok: false, status: 404, statusText: "Not Found" }),
    );
    const e = new OllamaEmbeddings({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(e.embed(["x"])).rejects.toThrow(/Ollama embeddings request failed: 404/);
  });

  it("throws when the response shape is malformed", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ embeddings: [[1]] }));
    const e = new OllamaEmbeddings({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(e.embed(["a", "b"])).rejects.toThrow(/response malformed/);
  });
});
