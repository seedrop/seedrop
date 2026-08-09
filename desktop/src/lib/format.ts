export function relativeAge(iso?: string | null, now = Date.now()): string {
  if (!iso) return "No recent activity recorded";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Activity time unavailable";
  const ms = Math.max(0, now - then);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "Seen less than an hour ago";
  if (hours < 24) return `Seen ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days < 14) {
    if (remHours === 0) return `Seen ${days} day${days === 1 ? "" : "s"} ago`;
    return `Seen ${days} day${days === 1 ? "" : "s"} & ${remHours} hour${remHours === 1 ? "" : "s"} ago`;
  }
  const weeks = Math.floor(days / 7);
  return `Seen ${weeks} week${weeks === 1 ? "" : "s"} ago`;
}
