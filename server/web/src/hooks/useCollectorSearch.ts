import { useMemo, useState } from "react";

import type { CollectorItem } from "../lib/office-api";

export function filterCollectors(collectors: CollectorItem[], query: string): CollectorItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return collectors;
  }

  return collectors.filter((collector) =>
    [collector.collector_id, collector.device_name, collector.device_id, collector.hostname].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function useCollectorSearch(collectors: CollectorItem[]) {
  const [query, setQuery] = useState("");
  const filteredCollectors = useMemo(() => filterCollectors(collectors, query), [collectors, query]);

  return { query, setQuery, filteredCollectors };
}
