export const WINDOW_DAYS = 30;

/** Late-night window used by the policy matrix, expressed in whole hours. */
export const LATE_NIGHT_FROM_HOUR = 22;
export const LATE_NIGHT_TO_HOUR = 5;

export type Signal = { code: string; label: string; detail: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' };

export type PolicyState = 'NORMAL' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'CRITICAL';

// Defensible policy matrix (documented in HANDOVER / STATUS ledger):
//   +2  three or more late-night clock events (after 22:00) in the window
//   +2  six or more consecutive working days
//   +1  one or two late-night clock events
//   +1  a five-day streak
//   +1  fewer than 7h rest between last clock-out and next clock-in
//   +1  more than 24 working days in the 30-day window
// Score -> state: 0 NORMAL | 1 WATCH | 2 ELEVATED | 3 HIGH | >=4 CRITICAL
export function policyState(score: number): PolicyState {
  if (score <= 0) return 'NORMAL';
  if (score === 1) return 'WATCH';
  if (score === 2) return 'ELEVATED';
  if (score === 3) return 'HIGH';
  return 'CRITICAL';
}

export const POLICY_RULES = [
  { id: 'late_night_major', points: 2, description: 'Three or more clock events after 22:00 in the last 30 days' },
  { id: 'streak_major', points: 2, description: 'Six or more consecutive working days in the last 30 days' },
  { id: 'late_night_minor', points: 1, description: 'One or two clock events after 22:00 in the last 30 days' },
  { id: 'streak_minor', points: 1, description: 'A five-day consecutive working streak in the last 30 days' },
  { id: 'short_rest', points: 1, description: 'Fewer than 7 hours between last clock-out and next clock-in' },
  { id: 'high_workdays', points: 1, description: 'More than 24 working days in the last 30 days' },
] as const;

export interface AttendanceEvent {
  person_id: string;
  event_type: string;
  occurred_at: string;
}

/**
 * The declared basis of the report. It travels WITH the numbers so no consumer
 * can present a policy state as a fact about a person: every state is a
 * threshold on clock-event timestamps, and nothing else.
 */
export interface WorkloadBasis {
  window_days: number;
  late_night_from_hour: number;
  late_night_to_hour: number;
  timezone: string;
  derived_from: string;
  is_derived_indicator: true;
  disclaimer: string;
}

export interface WorkloadReport {
  signals: Signal[];
  score: number;
  state: PolicyState;
  triggered_rules: string[];
  workDays: number;
  lateNight: number;
  maxStreak: number;
  minGap: number | null;
  basis: WorkloadBasis;
}

export interface WorkloadOptions {
  /**
   * Timezone in which day boundaries and the late-night window are evaluated.
   * When omitted the process-local timezone is used, which is what this module
   * did before the option existed. Callers that serve real people should pass
   * the organization timezone: a "late-night" flag computed in the wrong zone
   * is a false statement about someone's working hours.
   */
  timeZone?: string;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    FORMATTERS.set(timeZone, fmt);
    return fmt;
  } catch {
    // An unusable configured timezone must not take the endpoint down; fall
    // back to process-local time and keep the label honest via `basis`.
    return null;
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function zonedFields(d: Date, timeZone: string | undefined): { dayKey: string; hour: number } {
  const fmt = timeZone ? formatterFor(timeZone) : null;
  if (!fmt) {
    return {
      dayKey: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      hour: d.getHours(),
    };
  }
  const parts = fmt.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  // Some ICU builds render midnight as "24" even under h23.
  const hour = Number(get('hour')) % 24;
  return {
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number.isFinite(hour) ? hour : 0,
  };
}

function resolvedZoneLabel(timeZone: string | undefined): string {
  if (timeZone && formatterFor(timeZone)) return timeZone;
  if (timeZone) return `${timeZone} (unrecognised; evaluated in server local time)`;
  return 'server local time';
}

export function computeWorkloadSignals(
  events: AttendanceEvent[],
  options: WorkloadOptions = {}
): WorkloadReport {
  const timeZone = options.timeZone;
  const byDay = new Map<string, Set<string>>();
  let lateNight = 0;
  const lateNightDays = new Set<string>();
  const gaps: number[] = [];

  const sorted = [...events].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  const daily: { day: string; first: number; last: number }[] = [];

  for (const ev of sorted) {
    const d = new Date(ev.occurred_at);
    const { dayKey: localKey, hour } = zonedFields(d, timeZone);
    if (!byDay.has(localKey)) byDay.set(localKey, new Set());
    byDay.get(localKey)!.add(ev.event_type === 'CLOCK_OUT' ? 'work' : ev.event_type);

    if ((hour >= LATE_NIGHT_FROM_HOUR || hour < LATE_NIGHT_TO_HOUR) && (ev.event_type === 'CLOCK_IN' || ev.event_type === 'CLOCK_OUT')) {
      lateNight++;
      lateNightDays.add(localKey);
    }
    if (ev.event_type === 'CLOCK_IN' || ev.event_type === 'CLOCK_OUT') {
      const slot = daily.find((x) => x.day === localKey);
      const t = d.getTime();
      if (slot) {
        slot.first = Math.min(slot.first, t);
        slot.last = Math.max(slot.last, t);
      } else {
        daily.push({ day: localKey, first: t, last: t });
      }
    }
  }

  daily.sort((a, b) => a.day.localeCompare(b.day));
  for (let i = 1; i < daily.length; i++) {
    gaps.push((daily[i]!.first - daily[i - 1]!.last) / 3600000);
  }

  let streak = 0;
  let maxStreak = 0;
  const days = [...byDay.keys()].sort();
  for (let i = 0; i < days.length; i++) {
    const cur = new Date(days[i]!);
    const prev = i > 0 ? new Date(days[i - 1]!) : null;
    if (prev && (cur.getTime() - prev.getTime()) / 86400000 === 1) {
      streak++;
    } else {
      streak = 1;
    }
    maxStreak = Math.max(maxStreak, streak);
  }

  const minGap = gaps.length ? Math.min(...gaps) : Infinity;
  const signals: Signal[] = [];
  const triggered: string[] = [];

  let lateNightPoints = 0;
  if (lateNight >= 3) {
    lateNightPoints = 2;
    signals.push({
      code: 'late_night',
      label: 'Late-night work',
      detail: `${lateNight} clock events after 22:00 across ${lateNightDays.size} day(s) in the last ${WINDOW_DAYS} days.`,
      severity: 'HIGH',
    });
    triggered.push('late_night_major');
  } else if (lateNight >= 1) {
    lateNightPoints = 1;
    signals.push({
      code: 'late_night',
      label: 'Late-night work',
      detail: `${lateNight} clock event(s) after 22:00 in the last ${WINDOW_DAYS} days.`,
      severity: 'MEDIUM',
    });
    triggered.push('late_night_minor');
  }

  let streakPoints = 0;
  if (maxStreak >= 6) {
    streakPoints = 2;
    signals.push({
      code: 'long_streak',
      label: 'Long work streak',
      detail: `${maxStreak} consecutive working days in the last ${WINDOW_DAYS} days.`,
      severity: 'HIGH',
    });
    triggered.push('streak_major');
  } else if (maxStreak >= 5) {
    streakPoints = 1;
    signals.push({
      code: 'long_streak',
      label: 'Long work streak',
      detail: `${maxStreak} consecutive working days in the last ${WINDOW_DAYS} days.`,
      severity: 'MEDIUM',
    });
    triggered.push('streak_minor');
  }

  if (minGap < 7) {
    signals.push({
      code: 'short_rest',
      label: 'Short rest between days',
      detail: `Only ${minGap.toFixed(1)}h between your last and next clock event.`,
      severity: 'MEDIUM',
    });
    triggered.push('short_rest');
  }

  let workdaysPoints = 0;
  if (byDay.size > 24) {
    workdaysPoints = 1;
    signals.push({
      code: 'high_workdays',
      label: 'Very full schedule',
      detail: `${byDay.size} working days in the last ${WINDOW_DAYS} days.`,
      severity: 'MEDIUM',
    });
    triggered.push('high_workdays');
  }

  if (signals.length === 0) {
    signals.push({
      code: 'balanced',
      label: 'No workload red flags',
      detail: 'No late-night work, long streaks, or short rest gaps in the lookback window.',
      severity: 'LOW',
    });
  }

  const score = lateNightPoints + streakPoints + (minGap < 7 ? 1 : 0) + workdaysPoints;
  const state = policyState(score);

  return {
    signals,
    score,
    state,
    triggered_rules: triggered,
    workDays: byDay.size,
    lateNight,
    maxStreak,
    minGap: minGap === Infinity ? null : minGap,
    basis: {
      window_days: WINDOW_DAYS,
      late_night_from_hour: LATE_NIGHT_FROM_HOUR,
      late_night_to_hour: LATE_NIGHT_TO_HOUR,
      timezone: resolvedZoneLabel(timeZone),
      derived_from: 'clock-in and clock-out timestamps recorded in attendance_events',
      is_derived_indicator: true,
      disclaimer:
        'This is a derived scheduling indicator, not a medical, wellbeing or performance assessment. ' +
        'It is computed only from clock-event timestamps and says nothing about why anyone worked those hours, ' +
        'their health, or the reason for any absence.',
    },
  };
}
