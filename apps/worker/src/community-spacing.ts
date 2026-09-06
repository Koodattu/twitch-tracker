import { communityNodeRadius, type CommunityNode } from "@twitch-tracker/shared";

// Resolve circle collisions after layout normalization, which otherwise shrinks away node spacing.
export function spaceCommunityNodes(nodes: CommunityNode[]) {
  const connected = nodes.filter((node) => node.community != null).sort((a,b) => a.id.localeCompare(b.id));
  const radius = (node: CommunityNode) => communityNodeRadius(node.participants ?? node.chatters);
  const cellSize = 40;
  const gap = 3;
  const pairs = (visit: (a: CommunityNode, b: CommunityNode, i: number, j: number) => void) => {
    const cells = new Map<string, number[]>();
    connected.forEach((node,i) => {
      const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key)!.push(i);
    });
    connected.forEach((a,i) => {
      const x = Math.floor(a.x / cellSize), y = Math.floor(a.y / cellSize);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of cells.get(`${x+dx},${y+dy}`) ?? []) if (j > i) visit(a, connected[j]!, i, j);
      }
    });
  };
  let iterations = 0;
  for (; iterations < 600; iterations++) {
    let overlap = 0;
    pairs((a,b,i,j) => {
      let dx = b.x - a.x, dy = b.y - a.y;
      let distance = Math.hypot(dx,dy);
      const rA = radius(a), rB = radius(b), minimum = rA + rB + gap;
      if (distance >= minimum) return;
      overlap = Math.max(overlap, minimum - distance);
      if (distance < 0.000001) {
        const angle = (i * 17 + j * 31) * 2.399963229728653;
        dx = Math.cos(angle); dy = Math.sin(angle); distance = 1;
      }
      const shift = (minimum - Math.hypot(b.x-a.x,b.y-a.y)) / distance;
      const moveA = rB * rB / (rA*rA+rB*rB);
      a.x -= dx * shift * moveA; a.y -= dy * shift * moveA;
      b.x += dx * shift * (1-moveA); b.y += dy * shift * (1-moveA);
    });
    if (overlap < 0.01) break;
  }
  // A final uniform expansion removes any residual overlap without changing the layout's shape.
  let expansion = 1;
  pairs((a,b) => {
    const distance = Math.hypot(a.x-b.x,a.y-b.y);
    if (distance === 0) throw new Error("Community spacing did not converge");
    expansion = Math.max(expansion, (radius(a)+radius(b)+gap) / distance);
  });
  for (const node of connected) {
    node.x = 500 + (node.x-500) * expansion;
    node.y = 500 + (node.y-500) * expansion;
  }
  const isolated = nodes.filter((node) => node.community == null).sort((a,b) => a.id.localeCompare(b.id));
  const circumference = isolated.reduce((sum,node) => sum + 2*radius(node)+gap,0);
  const extent = connected.reduce((max,node) => Math.max(max, Math.hypot(node.x-500,node.y-500)+radius(node)),0);
  const ringRadius = Math.max(465,extent+40,circumference/(2*Math.PI)*1.1);
  let arc = 0;
  for (const node of isolated) {
    const width = 2*radius(node)+gap;
    const angle = 2*Math.PI*(arc+width/2)/circumference;
    node.x = 500 + Math.cos(angle)*ringRadius;
    node.y = 500 + Math.sin(angle)*ringRadius;
    arc += width;
  }
  for (const node of nodes) {
    node.x = Math.round(node.x*1000)/1000;
    node.y = Math.round(node.y*1000)/1000;
  }
  return { spacingIterations: iterations, spacingExpansion: expansion };
}
