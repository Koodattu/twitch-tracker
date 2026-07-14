import type { ReactNode } from "react";

export function Avatar({ name, src, size = "medium" }: { name: string; src?: string | null | undefined; size?: "small" | "medium" | "large" }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";

  return (
    <span className={`avatar avatar-${size}`} aria-hidden="true">
      {src == null || src === "" ? <span>{initials}</span> : <img src={src} alt="" width={74} height={74} loading="lazy" decoding="async" />}
    </span>
  );
}

export function MetricCard({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {detail == null ? null : <span className="stat-detail">{detail}</span>}
    </div>
  );
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" | "danger" }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">·</span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {action == null ? null : <div className="empty-action">{action}</div>}
    </div>
  );
}
