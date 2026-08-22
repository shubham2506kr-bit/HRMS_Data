import type { PolicyState } from './signals.js';

export type IndexBand = 'HEALTHY' | 'STABLE' | 'STRAINED' | 'STRESSED';

export interface TeamHealthComponent {
  key: 'workload_balance' | 'rest' | 'attendance' | 'leave_pressure';
  label: string;
  score: number;
  weight: number;
  inputs: Record<string, number>;
  formula: string;
}

export interface TeamHealthInput {
  memberCount: number;
  states: PolicyState[];
  lateNightCounts: number[];
  minGaps: (number | null)[];
  workDays: number[];
  approvedLeaveMemberCount: number;
}

/**
 * The band is a threshold on a weighted average of attendance-derived
 * components. It describes the index, not the people: a "STRESSED" band means
 * the computed number fell below 40, not that anyone is unwell. This basis is
 * returned alongside the number so no caller can present the label as a fact.
 */
export interface TeamHealthBasis {
  is_derived_indicator: true;
  band_thresholds: string;
  band_meaning: string;
  derived_from: string;
  disclaimer: string;
}

const BASIS: TeamHealthBasis = {
  is_derived_indicator: true,
  band_thresholds: 'HEALTHY >= 80, STABLE >= 60, STRAINED >= 40, otherwise STRESSED',
  band_meaning: 'A band names the value of the index, not a condition of any person in the group.',
  derived_from:
    'attendance clock events and the count of members with approved leave overlapping the window',
  disclaimer:
    'No medical, wellbeing or performance data is used. Leave is counted only as a number of members; ' +
    'no leave type, reason or medical detail is read or exposed.',
};

const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 100);

export function teamHealthIndex(input: TeamHealthInput): {
  index: number;
  band: IndexBand;
  components: TeamHealthComponent[];
  basis: TeamHealthBasis;
} {
  const { memberCount, states, lateNightCounts, minGaps, workDays, approvedLeaveMemberCount } = input;

  const healthyWorkload = states.filter((s) => s === 'NORMAL' || s === 'WATCH').length;
  const workloadBalance = pct(healthyWorkload, memberCount);

  const shortRest = minGaps.filter((g) => g != null && g < 7).length;
  const lateNightUsers = lateNightCounts.filter((n) => n > 0).length;
  const restHealthy = memberCount - shortRest - lateNightUsers;
  const rest = pct(Math.max(0, restHealthy), memberCount);

  const activeMembers = workDays.filter((w) => w > 0).length;
  const attendance = pct(activeMembers, memberCount);

  const leaveShare = pct(approvedLeaveMemberCount, memberCount);
  const leavePressure = Math.max(0, 100 - Math.min(60, leaveShare * 2));

  const components: TeamHealthComponent[] = [
    {
      key: 'workload_balance',
      label: 'Workload balance',
      score: workloadBalance,
      weight: 40,
      inputs: { healthy: healthyWorkload, members: memberCount },
      formula: 'share of members in NORMAL or WATCH policy state',
    },
    {
      key: 'rest',
      label: 'Rest & recovery',
      score: rest,
      weight: 30,
      inputs: { short_rest: shortRest, late_night_users: lateNightUsers, members: memberCount },
      formula: 'members with neither short rest gaps nor late-night clock events, as a share of the group',
    },
    {
      key: 'attendance',
      label: 'Attendance coverage',
      score: attendance,
      weight: 15,
      inputs: { active_members: activeMembers, members: memberCount },
      formula: 'members with recorded activity in the window, as a share of the group',
    },
    {
      key: 'leave_pressure',
      label: 'Leave pressure',
      score: leavePressure,
      weight: 15,
      inputs: { approved_leave_members: approvedLeaveMemberCount, members: memberCount },
      formula: '100 minus (approved-leave share × 2), capped at −60',
    },
  ];

  const index = Math.round(components.reduce((sum, c) => sum + c.score * (c.weight / 100), 0));
  const band: IndexBand = index >= 80 ? 'HEALTHY' : index >= 60 ? 'STABLE' : index >= 40 ? 'STRAINED' : 'STRESSED';

  return { index, band, components, basis: BASIS };
}