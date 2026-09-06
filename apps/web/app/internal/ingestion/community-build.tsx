"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { CommunityBuildStatus } from "@twitch-tracker/shared";
import { formatDateTime, formatStatus } from "../../format";

export function CommunityBuild({ initialStatus }: { initialStatus: CommunityBuildStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/internal/communities", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("unavailable");
        setStatus((await response.json() as { data: CommunityBuildStatus }).data);
      } catch { if (!controller.signal.aborted) setError("Build status could not be refreshed."); }
    };
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
  const build = async () => {
    setSending(true); setError(null);
    try {
      const response = await fetch("/api/internal/communities/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("unavailable");
      setStatus((await response.json() as { data: CommunityBuildStatus }).data);
    } catch { setError("The build could not be requested. Please try again."); }
    finally { setSending(false); }
  };
  return <section className="panel">
    <div className="panel-header"><div className="panel-heading"><h2>Community map</h2><p>Rebuilt nightly at 03:00 UTC. An on-demand build uses the last 30 completed UTC days.</p></div>
      <button className="button" onClick={() => { void build(); }} disabled={sending || status.status === "queued" || status.status === "building"}>
        {sending || status.status === "queued" ? "Build queued" : status.status === "building" ? "Building…" : "Build now"}</button></div>
    <p role="status">{formatStatus(status.status)} · Last successful build: {formatDateTime(status.lastSuccessAt)}</p>
    {(error ?? status.error) != null && <p role="alert">{error ?? status.error}</p>}
    <Link className="button button-secondary" href="/communities">Open community map</Link>
  </section>;
}
