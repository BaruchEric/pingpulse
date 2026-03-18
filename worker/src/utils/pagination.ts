export function parsePagination(
  query: (key: string) => string | undefined,
  defaults: { limit: number; maxLimit: number } = { limit: 50, maxLimit: 200 }
): { limit: number; offset: number } {
  const limit = Math.min(
    Math.max(parseInt(query("limit") || String(defaults.limit)) || defaults.limit, 1),
    defaults.maxLimit
  );
  const offset = Math.max(parseInt(query("offset") || "0") || 0, 0);
  return { limit, offset };
}
