/**
 * Turns a natural time word into a concrete [from, to) range, in local time.
 * The model already knows today's date (it is in the system prompt), so this
 * only needs to handle the handful of relative words it might send instead of
 * computing exact dates itself; an explicit "onDate"/"fromDate"/"toDate"
 * (YYYY-MM-DD) the model computed is handled separately by the caller.
 */
export type WhenValue = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month';

export const WHEN_VALUES: readonly WhenValue[] = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'];

export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** Monday-start week, since that is how most people mean "this week". */
function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(startOfDay(d), diff);
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function resolveWhen(when: WhenValue, now: Date): DateRange {
  const today = startOfDay(now);
  switch (when) {
    case 'today':
      return { from: today, to: addDays(today, 1) };
    case 'yesterday':
      return { from: addDays(today, -1), to: today };
    case 'this_week': {
      const from = startOfWeek(now);
      return { from, to: addDays(from, 7) };
    }
    case 'last_week': {
      const from = addDays(startOfWeek(now), -7);
      return { from, to: addDays(from, 7) };
    }
    case 'this_month': {
      const from = startOfMonth(now);
      return { from, to: new Date(from.getFullYear(), from.getMonth() + 1, 1) };
    }
    case 'last_month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from, to: startOfMonth(now) };
    }
  }
}

/** A single "YYYY-MM-DD" becomes that whole day; an invalid string is rejected rather than silently ignored. */
export function parseDateOnly(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (m === null) return null;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}
