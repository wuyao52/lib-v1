export function planGenerationTarget(nodeId: string, nodeType: string, createId: () => string) {
  const inPlace = nodeType === 'video';
  return { inPlace, targetNodeId: inPlace ? nodeId : createId(), createResultNode: !inPlace, createResultEdge: !inPlace };
}
