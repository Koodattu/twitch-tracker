"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { readChannelReturn } from "../../channel-return";

export function StreamReturnLink({ login }: { login: string | null }) {
  const values = useSearchParams().getAll("returnTo");
  const destination = readChannelReturn(values.length === 1 ? values[0] : undefined);
  return destination == null || destination.login.toLowerCase() !== login?.toLowerCase()
    ? <Link href="/">Live streams</Link>
    : <Link href={destination.href} prefetch={false}>{destination.label}</Link>;
}
