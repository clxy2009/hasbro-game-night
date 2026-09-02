import { z } from 'zod';

export const createEventSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, 'Title must be at least 3 characters.')
    .max(100),
  gameType: z.string().trim().min(2, 'Game type is required.').max(60),
  metroId: z.string().trim().min(1).max(64).optional(),
  startsAt: z.iso.datetime({ offset: true }),
  location: z
    .string()
    .trim()
    .min(3, 'Location must be at least 3 characters.')
    .max(160),
  capacity: z.coerce.number().int().min(1).max(500),
  rsvpOpensAt: z.iso.datetime({ offset: true }).optional(),
  rsvpClosesAt: z.iso.datetime({ offset: true }).optional(),
  cancellationClosesAt: z.iso.datetime({ offset: true }).optional(),
});
