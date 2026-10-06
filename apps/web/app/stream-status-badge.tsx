import { getStreamStatus } from "./stream-status";
import { StatusPill } from "./ui";

export function StreamStatusBadge({ stream, now = new Date() }: {
  stream: { endedAt?: string | null; lastSeenLiveAt?: string | null };
  now?: Date;
}) {
  const status = getStreamStatus(stream, now);
  return <StatusPill tone={status === "recent" ? "success" : status === "unconfirmed" ? "warning" : "neutral"}>
    {status === "recent" ? "Recently live" : status === "unconfirmed" ? "Unconfirmed" : "Ended"}
  </StatusPill>;
}
