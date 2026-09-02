export function eventMetroScope(mine: boolean, requestedMetroId: string) {
  return mine ? '' : requestedMetroId;
}
