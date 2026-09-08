import type { Dispatch, SetStateAction } from "react";

import { FilterRow, FilterSearchField, FilterSelect } from "@/components/governance-ui";
import type { DashboardFilterState } from "@/hooks/useDashboardFilters";
import type { OfficeFilters } from "@/lib/office-api";

export function ActivityFilters({
  filters,
  officeFilters,
  setFilters,
}: {
  filters: DashboardFilterState;
  officeFilters: OfficeFilters;
  setFilters: Dispatch<SetStateAction<DashboardFilterState>>;
}) {
  return (
    <FilterRow>
      <FilterSearchField
        aria-label="搜索智能体活动"
        onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
        placeholder="搜索智能体、session、turn"
        type="search"
        value={filters.query}
      />
      <FilterSelect
        ariaLabel="workspace"
        onChange={(value) => setFilters((current) => ({ ...current, workspace: value }))}
        value={filters.workspace}
      >
        <option value="all">全部工作区</option>
        {officeFilters.workspaces.map((workspace) => (
          <option key={workspace.workspace_name} value={workspace.workspace_name}>
            {workspace.workspace_name}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect
        ariaLabel="status"
        className="sm:w-44"
        onChange={(value) =>
          setFilters((current) => ({
            ...current,
            statuses: value === "all" ? [] : [value],
          }))
        }
        value={filters.statuses[0] ?? "all"}
      >
        <option value="all">全部状态</option>
        {Object.entries(officeFilters.status_counts).map(([status, count]) => (
          <option key={status} value={status}>
            {status} ({count})
          </option>
        ))}
      </FilterSelect>
    </FilterRow>
  );
}
