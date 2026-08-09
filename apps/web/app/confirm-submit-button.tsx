"use client";

import type { MouseEvent, ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function ConfirmSubmitButton({ children, className, disabled = false, message, pendingLabel }: { children: ReactNode; className: string; disabled?: boolean; message?: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  const confirmSubmission = (event: MouseEvent<HTMLButtonElement>) => {
    if (message != null && !window.confirm(message)) {
      event.preventDefault();
    }
  };

  return <button className={className} type="submit" onClick={confirmSubmission} disabled={disabled || pending} aria-busy={pending}>{pending ? pendingLabel : children}</button>;
}
