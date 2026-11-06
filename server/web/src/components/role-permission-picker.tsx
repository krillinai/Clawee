import { useMemo } from "react";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Permission } from "@/lib/rbac-api";
import { buildPermissionTree, permissionGroupLabel, type PermissionGroupNode } from "@/lib/rbac-permission-tree";
import { cn } from "@/lib/utils";

export function RolePermissionPicker({
  catalog,
  selectedCodes,
  disabled = false,
  fillHeight = false,
  onChange
}: {
  catalog: Permission[];
  selectedCodes: string[];
  disabled?: boolean;
  fillHeight?: boolean;
  onChange: (codes: string[]) => void;
}) {
  const tree = useMemo(() => buildPermissionTree(catalog), [catalog]);
  const selectedCount = catalog.filter((permission) => selectedCodes.includes(permission.code)).length;

  function toggleCodes(codes: string[], checked: boolean) {
    const next = new Set(selectedCodes);
    codes.forEach((code) => {
      if (checked) next.add(code);
      else next.delete(code);
    });
    onChange([...next].sort());
  }

  return (
    <FieldSet className={cn("gap-3", fillHeight && "min-h-0 flex-1 overflow-hidden")}>
      <FieldLegend className="mb-0 flex w-full items-center justify-between gap-2">
        <span>权限配置</span>
        <Badge className="shrink-0" variant="secondary">已选 {selectedCount} / {catalog.length}</Badge>
      </FieldLegend>
      <div
        aria-label="权限配置列表"
        role="region"
        tabIndex={0}
        className={cn("permission-scroll-area relative overflow-y-scroll overscroll-contain pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40", fillHeight ? "min-h-0 flex-1" : "max-h-[min(40vh,24rem)]")}
      >
        <TooltipProvider delayDuration={200}>
          <ul aria-label="角色权限树" className="divide-y divide-border rounded-md border bg-card">
            {tree.map((node) => (
              <RolePermissionTreeNode key={node.key} node={node} selectedCodes={selectedCodes} disabled={disabled} onToggleCodes={toggleCodes} />
            ))}
          </ul>
        </TooltipProvider>
      </div>
    </FieldSet>
  );
}

function RolePermissionTreeNode({
  node,
  selectedCodes,
  disabled,
  onToggleCodes
}: {
  node: PermissionGroupNode;
  selectedCodes: string[];
  disabled: boolean;
  onToggleCodes: (codes: string[], checked: boolean) => void;
}) {
  const label = permissionGroupLabel(node);
  const selectedCount = node.permissionCodes.filter((code) => selectedCodes.includes(code)).length;
  const checked = selectedCount === node.count ? true : selectedCount > 0 ? "indeterminate" : false;
  const groupID = `permission-tree-${node.key.replaceAll(":", "-")}`;
  const defaultOpen = selectedCount > 0 && selectedCount < node.count;

  return (
    <li>
      <Collapsible defaultOpen={defaultOpen}>
        <div className="flex items-center gap-2 pr-2">
          <Checkbox
            aria-label={`选择 ${label} 全部权限`}
            checked={checked}
            disabled={disabled}
            className="ml-3"
            id={groupID}
            onCheckedChange={(nextChecked) => onToggleCodes(node.permissionCodes, nextChecked === true)}
          />
          <CollapsibleTrigger asChild>
            <Button
              aria-label={`查看 ${label} 权限明细`}
              className="group h-auto min-h-11 min-w-0 flex-1 justify-start px-1 py-2 text-left"
              type="button"
              variant="ghost"
            >
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" data-icon="inline-start" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </TooltipTrigger>
                <TooltipContent className="font-mono">{node.key}</TooltipContent>
              </Tooltip>
            </Button>
          </CollapsibleTrigger>
          <Badge className="shrink-0 tabular-nums" variant={selectedCount > 0 ? "secondary" : "muted"}>
            {selectedCount} / {node.count}
          </Badge>
        </div>
        <CollapsibleContent className="border-t bg-muted/20">
          <div className="ml-5 border-l border-border pl-2">
            {node.children.length > 0 ? (
              <ul className="divide-y divide-border">
                {node.children.map((child) => (
                  <RolePermissionTreeNode key={child.key} node={child} selectedCodes={selectedCodes} disabled={disabled} onToggleCodes={onToggleCodes} />
                ))}
              </ul>
            ) : null}
            {node.permissions.length > 0 ? (
              <ul className="divide-y divide-border">
                {node.permissions.map((permission) => (
                  <li key={permission.code}>
                    <Field className="px-3 py-3" orientation="horizontal">
                      <Checkbox
                        checked={selectedCodes.includes(permission.code)}
                        disabled={disabled}
                        id={permission.code}
                        onCheckedChange={(nextChecked) => onToggleCodes([permission.code], nextChecked === true)}
                      />
                      <FieldContent className="gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <FieldLabel htmlFor={permission.code}>{permission.name}</FieldLabel>
                          </TooltipTrigger>
                          <TooltipContent className="font-mono">{permission.code}</TooltipContent>
                        </Tooltip>
                        <FieldDescription className="text-xs">{permission.description}</FieldDescription>
                      </FieldContent>
                    </Field>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
