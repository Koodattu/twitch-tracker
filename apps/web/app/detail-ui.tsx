import Link from "next/link";
import type { ReactNode } from "react";
import type { DetailPage } from "@twitch-tracker/shared";
import { formatCount } from "./format";
import { EmptyState } from "./ui";

export function DetailUnavailable({ privateData = false }: { privateData?: boolean }) {
  return <EmptyState title="Details unavailable" description={privateData ? "These records require private access. Check your account or try again later." : "These records could not be loaded. Please try again later."} />;
}

export function DetailPagination({ page, hasMore, pathname, filters = {} }: { page: number; hasMore: boolean; pathname: string; filters?: Record<string, string> }) {
  const href = (target: number) => `${pathname}?${new URLSearchParams({ ...filters, page: String(target) })}`;
  return <div className="pagination"><span>Page {formatCount(page)} · Up to 50 records</span><div className="pagination-actions">
    {page > 1 ? <Link className="button button-secondary button-compact" href={href(page - 1)} prefetch={false}>Newer</Link> : null}
    {hasMore ? <Link className="button button-secondary button-compact" href={href(page + 1)} prefetch={false}>Load older</Link> : null}
  </div></div>;
}

export function DetailTable<T>({ data, columns, row, label, pathname, filters = {}, privateData = false }: {
  data: DetailPage<T> | null; columns: string[]; row: (item: T) => ReactNode; label: string;
  pathname: string; filters?: Record<string, string>; privateData?: boolean;
}) {
  if (data == null) return <DetailUnavailable privateData={privateData} />;
  return <>
    {data.items.length === 0 ? <EmptyState title="No records on this page" description="No retained observations are available for this view and page." /> : <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table className="table table-compact"><thead><tr>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{data.items.map(row)}</tbody></table>
    </div>}
    <DetailPagination page={data.page} hasMore={data.hasMore} pathname={pathname} filters={filters} />
  </>;
}
