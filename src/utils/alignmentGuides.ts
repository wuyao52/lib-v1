export type AlignmentNode = {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
};

export type AlignmentGuide = {
  axis: 'x' | 'y';
  coordinate: number;
  start: number;
  end: number;
};

type Anchor = { coordinate: number; offset: number };

const anchors = (position: number, size: number): Anchor[] => [
  { coordinate: position, offset: 0 },
  { coordinate: position + size / 2, offset: size / 2 },
  { coordinate: position + size, offset: size },
];

const nearestMatch = (dragged: Anchor[], candidates: Array<Anchor & { node: AlignmentNode }>, threshold: number) => {
  let nearest: { delta: number; coordinate: number; node: AlignmentNode } | null = null;
  for (const source of dragged) {
    for (const candidate of candidates) {
      const delta = candidate.coordinate - source.coordinate;
      if (Math.abs(delta) > threshold || (nearest && Math.abs(delta) >= Math.abs(nearest.delta))) continue;
      nearest = { delta, coordinate: candidate.coordinate, node: candidate.node };
    }
  }
  return nearest;
};

export function alignNode(
  dragged: AlignmentNode,
  otherNodes: AlignmentNode[],
  threshold: number,
): { position: { x: number; y: number }; guides: AlignmentGuide[] } {
  const xCandidates = otherNodes.flatMap((node) => anchors(node.position.x, node.width).map((anchor) => ({ ...anchor, node })));
  const yCandidates = otherNodes.flatMap((node) => anchors(node.position.y, node.height).map((anchor) => ({ ...anchor, node })));
  const xMatch = nearestMatch(anchors(dragged.position.x, dragged.width), xCandidates, threshold);
  const yMatch = nearestMatch(anchors(dragged.position.y, dragged.height), yCandidates, threshold);
  const position = {
    x: dragged.position.x + (xMatch?.delta || 0),
    y: dragged.position.y + (yMatch?.delta || 0),
  };
  const guides: AlignmentGuide[] = [];

  if (xMatch) {
    guides.push({
      axis: 'x',
      coordinate: xMatch.coordinate,
      start: Math.min(position.y, xMatch.node.position.y),
      end: Math.max(position.y + dragged.height, xMatch.node.position.y + xMatch.node.height),
    });
  }
  if (yMatch) {
    guides.push({
      axis: 'y',
      coordinate: yMatch.coordinate,
      start: Math.min(position.x, yMatch.node.position.x),
      end: Math.max(position.x + dragged.width, yMatch.node.position.x + yMatch.node.width),
    });
  }

  return { position, guides };
}
