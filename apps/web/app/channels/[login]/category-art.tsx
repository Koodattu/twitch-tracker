import { StreamThumbnail } from "../../stream-thumbnail";

export function CategoryArt({ id }: { id: string | null }) {
  return <span className="channel-category-art">
    <StreamThumbnail src={id == null || id === "" ? null : `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(id)}-285x380.jpg`} />
  </span>;
}
