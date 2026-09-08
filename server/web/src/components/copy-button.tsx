import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";

type CopyStatus = "idle" | "success" | "failure";

export function CopyButton({
  value,
  label = "复制",
  successLabel = "已复制",
  failureLabel = "复制失败",
  resetDelay = 1400,
  stopPropagation = false,
  disabled,
  className,
  ...props
}: Omit<ButtonProps, "onClick"> & {
  value: string;
  label?: string;
  successLabel?: string;
  failureLabel?: string;
  resetDelay?: number;
  stopPropagation?: boolean;
}) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timerRef = useRef<number | null>(null);
  const isDisabled = disabled || !value;
  const currentLabel = status === "success" ? successLabel : status === "failure" ? failureLabel : label;

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  async function copyValue(event: MouseEvent<HTMLButtonElement>) {
    if (stopPropagation) event.stopPropagation();
    if (isDisabled) return;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }

    try {
      await writeClipboardText(value);
      setStatus("success");
    } catch {
      setStatus("failure");
    }

    timerRef.current = window.setTimeout(() => {
      setStatus("idle");
      timerRef.current = null;
    }, resetDelay);
  }

  return (
    <Button
      className={className}
      disabled={isDisabled}
      onClick={copyValue}
      {...props}
    >
      {status === "success" ? (
        <Check data-icon="inline-start" aria-hidden="true" />
      ) : (
        <Copy data-icon="inline-start" aria-hidden="true" />
      )}
      <span className="min-w-14" aria-live="polite">
        {currentLabel}
      </span>
    </Button>
  );
}

async function writeClipboardText(value: string): Promise<void> {
  if (typeof window !== "undefined" && window.isSecureContext !== false && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for non-secure intranet origins where Clipboard API can be present but denied.
    }
  }

  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    throw new Error("Clipboard API unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy command denied");
    }
  } finally {
    cleanup();
  }

  function cleanup() {
    textarea.parentNode?.removeChild(textarea);
  }
}
