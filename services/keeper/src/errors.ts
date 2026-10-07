/** A short, loggable description of an error: viem's short message and details, not its whole dump. */
export function errText(e: unknown, max = 200): string {
  const x = e as { shortMessage?: string; details?: string; name?: string; message?: string };
  const base =
    x?.shortMessage !== undefined
      ? `${x.name ?? "Error"}: ${x.shortMessage}${x.details ? ` (${x.details})` : ""}`
      : e instanceof Error
        ? `${e.name}: ${e.message}`
        : String(e);
  return base.replace(/\s+/g, " ").slice(0, max);
}
