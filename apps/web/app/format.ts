const countFormatter = new Intl.NumberFormat("en-GB");
const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short"
});

export function formatCount(value: number | null | undefined, fallback = "—") {
  return value == null ? fallback : countFormatter.format(value);
}

export function formatDateTime(value: string | Date | null | undefined, fallback = "—") {
  if (value == null) {
    return fallback;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : dateTimeFormatter.format(date);
}

export function formatDuration(seconds: number) {
  if (seconds <= 0) {
    return "0m";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

export function formatRelativeTime(value: string | Date | null | undefined, reference = new Date()) {
  if (value == null) {
    return "unknown";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const seconds = Math.max(0, Math.floor((reference.getTime() - date.getTime()) / 1000));
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

export function getSizedThumbnailUrl(value: string | null | undefined, width = 640, height = 360) {
  if (value == null || value === "") {
    return null;
  }

  return value.replaceAll("{width}", String(width)).replaceAll("{height}", String(height));
}

export function formatStatus(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
