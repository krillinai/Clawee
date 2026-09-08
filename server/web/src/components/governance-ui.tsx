import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { Children, Fragment, isValidElement, useMemo, useState } from "react";

import { Search } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DecisionVariant, LifecycleStep } from "@/lib/governance-ui";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  titleAccessory,
  children,
  actions
}: {
  title: string;
  titleAccessory?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold leading-8">{title}</h1>
          {titleAccessory}
        </div>
        {children ? <div className="mt-2 max-w-5xl text-sm leading-6 text-muted-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div> : null}
    </header>
  );
}

export function MetricCard({
  label,
  value,
  foot
}: {
  label: string;
  value: string | number;
  foot?: string;
}) {
  return (
    <Card className="shadow-none">
      <CardContent className="grid gap-2 p-5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <strong className="font-mono text-3xl font-bold leading-tight">{value}</strong>
        {foot ? <span className="text-xs text-muted-foreground">{foot}</span> : null}
      </CardContent>
    </Card>
  );
}

export function DecisionBadge({ value, variant }: { value: string; variant: DecisionVariant }) {
  return <Badge variant={variant}>{value}</Badge>;
}

export function BooleanBadge({
  value,
  trueVariant = "success",
  falseVariant = "muted",
  trueLabel = "true",
  falseLabel = "false"
}: {
  value?: boolean;
  trueVariant?: ComponentProps<typeof Badge>["variant"];
  falseVariant?: ComponentProps<typeof Badge>["variant"];
  trueLabel?: string;
  falseLabel?: string;
}) {
  if (value === undefined) return <>-</>;
  return <Badge variant={value ? trueVariant : falseVariant}>{value ? trueLabel : falseLabel}</Badge>;
}

export function FilterRow({
  children,
  compact = false
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-center gap-2",
        compact && "mb-0",
        "[&>*]:min-w-0"
      )}
    >
      {children}
    </div>
  );
}

export function FilterSearchField({
  children,
  containerClassName,
  className,
  ...props
}: ComponentProps<typeof Input> & {
  children?: ReactNode;
  containerClassName?: string;
}) {
  return (
    <label className={cn("relative w-full sm:w-80", containerClassName)}>
      <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <Input className={cn("pl-9", className)} {...props} />
      {children}
    </label>
  );
}

type FilterSelectOption = {
  disabled?: boolean;
  label: ReactNode;
  value: string;
};

function normalizeFilterSelectOptions(children: ReactNode): FilterSelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];

    if (child.type === Fragment) {
      return normalizeFilterSelectOptions(child.props.children);
    }

    if (child.type !== "option") return [];

    const option = child.props as ComponentProps<"option">;
    const label = option.children ?? option.value ?? "";
    return [
      {
        disabled: option.disabled,
        label,
        value: String(option.value ?? getOptionText(label))
      }
    ];
  });
}

function getOptionText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return getOptionText(child.props.children);
      return "";
    })
    .join("");
}

export function FilterSelect({
  ariaLabel,
  className,
  value,
  onChange,
  children
}: {
  ariaLabel: string;
  className?: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const options = normalizeFilterSelectOptions(children);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={ariaLabel} className={cn("w-full bg-card sm:w-40", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem disabled={option.disabled} key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  // 页面根栅格：[&>*]:min-w-0 让卡片等子项可收缩到 main 实际宽度，
  // 避免内部宽表格（DataTableShell 的固定 minWidth）把整页撑出横向滚动条。
  return <div className="grid min-w-0 gap-4 [&>*]:min-w-0">{children}</div>;
}

export function DataTableShell({
  children,
  dense = false,
  embedded = false,
  fixedLayout = false,
  minWidth = 940
}: {
  children: ReactNode;
  dense?: boolean;
  embedded?: boolean;
  fixedLayout?: boolean;
  minWidth?: number;
}) {
  const table = (
    <Table
      className={cn(
        "w-full text-left text-sm",
        fixedLayout && "table-fixed",
        dense && "text-xs [&_td]:px-2.5 [&_td]:py-2 [&_th]:px-2.5 [&_th]:py-2"
      )}
      style={{ minWidth } satisfies CSSProperties}
    >
      {children}
    </Table>
  );

  if (embedded) return <div className="min-w-0 rounded-md border border-border">{table}</div>;
  return <Card className="overflow-auto bg-card shadow-none">{table}</Card>;
}

export function TableShell(props: Parameters<typeof DataTableShell>[0]) {
  return <DataTableShell {...props} />;
}

export function TableStateRow({
  colSpan,
  tone = "muted",
  children
}: {
  colSpan: number;
  tone?: "muted" | "danger";
  children: ReactNode;
}) {
  return (
    <tr>
      <td
        className={cn(
          "px-3 py-5 text-center",
          tone === "danger" ? "text-danger" : "text-muted-foreground"
        )}
        colSpan={colSpan}
      >
        {children}
      </td>
    </tr>
  );
}

export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function SuccessAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="success">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

export function LoadingState({ label = "加载中" }: { label?: string }) {
  return (
    <div className="grid gap-3">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-16 w-full" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

type KeyValueItem = {
  label: ReactNode;
  value: ReactNode;
};

export function KeyValueList({
  items,
  labelWidth = 150
}: {
  items: KeyValueItem[];
  labelWidth?: number;
}) {
  return (
    <dl
      className="grid gap-x-4 gap-y-3 text-sm"
      style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }}
    >
      {items.map((item, index) => (
        <div className="contents" key={index}>
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="m-0 min-w-0 break-all font-mono">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ResourceList({ children, variant = "card" }: { children: ReactNode; variant?: "card" | "plain" }) {
  return <div className={cn("grid", variant === "card" ? "gap-2" : "gap-0")}>{children}</div>;
}

export function ResourceItem({
  title,
  meta,
  action,
  children,
  variant = "card"
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  variant?: "card" | "plain";
}) {
  return (
    <Card
      className={cn(
        "bg-muted/25 shadow-none",
        variant === "plain" && "rounded-none border-x-0 border-b-0 bg-transparent first:border-t-0"
      )}
    >
      <CardContent className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 p-4">
        <div className="min-w-0">
          <strong className="block text-sm font-semibold">{title}</strong>
          {meta ? <p className="mt-1 break-all text-xs text-muted-foreground">{meta}</p> : null}
          {children ? <div className="mt-3 text-sm text-muted-foreground">{children}</div> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}

export function DetailDrawer({
  open,
  title,
  subtitle,
  contextLabel,
  titleAction,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  subtitle: string;
  contextLabel?: string;
  titleAction?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  function labelCloseButton(node: HTMLDivElement | null) {
    node
      ?.querySelector<HTMLButtonElement>("button")
      ?.setAttribute("aria-label", "关闭详情抽屉");
  }

  return (
    <Sheet
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <SheetContent
        className="w-full overflow-x-hidden overflow-y-auto sm:max-w-[680px]"
        onFocusOutside={(event) => event.preventDefault()}
        ref={labelCloseButton}
        side="right"
      >
        <SheetHeader className="mb-6 border-b border-border pb-5">
          {contextLabel ? <p className="text-sm font-medium text-muted-foreground">{contextLabel}</p> : null}
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <SheetTitle>{title}</SheetTitle>
            {titleAction ? <div className="flex shrink-0 items-center">{titleAction}</div> : null}
          </div>
          <SheetDescription>{subtitle}</SheetDescription>
        </SheetHeader>
        <div className="grid min-w-0 gap-4 [&>*]:min-w-0">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export function ModalShell({
  open,
  title,
  subtitle,
  contextLabel,
  contentClassName,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  contextLabel?: string;
  contentClassName?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className={cn("max-h-[92vh] max-w-[760px] overflow-auto", contentClassName)}>
        <DialogHeader className="mb-1 border-b border-border pb-4">
          {contextLabel ? <p className="text-sm font-medium text-muted-foreground">{contextLabel}</p> : null}
          <DialogTitle>{title}</DialogTitle>
          {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
        </DialogHeader>
        <div className="grid gap-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  error,
  variant = "default",
  pending = false,
  onClose,
  onConfirm
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  error?: ReactNode;
  variant?: "default" | "destructive";
  pending?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
        <DialogFooter>
          <Button disabled={pending} onClick={onClose} variant="outline">
            {cancelLabel}
          </Button>
          <Button
            disabled={pending}
            onClick={onConfirm}
            variant={variant === "destructive" ? "destructive" : "default"}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LifecycleTimeline({ steps }: { steps: LifecycleStep[] }) {
  return (
    <div className="grid gap-3">
      {steps.map((step, index) => (
        <div key={`${step.title}-${index}`} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
          <span
            className={cn(
              "grid size-7 place-items-center rounded-md border border-border bg-card font-mono text-xs text-muted-foreground",
              step.state === "allow" && "border-success/30 text-success",
              step.state === "deny" && "border-danger/30 text-danger"
            )}
          >
            {index + 1}
          </span>
          <div className="border-b border-border pb-3 last:border-b-0 last:pb-0">
            <div className="font-semibold">{step.title}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.copy}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

type JsonTab = {
  id: string;
  label: string;
  value: unknown;
};

export function JsonTabs({ tabs }: { tabs: JsonTab[] }) {
  const [activeID, setActiveID] = useState(tabs[0]?.id ?? "");
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeID) ?? tabs[0],
    [activeID, tabs]
  );
  const selectedID = activeTab?.id ?? "";
  const formattedValue = activeTab ? JSON.stringify(activeTab.value, null, 2) : "";

  if (tabs.length === 0) {
    return <CodeBox value={{}} />;
  }

  return (
    <Tabs value={selectedID} onValueChange={setActiveID}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <TabsList className="h-auto flex-wrap justify-start">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <CopyButton disabled={!activeTab} value={formattedValue} size="sm" variant="secondary" />
      </div>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id}>
          <CodeBox value={tab.value} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function CodeBox({ value }: { value: unknown }) {
  return (
    <Card className="bg-muted/25 shadow-none">
      <CardContent className="overflow-auto p-4">
        <pre className="font-mono text-xs leading-5">{JSON.stringify(value, null, 2)}</pre>
      </CardContent>
    </Card>
  );
}
