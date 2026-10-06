// Who may do what to an event: its organiser manages it; the organiser and staff the organiser added may scan tickets.
import type { Conn, Ctx } from './db.js';
import { one } from './db.js';
import { AppError } from './errors.js';
import type { User } from './auth.js';

type Q = Conn | Ctx['pool'];

export async function isOrganiserOf(q: Q, userId: string, eventId: string): Promise<boolean> {
  return !!(await one(q, 'SELECT 1 FROM events WHERE id = $1 AND organiser_id = $2', [eventId, userId]));
}

export async function canScan(q: Q, userId: string, eventId: string): Promise<boolean> {
  return (await isOrganiserOf(q, userId, eventId)) || !!(await one(q, 'SELECT 1 FROM event_staff WHERE event_id = $1 AND user_id = $2', [eventId, userId]));
}

/** 404 rather than 403 for someone else's event, so ids cannot be probed. */
export async function requireOrganiserOf(q: Q, user: User, eventId: string): Promise<void> {
  if (!(await isOrganiserOf(q, user.id, eventId))) throw new AppError('NOT_FOUND', 404, 'Event not found');
}

export function requireRole(user: User, role: User['role']): void {
  if (user.role !== role) throw new AppError('FORBIDDEN', 403, `This needs an ${role.toLowerCase()} account`);
}
