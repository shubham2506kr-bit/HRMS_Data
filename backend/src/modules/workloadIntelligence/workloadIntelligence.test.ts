import { describe, it, expect } from 'vitest';
import { teamHealthIndex } from './teamHealth.js';
import { computeWorkloadSignals, policyState, POLICY_RULES } from './signals.js';

const day = (d: number, h: number, m: number) => new Date(2026, 7, d, h, m).toISOString();
const ev = (t: string, iso: string) => ({ person_id: 'p1', event_type: t, occurred_at: iso });

const all = (state: 'NORMAL' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'CRITICAL', count: number) => ({
  memberCount: count,
  states: Array.from({ length: count }, () => state),
  lateNightCounts: Array.from({ length: count }, () => 0),
  minGaps: Array.from({ length: count }, () => 9),
  workDays: Array.from({ length: count }, () => 20),
  approvedLeaveMemberCount: 0,
});

describe('teamHealthIndex', () => {
  it('a fully balanced group scores 100 HEALTHY', () => {
    const r = teamHealthIndex(all('NORMAL', 10));
    expect(r.index).toBe(100);
    expect(r.band).toBe('HEALTHY');
  });

  it('weights sum to 100 and every component is explainable', () => {
    const r = teamHealthIndex(all('WATCH', 8));
    expect(r.components.reduce((s, c) => s + c.weight, 0)).toBe(100);
    for (const c of r.components) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(c.formula.length).toBeGreaterThan(0);
      expect(Object.keys(c.inputs).length).toBeGreaterThan(0);
    }
  });

  it('leave pressure reduces the index and is visible in inputs', () => {
    const base = all('NORMAL', 10);
    const r = teamHealthIndex({ ...base, approvedLeaveMemberCount: 5 });
    const leave = r.components.find((c) => c.key === 'leave_pressure')!;
    expect(leave.score).toBe(100 - 60);
    expect(leave.inputs.approved_leave_members).toBe(5);
    expect(r.index).toBeLessThan(100);
  });

  it('rest problems drag the composite below HEALTHY', () => {
    const base = all('NORMAL', 10);
    const r = teamHealthIndex({
      ...base,
      minGaps: Array.from({ length: 10 }, (_, i) => (i < 4 ? 5 : 9)),
      lateNightCounts: Array.from({ length: 10 }, (_, i) => (i < 4 ? 3 : 0)),
    });
    const rest = r.components.find((c) => c.key === 'rest')!;
    expect(rest.score).toBe(20);
    expect(r.band).not.toBe('HEALTHY');
  });

  it('an empty group never divides by zero', () => {
    const r = teamHealthIndex({ memberCount: 0, states: [], lateNightCounts: [], minGaps: [], workDays: [], approvedLeaveMemberCount: 0 });
    expect(r.components.every((c) => c.score >= 0 && c.score <= 100)).toBe(true);
  });
});

describe('policyState', () => {
  it('maps the defensible score matrix', () => {
    expect(policyState(0)).toBe('NORMAL');
    expect(policyState(1)).toBe('WATCH');
    expect(policyState(2)).toBe('ELEVATED');
    expect(policyState(3)).toBe('HIGH');
    expect(policyState(4)).toBe('CRITICAL');
    expect(policyState(6)).toBe('CRITICAL');
  });

  it('documents every rule in the policy table', () => {
    expect(POLICY_RULES.map((r) => r.id)).toEqual([
      'late_night_major', 'streak_major', 'late_night_minor', 'streak_minor', 'short_rest', 'high_workdays',
    ]);
  });
});

describe('computeWorkloadSignals', () => {
  it('flags repeated late-night work; with a 6-day streak it reaches CRITICAL', () => {
    const events = [
      ev('CLOCK_IN', day(10, 6, 0)), ev('CLOCK_OUT', day(10, 15, 0)),
      ev('CLOCK_IN', day(11, 6, 0)), ev('CLOCK_OUT', day(11, 15, 0)),
      ev('CLOCK_IN', day(12, 23, 0)), ev('CLOCK_OUT', day(13, 0, 30)),
      ev('CLOCK_IN', day(14, 22, 30)), ev('CLOCK_OUT', day(15, 0, 45)),
    ];
    const r = computeWorkloadSignals(events);
    expect(r.lateNight).toBeGreaterThanOrEqual(3);
    expect(r.score).toBeGreaterThanOrEqual(4);
    expect(r.state).toBe('CRITICAL');
    expect(r.signals.some((s) => s.code === 'late_night' && s.severity === 'HIGH')).toBe(true);
    expect(r.triggered_rules).toContain('late_night_major');
  });

  it('a single late-night event with a normal schedule is WATCH', () => {
    const events = [
      ev('CLOCK_IN', day(10, 8, 0)), ev('CLOCK_OUT', day(10, 17, 0)),
      ev('CLOCK_IN', day(11, 8, 0)), ev('CLOCK_OUT', day(11, 23, 0)),
    ];
    const r = computeWorkloadSignals(events);
    expect(r.state).toBe('WATCH');
    expect(r.triggered_rules).toEqual(['late_night_minor']);
  });

  it('flags long consecutive streaks as ELEVATED state', () => {
    const events: { person_id: string; event_type: string; occurred_at: string }[] = [];
    for (let d = 1; d <= 8; d++) {
      events.push(ev('CLOCK_IN', day(d, 8, 0)), ev('CLOCK_OUT', day(d, 17, 0)));
    }
    const r = computeWorkloadSignals(events);
    expect(r.maxStreak).toBe(8);
    expect(r.score).toBe(2);
    expect(r.state).toBe('ELEVATED');
    expect(r.signals.some((s) => s.code === 'long_streak')).toBe(true);
  });

  it('flags short rest between days; crossing midnight it also triggers late-night', () => {
    const events = [
      ev('CLOCK_IN', day(10, 6, 0)), ev('CLOCK_OUT', day(10, 23, 30)),
      ev('CLOCK_IN', day(11, 4, 0)), ev('CLOCK_OUT', day(11, 12, 0)),
    ];
    const r = computeWorkloadSignals(events);
    expect(r.minGap).toBeLessThan(7);
    expect(r.signals.some((s) => s.code === 'short_rest' && s.severity === 'MEDIUM')).toBe(true);
    expect(r.triggered_rules).toContain('short_rest');
    expect(r.triggered_rules).toContain('late_night_minor');
    expect(r.state).toBe('ELEVATED');
  });

  it('reaches CRITICAL when major signals combine', () => {
    const events: { person_id: string; event_type: string; occurred_at: string }[] = [];
    for (let d = 1; d <= 8; d++) {
      events.push(ev('CLOCK_IN', day(d, 23, 0)), ev('CLOCK_OUT', day(d + 1, 0, 30)));
    }
    const r = computeWorkloadSignals(events);
    expect(r.score).toBeGreaterThanOrEqual(4);
    expect(r.state).toBe('CRITICAL');
  });

  it('reports NORMAL for a regular schedule', () => {
    const events = [
      ev('CLOCK_IN', day(10, 8, 0)), ev('CLOCK_OUT', day(10, 17, 0)),
      ev('CLOCK_IN', day(11, 8, 0)), ev('CLOCK_OUT', day(11, 17, 0)),
    ];
    const r = computeWorkloadSignals(events);
    expect(r.state).toBe('NORMAL');
    expect(r.score).toBe(0);
    expect(r.signals[0].code).toBe('balanced');
  });
});

describe('timezone of the late-night window', () => {
  // 18:30 UTC is midnight in Asia/Kolkata. The same instant is late-night work
  // in one zone and an ordinary evening in the other, so the zone the report is
  // computed in changes what it says about a person.
  const instant = new Date(Date.UTC(2026, 7, 10, 18, 30)).toISOString();

  it('counts the event as late-night in the organization timezone', () => {
    const r = computeWorkloadSignals([ev('CLOCK_IN', instant)], { timeZone: 'Asia/Kolkata' });
    expect(r.lateNight).toBe(1);
    expect(r.triggered_rules).toContain('late_night_minor');
    expect(r.basis.timezone).toBe('Asia/Kolkata');
  });

  it('does not count the same event as late-night in UTC', () => {
    const r = computeWorkloadSignals([ev('CLOCK_IN', instant)], { timeZone: 'UTC' });
    expect(r.lateNight).toBe(0);
    expect(r.state).toBe('NORMAL');
  });

  it('survives an unusable configured timezone and says so', () => {
    const r = computeWorkloadSignals([ev('CLOCK_IN', instant)], { timeZone: 'Not/AZone' });
    expect(r.basis.timezone).toContain('unrecognised');
  });
});

describe('derived indicators are labelled honestly', () => {
  it('every workload report carries its basis and a disclaimer', () => {
    const r = computeWorkloadSignals([]);
    expect(r.basis.is_derived_indicator).toBe(true);
    expect(r.basis.window_days).toBe(30);
    expect(r.basis.derived_from).toContain('attendance_events');
    expect(r.basis.disclaimer).toMatch(/not a medical, wellbeing or performance assessment/);
  });

  it('the team health band explains that it describes the index, not people', () => {
    const r = teamHealthIndex(all('CRITICAL', 10));
    // Worth knowing: with rest, attendance and leave all clean, a group in which
    // EVERY member is CRITICAL still scores 60 / STABLE. That is exactly why the
    // basis travels with the number instead of the band standing alone.
    expect(r.index).toBe(60);
    expect(r.band).toBe('STABLE');
    expect(r.basis.band_meaning).toContain('not a condition of any person');
    expect(r.basis.disclaimer).toContain('no leave type, reason or medical detail');
  });
});