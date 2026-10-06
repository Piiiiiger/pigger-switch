import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="m-0 text-section">{title}</h2>
        {description && (
          <p className="m-0 text-caption text-fg-3">{description}</p>
        )}
      </div>
      <div className="flex flex-col rounded-panel border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

export function Row({
  label,
  description,
  children,
  stacked = false,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  /** 控件放到说明下面（路径输入框这类宽控件） */
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-4 border-b border-border px-4 py-3 last:border-b-0",
        stacked ? "flex-col gap-2" : "items-center justify-between",
      )}
    >
      <div className="min-w-0">
        <div className="text-body font-medium">{label}</div>
        {description && (
          <div className="text-caption text-fg-3">{description}</div>
        )}
      </div>
      <div className={cn(stacked ? "w-full" : "shrink-0")}>{children}</div>
    </div>
  );
}

/** 失焦或回车才提交的输入框（数字、路径、代理地址、令牌） */
export function CommitInput({
  value,
  onCommit,
  placeholder,
  className,
  inputMode,
  type,
  "aria-label": ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  className?: string;
  inputMode?: "decimal" | "text";
  type?: "text" | "password";
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) onCommit(draft.trim());
  };
  return (
    <Input
      value={draft}
      type={type}
      aria-label={ariaLabel}
      placeholder={placeholder}
      inputMode={inputMode}
      className={className}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}
