"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export function RetryButton({ label = "Try again", pendingLabel = "Retrying…" }: { label?: string; pendingLabel?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button className="button button-secondary" type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
    {pending ? pendingLabel : label}
  </button>;
}
