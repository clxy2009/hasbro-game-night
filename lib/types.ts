export type Role = 'player' | 'organizer';

export type User = {
  id: string;
  name: string;
  role: Role;
  homeMetroId: string;
};

export type Metro = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
};

export type GameEvent = {
  id: string;
  organizerId: string;
  organizerName: string;
  metroId: string;
  metroName: string;
  timezone: string;
  title: string;
  gameType: string;
  startsAt: string;
  location: string;
  capacity: number;
  attendeeCount: number;
  rsvpOpensAt: string;
  rsvpClosesAt: string;
  cancellationClosesAt: string;
  version: number;
  isRsvped: boolean;
  rsvpVersion: string | null;
};

export type Attendee = {
  id: string;
  name: string;
  rsvpedAt: string;
};

export type RsvpHistoryItem = {
  id: string;
  eventId: string;
  eventTitle: string;
  gameType: string;
  location: string;
  startsAt: string;
  action: 'reserved' | 'canceled';
  occurredAt: string;
  eventVersion: number;
};

export type ApiFailure = {
  error: { code: string; message: string; details?: unknown };
};
