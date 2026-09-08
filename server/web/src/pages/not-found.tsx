import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-6 text-foreground">
      <section className="grid justify-items-center gap-6 text-center">
        <h1 className="text-2xl font-semibold">页面不存在</h1>
        <Button asChild>
          <Link to="/app">
            <ArrowLeft aria-hidden="true" />
            返回应用
          </Link>
        </Button>
      </section>
    </main>
  );
}
