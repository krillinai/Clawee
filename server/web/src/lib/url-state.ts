export type QueryValue = string | number | boolean | null | undefined;

export function readQueryParam(search: string, key: string): string | null {
  return new URLSearchParams(normalizeSearch(search)).get(key);
}

export function updateQueryParams(
  search: string,
  updates: Record<string, QueryValue>
): string {
  const params = new URLSearchParams(normalizeSearch(search));

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      params.delete(key);
      continue;
    }

    params.set(key, String(value));
  }

  const next = params.toString();
  return next ? `?${next}` : "";
}

function normalizeSearch(search: string) {
  return search.startsWith("?") ? search.slice(1) : search;
}
