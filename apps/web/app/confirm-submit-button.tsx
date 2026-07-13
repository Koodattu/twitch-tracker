"use client";

import type { MouseEvent, ReactNode } from "react";

export function ConfirmSubmitButton({ children, className, message }: { children: ReactNode; className: string; message: string }) {
  const confirmSubmission = (event: MouseEvent<HTMLButtonElement>) => {
    if (!window.confirm(message)) {
      event.preventDefault();
    }
  };

  return <button className={className} type="submit" onClick={confirmSubmission}>{children}</button>;
}
