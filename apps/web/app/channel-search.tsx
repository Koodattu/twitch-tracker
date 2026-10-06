import Link from "next/link";

export function ChannelSearch({ query = "" }: { query?: string }) {
  return <form className="channel-search" role="search" action="/channels" method="get">
    <label htmlFor="channel-search">Search all channels</label>
    <div className="channel-search-controls">
      <input className="search-input" id="channel-search" name="q" type="search" defaultValue={query} key={query} maxLength={100} placeholder="Name, title, category" />
      <button className="button" type="submit">Search</button>
    </div>
    {query === "" ? null : <Link className="text-link channel-search-clear" href="/channels" prefetch={false}>Clear search</Link>}
  </form>;
}
