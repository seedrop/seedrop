/**
 * Extract @mention tokens from a message body.
 *
 * Rules:
 *  - Token must be preceded by start-of-string or a non-word character.
 *  - Token captures `@<agent_id>` where agent_id matches [a-z0-9._-]+ (lowercase).
 *  - Token must be followed by end-of-string or a non-word character.
 *  - Duplicates are de-duped (first occurrence kept).
 *
 * v1 is a naive parser — it does not strip out fenced code blocks or quoted
 * text. False positives are acceptable for v1; refine later if real.
 */
export function extractMentions(content: string): string[] {
  if (!content) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Token: must start and end with an alnum (or underscore); middle may also include . - _
  const pattern = /(^|[^\w])@([a-zA-Z0-9_](?:[a-zA-Z0-9._-]*[a-zA-Z0-9_])?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const id = match[2]!.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
