export interface SpaceHttpClientOptions {
  baseUrl: string;
  passportId: string;
  timeoutMs?: number;
}

export interface SpacePostRequest {
  content: string;
  role?: "agent" | "human" | "system";
}

export interface PresenceQuery {
  spaceId?: string;
  passportId?: string;
  ttlMs?: number;
}

export interface NotifyRequest {
  recipientPassportId: string;
  pointer: {
    kind: string;
    ref: string;
  };
  ttlMs?: number;
}

export interface RegisterRequest {
  spaceId?: string;
  workingOn?: string;
}

export interface HeartbeatRequest {
  sessionId: string;
  workingOn?: string;
}

export interface InboxQuery {
  unackedOnly?: boolean;
  limit?: number;
}

export interface InboxAckRequest {
  result: "done" | "deferred" | "ignored";
  note?: string;
  deferredUntil?: string;
}

export class SpaceHttpClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`Space HTTP request failed with status ${status}`);
    this.name = "SpaceHttpClientError";
    this.status = status;
    this.body = body;
  }
}

export class SpaceHttpClient {
  private readonly baseUrl: string;
  private readonly passportId: string;
  private readonly timeoutMs: number;

  constructor(options: SpaceHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.passportId = options.passportId;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  join(spaceName: string): Promise<unknown> {
    return this.request("POST", `/spaces/${encodeURIComponent(spaceName)}/join`, {});
  }

  post(spaceName: string, input: SpacePostRequest): Promise<unknown> {
    return this.request("POST", `/spaces/${encodeURIComponent(spaceName)}/messages`, input);
  }

  messages(spaceName: string): Promise<unknown> {
    return this.request("GET", `/spaces/${encodeURIComponent(spaceName)}/messages`);
  }

  register(input: RegisterRequest = {}): Promise<unknown> {
    return this.request("POST", "/sessions", input);
  }

  heartbeat(input: HeartbeatRequest): Promise<unknown> {
    return this.request("POST", "/presence/heartbeat", input);
  }

  presence(query: PresenceQuery = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (query.spaceId) params.set("spaceId", query.spaceId);
    if (query.passportId) params.set("passportId", query.passportId);
    if (query.ttlMs !== undefined) params.set("ttlMs", String(query.ttlMs));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/presence${suffix}`);
  }

  notify(input: NotifyRequest): Promise<unknown> {
    return this.request("POST", "/notifications", input);
  }

  notifications(): Promise<unknown> {
    return this.request("GET", "/notifications");
  }

  ack(notificationId: string): Promise<unknown> {
    return this.request("POST", `/notifications/${encodeURIComponent(notificationId)}/ack`, {});
  }

  end(spaceName: string): Promise<unknown> {
    return this.request("POST", `/spaces/${encodeURIComponent(spaceName)}/end`, {});
  }

  inbox(query: InboxQuery = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (query.unackedOnly) params.set("unacked_only", "true");
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/inbox/${encodeURIComponent(this.passportId)}${suffix}`);
  }

  ackInbox(itemId: string, body: InboxAckRequest): Promise<unknown> {
    return this.request(
      "POST",
      `/inbox/${encodeURIComponent(this.passportId)}/${encodeURIComponent(itemId)}/ack`,
      {
        result: body.result,
        note: body.note,
        deferred_until: body.deferredUntil,
      },
    );
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-seedrop-passport": this.passportId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = text.length > 0 ? JSON.parse(text) : undefined;
      if (!response.ok) {
        throw new SpaceHttpClientError(response.status, payload);
      }
      return payload;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new SpaceHttpClientError(408, {
          error: {
            code: "seedrop.http.timeout",
            message: `Space HTTP request timed out after ${this.timeoutMs}ms`,
            class: "io",
            retryable: true,
            details: { method, path, timeout_ms: this.timeoutMs },
          },
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
