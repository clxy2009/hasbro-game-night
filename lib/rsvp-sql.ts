/** A reservation and every capacity/window predicate execute as one statement. */
export const reserveSeatSql = `
  INSERT INTO rsvps (event_id, player_id, request_id, created_at)
  SELECT ?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (
    SELECT 1
    FROM events
    WHERE id = ?1
      AND rsvp_opens_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND rsvp_closes_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND starts_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND attendee_count < capacity
  )
    AND NOT EXISTS (
      SELECT 1 FROM rsvp_history
      WHERE event_id = ?1
        AND player_id = ?2
        AND action = 'reserved'
        AND request_id = ?3
    )
  ON CONFLICT(event_id, player_id) DO NOTHING
  RETURNING event_id AS eventId, player_id AS playerId,
    request_id AS requestId, created_at AS createdAt
`;

export function acceptsActiveRequest(
  activeRequestId: string | null,
  incomingRequestId: string,
  requestKeyWasSupplied: boolean,
) {
  return !requestKeyWasSupplied || activeRequestId === incomingRequestId;
}

export const cancelSeatSql = `
  DELETE FROM rsvps
  WHERE event_id = ?1
    AND player_id = ?2
    AND request_id = ?3
    AND EXISTS (
      SELECT 1 FROM events
      WHERE id = ?1
        AND cancellation_closes_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  RETURNING event_id AS eventId
`;

export function parseRsvpPrecondition(value: string | null) {
  if (value === null) return { kind: 'missing' } as const;
  const match = /^"([a-zA-Z0-9._:-]{1,128})"$/.exec(value.trim());
  if (!match) return { kind: 'invalid' } as const;
  return { kind: 'valid', version: match[1] } as const;
}

export function rsvpEtag(version: string) {
  return `"${version}"`;
}
