import { Link } from "react-router-dom";

export function AdminBrand() {
  return (
    <Link
      aria-label="返回管理后台总览"
      className="flex min-h-12 min-w-0 items-center gap-3 rounded-md px-2 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      to="/admin"
    >
      <span aria-hidden="true" className="block size-9 shrink-0">
        <img alt="" className="size-full object-contain dark:hidden" src="/logo-v2-black-logo.svg" />
        <img alt="" className="hidden size-full object-contain dark:block" src="/logo-v2-white-logo.svg" />
      </span>
      <span className="truncate text-[15px] font-semibold leading-5 text-sidebar-foreground">Clawee管理后台</span>
    </Link>
  );
}
