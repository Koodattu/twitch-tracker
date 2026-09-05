"use client";

import { useState } from "react";

export function StreamThumbnail({ src, priority = false }: { src: string | null; priority?: boolean }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (src == null || src === failedSrc) {
    return <span className="stream-preview-placeholder" aria-hidden="true"><span /><span /><span /></span>;
  }

  return <img src={src} alt="" width={640} height={360} loading={priority ? "eager" : "lazy"}
    fetchPriority={priority ? "high" : "auto"} decoding="async" onError={() => setFailedSrc(src)} />;
}
