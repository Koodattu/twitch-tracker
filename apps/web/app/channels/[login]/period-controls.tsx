"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { channelPeriodDays, earliestChannelPeriodEnd } from "@twitch-tracker/shared";
import { channelSearchParams, channelViewQuery, readChannelView, type ChannelView } from "./channel-view";

export function PeriodControls({ pathname, fromDay, toDay, today }: {
  pathname: string; fromDay: string; toDay: string; today: string;
}) {
  const view = readChannelView(channelSearchParams(useSearchParams()), today);
  const href = (next: ChannelView) => `${pathname}?${channelViewQuery(next)}`;
  const previous = new Date(Date.parse(fromDay) - 86_400_000).toISOString().slice(0, 10);
  const next = new Date(Math.min(Date.parse(today), Date.parse(toDay) + view.days * 86_400_000)).toISOString().slice(0, 10);
  return <section className="channel-period" aria-label="Analysis period">
    <div className="channel-period-heading"><h2>{toDay === today ? `Last ${view.days} days` : `${view.days}-day history`}</h2><span>{fromDay} – {toDay} · UTC{toDay === today ? " · Today so far" : ""}</span></div>
    <div className="channel-period-actions">
      <nav className="channel-period-presets" aria-label="Period length">{channelPeriodDays.map((days) => <Link key={days} href={href({ ...view, days, day: undefined })} aria-current={view.days === days ? "page" : undefined} prefetch={false} scroll={false}>{days} days</Link>)}</nav>
      <nav className="channel-period-steps" aria-label="Browse periods">
        {previous >= earliestChannelPeriodEnd ? <Link href={href({ ...view, end: previous, day: undefined })} aria-label={`Previous ${view.days} days`} prefetch={false} scroll={false}>Previous</Link> : <span aria-disabled="true">Previous</span>}
        {toDay < today ? <><Link href={href({ ...view, end: undefined, day: undefined })} prefetch={false} scroll={false}>Latest</Link><Link href={href({ ...view, end: next, day: undefined })} aria-label={`Next ${view.days} days`} prefetch={false} scroll={false}>Next</Link></> : <span aria-disabled="true">Next</span>}
      </nav>
      <details className="channel-period-date"><summary>Choose end date</summary><form action={pathname}>
        <input type="hidden" name="days" value={view.days} /><input type="hidden" name="measure" value={view.measure} />
        <label>Period ending (UTC)<input name="end" type="date" defaultValue={toDay} key={toDay} min={earliestChannelPeriodEnd} max={today} required /></label>
        <button className="button button-secondary" type="submit">Apply date</button>
      </form></details>
    </div>
  </section>;
}
