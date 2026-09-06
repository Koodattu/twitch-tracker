import type { CommunityNode } from "@twitch-tracker/shared";

export function summarizeCommunityCategories(nodes: CommunityNode[]) {
  const known = nodes.filter((node) => node.category != null);
  if (known.length < 3 || known.length < nodes.length / 2) return null;
  const categories = new Map<string, { id: string; name: string; channels: number }>();
  for (const node of known) {
    const category = node.category!;
    if (category.share < 0.6) continue;
    const entry = categories.get(category.id) ?? { id: category.id, name: category.name, channels: 0 };
    entry.channels++;
    categories.set(category.id, entry);
  }
  const top = [...categories.values()].sort((a,b) => b.channels - a.channels || a.name.localeCompare(b.name));
  const dominant = top[0] != null && top[0].channels >= known.length * 0.6 ? top[0] : null;
  return { title: dominant == null ? "Mixed categories" : `Mostly ${dominant.name}`, known: known.length,
    total: nodes.length, categories: top.slice(0,3), mixed: known.length - top.reduce((sum, category) => sum + category.channels, 0) };
}
