'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  Check,
  CircleAlert,
  Clock3,
  History,
  MapPin,
  Radio,
  Search,
  Sparkles,
  TicketCheck,
  Users,
  X,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { parseApiResponse } from '@/lib/client-api';
import { nextChangePollDelay, synchronizeChangePages } from '@/lib/change-feed';
import { eventMetroScope } from '@/lib/event-filters';
import { toLocalDateTimeValue } from '@/lib/local-datetime';
import type {
  Attendee,
  GameEvent,
  Metro,
  RsvpHistoryItem,
  User,
} from '@/lib/types';

type View = 'discover' | 'mine' | 'history' | 'manage';
type LiveState = 'live' | 'syncing' | 'offline';
type AttendeeState = 'idle' | 'loading' | 'success' | 'error';
type CreateForm = {
  title: string;
  gameType: string;
  metroId: string;
  startsAt: string;
  location: string;
  capacity: string;
  rsvpClosesAt: string;
  cancellationClosesAt: string;
};

function defaultStartTime() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  date.setHours(18, 30, 0, 0);
  return toLocalDateTimeValue(date);
}

function blankForm(metroId = 'metro-seattle'): CreateForm {
  const startsAt = defaultStartTime();
  return {
    title: '',
    gameType: '',
    metroId,
    startsAt,
    location: '',
    capacity: '8',
    rsvpClosesAt: startsAt,
    cancellationClosesAt: startsAt,
  };
}

async function api<T extends object = Record<string, unknown>>(
  path: string,
  userId?: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  if (userId) headers.set('x-user-id', userId);
  const response = await fetch(path, { ...init, headers });
  return parseApiResponse<T>(response);
}

function eventDate(startsAt: string, timezone?: string) {
  const date = new Date(startsAt);
  const options = timezone ? { timeZone: timezone } : {};
  return {
    day: new Intl.DateTimeFormat('en-US', { ...options, weekday: 'short' })
      .format(date)
      .toUpperCase(),
    number: new Intl.DateTimeFormat('en-US', {
      ...options,
      day: '2-digit',
    }).format(date),
    long: new Intl.DateTimeFormat('en-US', {
      ...options,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(date),
    time: new Intl.DateTimeFormat('en-US', {
      ...options,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date),
  };
}

function shortDate(value: string, timezone?: string) {
  return new Intl.DateTimeFormat('en-US', {
    ...(timezone ? { timeZone: timezone } : {}),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function toneFor(gameType: string) {
  const tones = [
    'bg-[#f9aa55]',
    'bg-[#c5d86d]',
    'bg-[#8ecae6]',
    'bg-[#e9a9a0]',
    'bg-[#d7c0e8]',
  ];
  return tones[
    Array.from(gameType).reduce(
      (sum, letter) => sum + letter.charCodeAt(0),
      0,
    ) % tones.length
  ];
}

function EventCard({
  event,
  onOpen,
  organizerView,
  now,
}: {
  event: GameEvent;
  onOpen: () => void;
  organizerView: boolean;
  now: number;
}) {
  const date = eventDate(event.startsAt, event.timezone);
  const seatsLeft = Math.max(0, event.capacity - event.attendeeCount);
  const full = seatsLeft === 0;
  const notOpen = new Date(event.rsvpOpensAt).getTime() > now;
  const closed = new Date(event.rsvpClosesAt).getTime() <= now;

  return (
    <Card className="group gap-0 rounded-2xl border-0 bg-card py-0 shadow-[0_1px_0_rgb(44_39_30/7%),0_8px_24px_rgb(44_39_30/5%)] ring-1 ring-border/70 transition-transform hover:-translate-y-0.5">
      <article className="grid gap-4 p-4 sm:grid-cols-[76px_minmax(0,1fr)_180px] sm:items-center sm:p-5">
        <div
          className={`${toneFor(event.gameType)} flex h-[68px] w-[68px] shrink-0 flex-col items-center justify-center rounded-2xl text-[#30291f] shadow-[inset_0_-2px_0_rgb(0_0_0/8%)]`}
          aria-label={`${date.day} ${date.number}`}
        >
          <span className="text-[10px] font-black tracking-[0.14em] opacity-70">
            {date.day}
          </span>
          <span className="font-heading text-[25px] font-black leading-none">
            {date.number}
          </span>
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-0 bg-muted px-2 text-[11px] text-muted-foreground"
            >
              {event.gameType}
            </Badge>
            {event.isRsvped && (
              <Badge className="bg-[#e6edd0] text-[#405221] hover:bg-[#e6edd0]">
                <Check />
                Going
              </Badge>
            )}
            {full && !event.isRsvped && (
              <Badge variant="destructive">Full</Badge>
            )}
            {(closed || notOpen) && !event.isRsvped && (
              <Badge variant="secondary">
                {notOpen ? 'Opens soon' : 'RSVP closed'}
              </Badge>
            )}
          </div>
          <CardHeader className="gap-1 px-0">
            <CardTitle className="font-heading text-lg font-extrabold tracking-[-0.02em]">
              {event.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 px-0 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="size-3.5" />
              {date.time}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5" />
              {event.location}
            </span>
          </CardContent>
        </div>
        <div className="border-t border-border/70 pt-3 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
          <div className="mb-2 flex items-baseline justify-between text-xs">
            <span className="font-semibold">
              {full
                ? 'No seats left'
                : `${seatsLeft} ${seatsLeft === 1 ? 'seat' : 'seats'} left`}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {event.attendeeCount}/{event.capacity}
            </span>
          </div>
          <Progress
            value={(event.attendeeCount / event.capacity) * 100}
            className="mb-3 [&_[data-slot=progress-indicator]]:bg-[#e4813f]"
            aria-label={`${event.attendeeCount} of ${event.capacity} seats taken`}
          />
          <Button
            variant={event.isRsvped ? 'secondary' : 'default'}
            className="h-9 w-full rounded-xl"
            onClick={onOpen}
          >
            {organizerView ? (
              <>
                <Users />
                View attendees
              </>
            ) : event.isRsvped ? (
              <>
                <Check />
                View RSVP
              </>
            ) : (
              <>
                <TicketCheck />
                {full || closed || notOpen ? 'View details' : 'View & RSVP'}
              </>
            )}
          </Button>
        </div>
      </article>
    </Card>
  );
}

function HistoryCard({ item }: { item: RsvpHistoryItem }) {
  const reserved = item.action === 'reserved';
  return (
    <Card className="gap-0 rounded-2xl border-0 bg-card py-0 shadow-sm ring-1 ring-border/70">
      <article className="flex gap-3 p-4 sm:items-center sm:p-5">
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-xl ${reserved ? 'bg-[#e6edd0] text-[#526a27]' : 'bg-[#f8e3dc] text-[#9a493c]'}`}
        >
          {reserved ? (
            <TicketCheck className="size-5" />
          ) : (
            <X className="size-5" />
          )}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading font-bold">{item.eventTitle}</h3>
            <Badge variant={reserved ? 'default' : 'secondary'}>
              {reserved ? 'Reserved' : 'Canceled'}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.gameType} · {item.location}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Changed {shortDate(item.occurredAt)} · Event{' '}
            {shortDate(item.startsAt)}
          </p>
        </div>
      </article>
    </Card>
  );
}

export function GameNightApp() {
  const [users, setUsers] = useState<User[]>([]);
  const [metros, setMetros] = useState<Metro[]>([]);
  const [currentUserId, setCurrentUserId] = useState('player-maya');
  const [metroId, setMetroId] = useState('metro-seattle');
  const [view, setView] = useState<View>('discover');
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [history, setHistory] = useState<RsvpHistoryItem[]>([]);
  const [gameTypes, setGameTypes] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [gameType, setGameType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [selectedEvent, setSelectedEvent] = useState<GameEvent | null>(null);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [attendeeState, setAttendeeState] = useState<AttendeeState>('idle');
  const [attendeeError, setAttendeeError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyEventId, setBusyEventId] = useState('');
  const [notice, setNotice] = useState('');
  const [liveState, setLiveState] = useState<LiveState>('live');
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(() => blankForm());
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const changeCursor = useRef(0);
  const eventsRequest = useRef(0);
  const detailRequest = useRef(0);
  const historyRequest = useRef(0);
  const selectedEventId = useRef<string | null>(null);
  const interactionEpoch = useRef(0);
  const pendingReserveKeys = useRef(new Map<string, string>());

  const currentUser = users.find((user) => user.id === currentUserId);
  const isOrganizer = currentUser?.role === 'organizer';

  useEffect(() => {
    const remembered = window.localStorage.getItem('game-night-user');
    Promise.all([
      api<{ users: User[] }>('/api/users'),
      api<{ metros: Metro[] }>('/api/metros'),
    ])
      .then(([userData, metroData]) => {
        setUsers(userData.users);
        setMetros(metroData.metros);
        const nextUser =
          userData.users.find((user) => user.id === remembered) ??
          userData.users[0];
        if (nextUser) {
          setCurrentUserId(nextUser.id);
          setMetroId(nextUser.homeMetroId);
          setCreateForm(blankForm(nextUser.homeMetroId));
          setView(nextUser.role === 'organizer' ? 'manage' : 'discover');
        }
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const loadEvents = useCallback(
    async (background = false, commitCursor = true) => {
      if (!currentUserId) return null;
      const requestVersion = ++eventsRequest.current;
      if (!background) setLoading(true);
      if (!background) setError('');
      const query = new URLSearchParams();
      const scopedMetroId = eventMetroScope(view === 'mine', metroId);
      if (scopedMetroId) query.set('metroId', scopedMetroId);
      if (search.trim()) query.set('search', search.trim());
      if (gameType) query.set('gameType', gameType);
      if (view === 'mine') query.set('mine', 'true');
      if (view === 'manage') query.set('organizerId', currentUserId);
      try {
        const data = await api<{
          events: GameEvent[];
          gameTypes: string[];
          changeCursor: number;
        }>(`/api/events?${query}`, currentUserId);
        if (requestVersion !== eventsRequest.current) return null;
        setEvents(data.events);
        setGameTypes(data.gameTypes);
        if (commitCursor)
          changeCursor.current = Math.max(
            changeCursor.current,
            data.changeCursor,
          );
        setError('');
        setLiveState('live');
        return data.changeCursor;
      } catch (cause) {
        if (requestVersion !== eventsRequest.current) return null;
        if (!background) {
          setEvents([]);
          setGameTypes([]);
        }
        setError(
          cause instanceof Error ? cause.message : 'Could not load events.',
        );
        setLiveState('offline');
        return null;
      } finally {
        if (!background && requestVersion === eventsRequest.current)
          setLoading(false);
      }
    },
    [currentUserId, gameType, metroId, search, view],
  );

  const loadHistory = useCallback(async () => {
    if (!currentUserId) return;
    const requestVersion = ++historyRequest.current;
    setLoading(true);
    setError('');
    try {
      const data = await api<{ history: RsvpHistoryItem[] }>(
        '/api/me/history?limit=100',
        currentUserId,
      );
      if (requestVersion !== historyRequest.current) return;
      setHistory(data.history);
    } catch (cause) {
      if (requestVersion !== historyRequest.current) return;
      setHistory([]);
      setError(
        cause instanceof Error ? cause.message : 'Could not load RSVP history.',
      );
    } finally {
      if (requestVersion === historyRequest.current) setLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        if (view === 'history') void loadHistory();
        else void loadEvents();
      },
      search && view !== 'history' ? 220 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [loadEvents, loadHistory, search, view]);

  const loadEventDetail = useCallback(
    async (eventId: string, showSkeleton = true) => {
      const requestVersion = ++detailRequest.current;
      if (showSkeleton) setDetailLoading(true);
      setAttendeeError('');
      try {
        const data = await api<{ event: GameEvent }>(
          `/api/events/${eventId}`,
          currentUserId,
        );
        if (requestVersion !== detailRequest.current) return null;
        if (selectedEventId.current !== eventId) return null;
        setSelectedEvent(data.event);
        if (isOrganizer && data.event.organizerId === currentUserId) {
          setAttendeeState('loading');
          try {
            const roster = await api<{ attendees: Attendee[] }>(
              `/api/events/${eventId}/attendees`,
              currentUserId,
            );
            if (
              requestVersion !== detailRequest.current ||
              selectedEventId.current !== eventId
            )
              return null;
            setAttendees(roster.attendees);
            setAttendeeState('success');
          } catch (cause) {
            if (
              requestVersion !== detailRequest.current ||
              selectedEventId.current !== eventId
            )
              return null;
            setAttendees([]);
            setAttendeeState('error');
            setAttendeeError(
              cause instanceof Error
                ? cause.message
                : 'Could not load the attendee list.',
            );
          }
        } else {
          setAttendeeState('idle');
        }
        return data.event.version;
      } catch (cause) {
        if (requestVersion !== detailRequest.current) return null;
        setError(
          cause instanceof Error ? cause.message : 'Could not load the event.',
        );
        return null;
      } finally {
        if (showSkeleton && requestVersion === detailRequest.current)
          setDetailLoading(false);
      }
    },
    [currentUserId, isOrganizer],
  );

  const openEvent = (event: GameEvent) => {
    selectedEventId.current = event.id;
    setSelectedEvent(event);
    setAttendees([]);
    setAttendeeState('idle');
    setAttendeeError('');
    void loadEventDetail(event.id);
  };

  const closeEvent = () => {
    interactionEpoch.current += 1;
    detailRequest.current += 1;
    selectedEventId.current = null;
    setSelectedEvent(null);
    setAttendees([]);
    setAttendeeState('idle');
    setAttendeeError('');
    setDetailLoading(false);
    setBusyEventId('');
    setActionError('');
  };

  const clearScopedData = (nextView: View) => {
    eventsRequest.current += 1;
    historyRequest.current += 1;
    setError('');
    setLoading(true);
    if (nextView === 'history') setHistory([]);
    else {
      setEvents([]);
      setGameTypes([]);
    }
  };

  const changeView = (nextView: View) => {
    if (nextView === view) return;
    clearScopedData(nextView);
    closeEvent();
    setView(nextView);
  };

  const changeSearch = (value: string) => {
    eventsRequest.current += 1;
    setEvents([]);
    setGameTypes([]);
    setLoading(true);
    setError('');
    setSearch(value);
  };

  const changeGameType = (value: string) => {
    eventsRequest.current += 1;
    setEvents([]);
    setLoading(true);
    setError('');
    setGameType(value);
  };

  const retryAttendeeList = () => {
    const eventId = selectedEventId.current;
    if (eventId) void loadEventDetail(eventId, false);
  };

  useEffect(() => {
    if (view === 'history') return;
    let stopped = false;
    let polling = false;
    let timer: number | undefined;
    let consecutiveFailures = 0;

    const poll = async () => {
      if (stopped || polling || document.visibilityState !== 'visible')
        return false;
      polling = true;
      setLiveState('syncing');
      try {
        const metroScope = eventMetroScope(view === 'mine', metroId);
        const synchronized = await synchronizeChangePages({
          startingCursor: changeCursor.current,
          fetchPage: async (since) => {
            const page = await api<{
              cursor: number;
              hasMore: boolean;
              changes: Array<{ eventId: string; version: number }>;
            }>(
              `/api/events/changes?since=${since}&metroId=${encodeURIComponent(metroScope)}`,
              currentUserId,
            );
            if (stopped) throw new Error('Polling stopped.');
            return page;
          },
          applyChanges: async (changes) => {
            const snapshotCursor = await loadEvents(true, false);
            if (snapshotCursor === null) {
              throw new Error('The event snapshot could not be applied.');
            }
            const selectedChange = changes.find(
              ({ eventId }) => eventId === selectedEvent?.id,
            );
            if (selectedEvent && selectedChange) {
              const detailVersion = await loadEventDetail(
                selectedEvent.id,
                false,
              );
              if (
                detailVersion === null ||
                detailVersion < selectedChange.version
              ) {
                throw new Error('The selected event could not be refreshed.');
              }
            }
            return snapshotCursor;
          },
        });
        if (stopped) return false;
        changeCursor.current = Math.max(
          changeCursor.current,
          synchronized.cursor,
        );
        setLiveState(synchronized.hasMore ? 'syncing' : 'live');
        consecutiveFailures = 0;
        return synchronized.hasMore ? 'more' : 'idle';
      } catch {
        consecutiveFailures += 1;
        setLiveState('offline');
        return 'failed';
      } finally {
        polling = false;
      }
    };

    const schedule = (delay?: number) => {
      timer = window.setTimeout(
        async () => {
          const result = await poll();
          if (!stopped)
            schedule(
              result === 'more' ? 50 : nextChangePollDelay(consecutiveFailures),
            );
        },
        delay ?? nextChangePollDelay(consecutiveFailures),
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        consecutiveFailures = 0;
        void poll();
      }
    };
    const onOnline = () => {
      consecutiveFailures = 0;
      void poll();
    };
    schedule();
    window.addEventListener('focus', onVisibility);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('focus', onVisibility);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [
    currentUserId,
    loadEventDetail,
    loadEvents,
    metroId,
    selectedEvent,
    view,
  ]);

  const refreshSelected = async (eventId: string) => {
    await loadEvents(true);
    if (selectedEventId.current === eventId) {
      await loadEventDetail(eventId, false);
    }
  };

  const changeRsvp = async (event: GameEvent) => {
    const epoch = interactionEpoch.current;
    const actorId = currentUserId;
    const operationKey = `${actorId}:${event.id}`;
    let reserveKey = pendingReserveKeys.current.get(operationKey);
    if (!event.isRsvped && !reserveKey) {
      reserveKey = crypto.randomUUID();
      pendingReserveKeys.current.set(operationKey, reserveKey);
    }
    setBusyEventId(event.id);
    setActionError('');
    try {
      if (event.isRsvped && !event.rsvpVersion) {
        throw new Error('Refresh this event before canceling the reservation.');
      }
      await api(`/api/events/${event.id}/rsvp`, actorId, {
        method: event.isRsvped ? 'DELETE' : 'POST',
        headers: event.isRsvped
          ? { 'if-match': `"${event.rsvpVersion}"` }
          : { 'idempotency-key': reserveKey! },
      });
      if (!event.isRsvped) pendingReserveKeys.current.delete(operationKey);
      if (epoch !== interactionEpoch.current || actorId !== currentUserId)
        return;
      setNotice(
        event.isRsvped
          ? 'RSVP canceled — the seat is open again.'
          : 'You’re in! Your seat is saved.',
      );
      await refreshSelected(event.id);
    } catch (cause) {
      if (epoch !== interactionEpoch.current || actorId !== currentUserId)
        return;
      setActionError(
        cause instanceof Error ? cause.message : 'Could not update your RSVP.',
      );
      await refreshSelected(event.id).catch(() => undefined);
    } finally {
      if (epoch === interactionEpoch.current && actorId === currentUserId) {
        setBusyEventId('');
      }
    }
  };

  const changeSelectedRsvp = () => {
    if (selectedEvent) void changeRsvp(selectedEvent);
  };

  const onIdentityChange = (nextId: string) => {
    eventsRequest.current += 1;
    historyRequest.current += 1;
    setEvents([]);
    setHistory([]);
    setCurrentUserId(nextId);
    window.localStorage.setItem('game-night-user', nextId);
    const nextUser = users.find((user) => user.id === nextId);
    const nextMetro = nextUser?.homeMetroId ?? 'metro-seattle';
    setMetroId(nextMetro);
    setCreateForm(blankForm(nextMetro));
    setView(nextUser?.role === 'organizer' ? 'manage' : 'discover');
    closeEvent();
    setSearch('');
    setGameType('');
  };

  const onMetroChange = (nextMetro: string) => {
    eventsRequest.current += 1;
    setEvents([]);
    setMetroId(nextMetro);
    setCreateForm((form) => ({ ...form, metroId: nextMetro }));
    closeEvent();
    setSearch('');
    setGameType('');
  };

  const onStartChange = (startsAt: string) => {
    setCreateForm((form) => ({
      ...form,
      startsAt,
      rsvpClosesAt:
        !form.rsvpClosesAt || form.rsvpClosesAt === form.startsAt
          ? startsAt
          : form.rsvpClosesAt,
      cancellationClosesAt:
        !form.cancellationClosesAt ||
        form.cancellationClosesAt === form.startsAt
          ? startsAt
          : form.cancellationClosesAt,
    }));
  };

  const createEvent = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      await api('/api/events', currentUserId, {
        method: 'POST',
        body: JSON.stringify({
          ...createForm,
          startsAt: new Date(createForm.startsAt).toISOString(),
          rsvpClosesAt: new Date(createForm.rsvpClosesAt).toISOString(),
          cancellationClosesAt: new Date(
            createForm.cancellationClosesAt,
          ).toISOString(),
          capacity: Number(createForm.capacity),
        }),
      });
      setCreateOpen(false);
      setCreateForm(blankForm(metroId));
      setNotice('Event published — your table is ready.');
      changeView('manage');
      await loadEvents(true);
    } catch (cause) {
      setCreateError(
        cause instanceof Error ? cause.message : 'Could not create the event.',
      );
    } finally {
      setCreating(false);
    }
  };

  const weekCount = useMemo(() => {
    const nextWeek = clockNow + 7 * 24 * 60 * 60 * 1000;
    return events.filter(
      (event) => new Date(event.startsAt).getTime() <= nextWeek,
    ).length;
  }, [clockNow, events]);
  const visibleError = actionError || error;

  const activeTitle =
    view === 'mine'
      ? 'Your saved seats.'
      : view === 'history'
        ? 'Your RSVP history.'
        : view === 'manage'
          ? 'Your hosted tables.'
          : 'Find your next table.';
  const activeSubtitle =
    view === 'mine'
      ? 'Everything you’ve joined, with the soonest game first.'
      : view === 'history'
        ? 'A durable timeline of reservations and cancellations.'
        : view === 'manage'
          ? 'Upcoming events you’re organizing and their live rosters.'
          : 'Local games, good people, and a seat with your name on it.';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/92 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <button
            className="flex min-w-0 items-center gap-2.5 text-left"
            onClick={() => changeView(isOrganizer ? 'manage' : 'discover')}
            aria-label="Game Night home"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-primary text-primary-foreground shadow-[0_5px_14px_rgb(40_54_24/18%)]">
              <Sparkles className="size-4" />
            </span>
            <span>
              <span className="block font-heading text-[17px] font-extrabold leading-none tracking-[-0.03em]">
                Game Night
              </span>
              <span className="mt-1 hidden text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:block">
                Community event board
              </span>
            </span>
          </button>
          <nav
            className="ml-auto hidden items-center gap-1 rounded-xl bg-muted p-1 sm:flex"
            aria-label="Primary navigation"
          >
            {isOrganizer ? (
              <>
                <Button
                  variant={view === 'manage' ? 'default' : 'ghost'}
                  className="h-8 rounded-lg px-4"
                  onClick={() => changeView('manage')}
                >
                  My events
                </Button>
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-4 text-muted-foreground"
                  onClick={() => setCreateOpen(true)}
                >
                  Create event
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant={view === 'discover' ? 'default' : 'ghost'}
                  className="h-8 rounded-lg px-4"
                  onClick={() => changeView('discover')}
                >
                  Discover
                </Button>
                <Button
                  variant={view === 'mine' ? 'default' : 'ghost'}
                  className="h-8 rounded-lg px-4"
                  onClick={() => changeView('mine')}
                >
                  My events
                </Button>
                <Button
                  variant={view === 'history' ? 'default' : 'ghost'}
                  className="h-8 rounded-lg px-4"
                  onClick={() => changeView('history')}
                >
                  History
                </Button>
              </>
            )}
          </nav>
          <div className="relative ml-auto sm:ml-2">
            <NativeSelect
              className="w-[128px] sm:w-[176px]"
              value={currentUserId}
              onChange={(event) => onIdentityChange(event.target.value)}
              aria-label="Choose your identity"
            >
              <NativeSelectOptGroup label="Players">
                {users
                  .filter((user) => user.role === 'player')
                  .map((user) => (
                    <NativeSelectOption key={user.id} value={user.id}>
                      {user.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelectOptGroup>
              <NativeSelectOptGroup label="Organizers">
                {users
                  .filter((user) => user.role === 'organizer')
                  .map((user) => (
                    <NativeSelectOption key={user.id} value={user.id}>
                      {user.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelectOptGroup>
            </NativeSelect>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-6 sm:pt-11">
        <section className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge className="h-6 bg-[#e8edcf] px-2.5 text-[#405221] hover:bg-[#e8edcf]">
                <span className="mr-1 size-1.5 rounded-full bg-[#76943f]" />
                {view === 'history'
                  ? `${history.length} changes`
                  : `${weekCount} ${weekCount === 1 ? 'game' : 'games'} this week`}
              </Badge>
              {view !== 'history' && (
                <Badge variant="outline" className="h-6 bg-card">
                  <Radio
                    className={`size-3 ${liveState === 'offline' ? 'text-destructive' : 'text-[#6f873a]'}`}
                  />
                  {liveState === 'syncing'
                    ? 'Syncing'
                    : liveState === 'offline'
                      ? 'Reconnecting'
                      : 'Live · 5s'}
                </Badge>
              )}
            </div>
            <h1 className="font-heading text-3xl font-black tracking-[-0.045em] sm:text-[42px] sm:leading-[1.05]">
              {activeTitle}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              {activeSubtitle}
            </p>
          </div>
          {view !== 'history' && (
            <div className="flex w-full flex-wrap gap-2 md:w-auto md:flex-nowrap">
              <label className="relative min-w-48 flex-1 md:w-60">
                <span className="sr-only">Search events</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => changeSearch(event.target.value)}
                  className="h-11 rounded-xl bg-card pl-9 shadow-sm"
                  placeholder="Search games or places"
                />
                {search && (
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted"
                    onClick={() => changeSearch('')}
                    aria-label="Clear search"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </label>
              {view !== 'mine' && (
                <NativeSelect
                  className="h-11 w-[128px]"
                  value={metroId}
                  onChange={(event) => onMetroChange(event.target.value)}
                  aria-label="Choose metro area"
                >
                  {metros.map((metro) => (
                    <NativeSelectOption key={metro.id} value={metro.id}>
                      {metro.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
              <NativeSelect
                className="h-11 w-[132px]"
                value={gameType}
                onChange={(event) => changeGameType(event.target.value)}
                aria-label="Filter by game type"
              >
                <NativeSelectOption value="">All games</NativeSelectOption>
                {gameTypes.map((type) => (
                  <NativeSelectOption key={type} value={type}>
                    {type}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {isOrganizer && (
                <Button
                  className="hidden h-11 rounded-xl px-4 md:flex"
                  onClick={() => setCreateOpen(true)}
                >
                  Create event
                </Button>
              )}
            </div>
          )}
        </section>

        {visibleError && (
          <Alert variant="destructive" className="mb-4 bg-card">
            <CircleAlert />
            <AlertTitle>We hit a snag</AlertTitle>
            <AlertDescription>{visibleError}</AlertDescription>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-2 top-2"
              onClick={() => {
                setActionError('');
                setError('');
              }}
              aria-label="Dismiss error"
            >
              <X />
            </Button>
          </Alert>
        )}

        {view === 'history' ? (
          <section aria-labelledby="history-heading">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="history-heading" className="text-sm font-bold">
                Recent RSVP activity
              </h2>
              <p className="text-xs text-muted-foreground">Newest first</p>
            </div>
            {loading ? (
              <output className="grid gap-3" aria-label="Loading RSVP history">
                {[0, 1, 2].map((item) => (
                  <Skeleton key={item} className="h-24 rounded-2xl" />
                ))}
              </output>
            ) : error ? null : history.length === 0 ? (
              <Empty className="min-h-64 border border-border bg-card/70">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <History />
                  </EmptyMedia>
                  <EmptyTitle>No RSVP history yet</EmptyTitle>
                  <EmptyDescription>
                    Reserve or cancel a seat and the durable activity will
                    appear here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="grid gap-3">
                {history.map((item) => (
                  <HistoryCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </section>
        ) : (
          <section aria-labelledby="upcoming-heading">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="upcoming-heading" className="text-sm font-bold">
                {view === 'mine'
                  ? 'My upcoming events'
                  : view === 'manage'
                    ? 'Events I organize'
                    : 'Upcoming near you'}
              </h2>
              <p className="text-xs text-muted-foreground">Soonest first</p>
            </div>
            {loading ? (
              <output className="grid gap-3" aria-label="Loading events">
                {[0, 1, 2].map((item) => (
                  <Skeleton
                    key={item}
                    className="h-[184px] rounded-2xl sm:h-[110px]"
                  />
                ))}
              </output>
            ) : error ? null : events.length === 0 ? (
              <Empty className="min-h-64 border border-border bg-card/70">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search />
                  </EmptyMedia>
                  <EmptyTitle>No tables found</EmptyTitle>
                  <EmptyDescription>
                    {view === 'mine'
                      ? 'RSVP to an event and it’ll appear here.'
                      : 'Try another metro, search, or game filter.'}
                  </EmptyDescription>
                </EmptyHeader>
                {(search || gameType) && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      changeSearch('');
                      changeGameType('');
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </Empty>
            ) : (
              <div className="grid gap-3">
                {events.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onOpen={() => openEvent(event)}
                    organizerView={Boolean(isOrganizer)}
                    now={clockNow}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        <section
          className="relative mt-8 hidden h-40 overflow-hidden rounded-2xl bg-[#261d14] shadow-lg md:block"
          aria-label="Game Night community"
        >
          <Image
            src="/og.png"
            alt="A warmly lit tabletop set for game night"
            fill
            sizes="(min-width: 768px) 1100px, 0px"
            className="object-cover object-center"
          />
        </section>
      </div>

      {notice && (
        <output
          className="fixed right-4 top-20 z-50 flex max-w-sm items-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-xl"
          aria-live="polite"
        >
          <Check className="size-4" />
          {notice}
        </output>
      )}

      <nav
        className="fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-2xl border border-border/70 bg-card/95 p-1.5 shadow-[0_12px_40px_rgb(36_31_24/18%)] backdrop-blur-xl sm:hidden"
        aria-label="Mobile navigation"
      >
        {isOrganizer ? (
          <>
            <Button
              variant={view === 'manage' ? 'default' : 'ghost'}
              className="h-11 flex-1 rounded-xl"
              onClick={() => changeView('manage')}
            >
              <Users />
              My events
            </Button>
            <Button
              variant="ghost"
              className="h-11 flex-1 rounded-xl text-muted-foreground"
              onClick={() => setCreateOpen(true)}
            >
              <CalendarDays />
              Create
            </Button>
          </>
        ) : (
          <>
            <Button
              variant={view === 'discover' ? 'default' : 'ghost'}
              className="h-11 flex-1 rounded-xl"
              onClick={() => changeView('discover')}
            >
              <Search />
              Discover
            </Button>
            <Button
              variant={view === 'mine' ? 'default' : 'ghost'}
              className="h-11 flex-1 rounded-xl"
              onClick={() => changeView('mine')}
            >
              <TicketCheck />
              My events
            </Button>
            <Button
              variant={view === 'history' ? 'default' : 'ghost'}
              className="h-11 flex-1 rounded-xl"
              onClick={() => changeView('history')}
            >
              <History />
              History
            </Button>
          </>
        )}
      </nav>

      <Dialog
        open={Boolean(selectedEvent)}
        onOpenChange={(open) => !open && closeEvent()}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {selectedEvent &&
            (() => {
              const date = eventDate(
                selectedEvent.startsAt,
                selectedEvent.timezone,
              );
              const seatsLeft = Math.max(
                0,
                selectedEvent.capacity - selectedEvent.attendeeCount,
              );
              const ownEvent =
                isOrganizer && selectedEvent.organizerId === currentUserId;
              const rsvpNotOpen =
                new Date(selectedEvent.rsvpOpensAt).getTime() > clockNow;
              const rsvpClosed =
                new Date(selectedEvent.rsvpClosesAt).getTime() <= clockNow;
              const cancelClosed =
                new Date(selectedEvent.cancellationClosesAt).getTime() <=
                clockNow;
              const cannotReserve =
                seatsLeft === 0 || rsvpNotOpen || rsvpClosed;
              const actionLabel = rsvpNotOpen
                ? 'RSVP not open'
                : rsvpClosed
                  ? 'RSVP closed'
                  : seatsLeft === 0
                    ? 'Event full'
                    : 'Save my seat';
              return (
                <>
                  <DialogHeader>
                    <div className="mb-1 flex flex-wrap gap-2">
                      <Badge variant="outline">{selectedEvent.gameType}</Badge>
                      <Badge variant="secondary">
                        <MapPin />
                        {selectedEvent.metroName}
                      </Badge>
                      {selectedEvent.isRsvped && (
                        <Badge className="bg-[#e6edd0] text-[#405221]">
                          <Check />
                          You’re going
                        </Badge>
                      )}
                    </div>
                    <DialogTitle className="pr-8 font-heading text-2xl font-black tracking-[-0.035em]">
                      {selectedEvent.title}
                    </DialogTitle>
                    <DialogDescription>
                      Hosted by {selectedEvent.organizerName}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-3 rounded-xl bg-muted/70 p-4 text-sm">
                    <p className="flex items-start gap-2">
                      <CalendarDays className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span>
                        <strong>{date.long}</strong>
                        <br />
                        <span className="text-muted-foreground">
                          at {date.time}
                        </span>
                      </span>
                    </p>
                    <p className="flex items-center gap-2">
                      <MapPin className="size-4 shrink-0 text-muted-foreground" />
                      {selectedEvent.location}
                    </p>
                    <p className="flex items-center gap-2">
                      <Users className="size-4 shrink-0 text-muted-foreground" />
                      {selectedEvent.attendeeCount} of {selectedEvent.capacity}{' '}
                      seats taken · <strong>{seatsLeft} left</strong>
                    </p>
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock3 className="size-4 shrink-0" />
                      RSVP closes{' '}
                      {shortDate(
                        selectedEvent.rsvpClosesAt,
                        selectedEvent.timezone,
                      )}{' '}
                      · Cancel by{' '}
                      {shortDate(
                        selectedEvent.cancellationClosesAt,
                        selectedEvent.timezone,
                      )}
                    </p>
                    <Progress
                      value={
                        (selectedEvent.attendeeCount / selectedEvent.capacity) *
                        100
                      }
                      className="[&_[data-slot=progress-indicator]]:bg-[#e4813f]"
                      aria-label={`${selectedEvent.attendeeCount} of ${selectedEvent.capacity} seats taken`}
                    />
                  </div>
                  {detailLoading ? (
                    <Skeleton className="h-24 w-full rounded-xl" />
                  ) : ownEvent ? (
                    <section>
                      <h3 className="mb-2 text-sm font-bold">Attendee list</h3>
                      {attendeeState === 'loading' ? (
                        <Skeleton
                          className="h-24 w-full rounded-xl"
                          aria-label="Loading attendee list"
                        />
                      ) : attendeeState === 'error' ? (
                        <Alert variant="destructive">
                          <CircleAlert />
                          <AlertTitle>Attendee list unavailable</AlertTitle>
                          <AlertDescription>{attendeeError}</AlertDescription>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={retryAttendeeList}
                          >
                            Retry
                          </Button>
                        </Alert>
                      ) : attendeeState === 'success' && attendees.length ? (
                        <ul className="divide-y divide-border rounded-xl border bg-card">
                          {attendees.map((attendee, index) => (
                            <li
                              key={attendee.id}
                              className="flex items-center gap-3 px-3 py-2.5"
                            >
                              <span className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-black">
                                {index + 1}
                              </span>
                              <span className="font-medium">
                                {attendee.name}
                              </span>
                              <Check className="ml-auto size-4 text-[#6f873a]" />
                            </li>
                          ))}
                        </ul>
                      ) : attendeeState === 'success' ? (
                        <p className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">
                          No RSVPs yet. The first seat is waiting.
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                  {!isOrganizer && (
                    <DialogFooter>
                      <Button
                        className="h-10 w-full rounded-xl sm:w-auto"
                        variant={
                          selectedEvent.isRsvped ? 'destructive' : 'default'
                        }
                        disabled={
                          busyEventId === selectedEvent.id ||
                          (selectedEvent.isRsvped
                            ? cancelClosed
                            : cannotReserve)
                        }
                        onClick={changeSelectedRsvp}
                      >
                        {busyEventId === selectedEvent.id ? (
                          <>
                            <Clock3 className="animate-spin" />
                            Saving…
                          </>
                        ) : selectedEvent.isRsvped ? (
                          cancelClosed ? (
                            'Cancellation closed'
                          ) : (
                            'Cancel RSVP'
                          )
                        ) : (
                          <>
                            <TicketCheck />
                            {actionLabel}
                          </>
                        )}
                      </Button>
                    </DialogFooter>
                  )}
                </>
              );
            })()}
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-heading text-xl font-black">
              Post a new event
            </DialogTitle>
            <DialogDescription>
              Give players the location, capacity, and reservation deadlines up
              front.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createEvent}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="title">Event title</FieldLabel>
                <Input
                  id="title"
                  required
                  minLength={3}
                  maxLength={100}
                  value={createForm.title}
                  onChange={(event) =>
                    setCreateForm({ ...createForm, title: event.target.value })
                  }
                  placeholder="Friday Night Draft"
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="gameType">Game type</FieldLabel>
                  <Input
                    id="gameType"
                    required
                    maxLength={60}
                    value={createForm.gameType}
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        gameType: event.target.value,
                      })
                    }
                    placeholder="Magic: The Gathering"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="metro">Metro</FieldLabel>
                  <NativeSelect
                    id="metro"
                    value={createForm.metroId}
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        metroId: event.target.value,
                      })
                    }
                  >
                    {metros.map((metro) => (
                      <NativeSelectOption key={metro.id} value={metro.id}>
                        {metro.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="startsAt">
                    Event date and time
                  </FieldLabel>
                  <Input
                    id="startsAt"
                    type="datetime-local"
                    required
                    min={toLocalDateTimeValue(new Date(clockNow))}
                    value={createForm.startsAt}
                    onChange={(event) => onStartChange(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="capacity">Capacity</FieldLabel>
                  <Input
                    id="capacity"
                    type="number"
                    min="1"
                    max="500"
                    step="1"
                    required
                    value={createForm.capacity}
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        capacity: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="location">Location</FieldLabel>
                <Input
                  id="location"
                  required
                  minLength={3}
                  maxLength={160}
                  value={createForm.location}
                  onChange={(event) =>
                    setCreateForm({
                      ...createForm,
                      location: event.target.value,
                    })
                  }
                  placeholder="Meeple House · Ballard"
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="rsvpClosesAt">RSVP closes</FieldLabel>
                  <Input
                    id="rsvpClosesAt"
                    type="datetime-local"
                    required
                    min={toLocalDateTimeValue(new Date(clockNow))}
                    value={createForm.rsvpClosesAt}
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        rsvpClosesAt: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="cancellationClosesAt">
                    Cancellation closes
                  </FieldLabel>
                  <Input
                    id="cancellationClosesAt"
                    type="datetime-local"
                    required
                    min={toLocalDateTimeValue(new Date(clockNow))}
                    value={createForm.cancellationClosesAt}
                    onChange={(event) =>
                      setCreateForm({
                        ...createForm,
                        cancellationClosesAt: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              {createError && <FieldError>{createError}</FieldError>}
            </FieldGroup>
            <DialogFooter className="mt-5">
              <Button
                type="submit"
                className="h-10 rounded-xl"
                disabled={creating}
              >
                {creating ? 'Publishing…' : 'Publish event'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-xl"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
