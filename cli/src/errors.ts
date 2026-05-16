export type SeedErrorClass = "config" | "validation" | "auth" | "not_found" | "conflict" | "io" | "internal";

export interface SeedErrorEnvelope {
  error: {
    code: string;
    message: string;
    class: SeedErrorClass;
    retryable: boolean;
    next_command?: string;
    details: Record<string, unknown>;
  };
}

export function seedError(input: {
  code: string;
  message: string;
  class: SeedErrorClass;
  retryable?: boolean;
  nextCommand?: string;
  details?: Record<string, unknown>;
}): SeedErrorEnvelope {
  return {
    error: {
      code: input.code,
      message: input.message,
      class: input.class,
      retryable: input.retryable ?? false,
      next_command: input.nextCommand,
      details: input.details ?? {},
    },
  };
}

export function renderCliError(envelope: SeedErrorEnvelope, json: boolean): string {
  if (json) return `${JSON.stringify(envelope, null, 2)}\n`;
  const next = envelope.error.next_command ? `\nRun: ${envelope.error.next_command}` : "";
  return `${envelope.error.message}${next}\n`;
}
