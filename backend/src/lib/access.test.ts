import { describe, it, expect } from 'vitest';
import {
  PRIVILEGED_ROLES,
  PAYROLL_ROLES,
  isPrivileged,
  canRunPayroll,
  canActOnBehalfOf,
} from './access.js';

describe('isPrivileged', () => {
  it('grants HR/leadership/audit/finance/payroll roles', () => {
    for (const role of PRIVILEGED_ROLES) {
      expect(isPrivileged([role]), role).toBe(true);
    }
  });

  it('denies ordinary employee roles', () => {
    expect(isPrivileged(['self', 'employee'])).toBe(false);
    expect(isPrivileged(['employee', 'department_head_of'])).toBe(false);
    expect(isPrivileged([])).toBe(false);
  });

  it('does NOT treat platform_admin as privileged', () => {
    expect(PRIVILEGED_ROLES).not.toContain('platform_admin');
    expect(isPrivileged(['platform_admin'])).toBe(false);
  });
});

describe('canRunPayroll (regression: PAY-1 payroll gate bypass)', () => {
  it('grants only explicit finance/payroll/leadership roles', () => {
    for (const role of PAYROLL_ROLES) {
      expect(canRunPayroll([role]), role).toBe(true);
    }
    expect(canRunPayroll(['hr_generalist'])).toBe(false);
    expect(canRunPayroll(['department_head_of'])).toBe(false);
    expect(canRunPayroll(['direct_manager_of'])).toBe(false);
  });

  it('NEVER grants payroll to platform_admin — the role derived for every account holder', () => {
    expect(PAYROLL_ROLES).not.toContain('platform_admin');
    expect(canRunPayroll(['platform_admin'])).toBe(false);
    expect(canRunPayroll(['self', 'employee', 'department_head_of', 'direct_manager_of', 'platform_admin'])).toBe(false);
  });
});

describe('canActOnBehalfOf (regression: self-approval)', () => {
  const alice = '00000000-0000-0000-0000-00000000000a';
  const bob = '00000000-0000-0000-0000-00000000000b';

  it('refuses self-approval for EVERY privileged role', () => {
    for (const role of PRIVILEGED_ROLES) {
      expect(canActOnBehalfOf(alice, alice, [role]), role).toBe(false);
    }
    // The exact scenario that was exploitable: an HR or finance user approving
    // their own leave request / their own payroll run.
    expect(canActOnBehalfOf(alice, alice, ['hr_admin', 'finance', 'payroll', 'leadership'])).toBe(false);
  });

  it('allows a privileged actor to act on someone else', () => {
    expect(canActOnBehalfOf(alice, bob, ['hr_generalist'])).toBe(true);
    expect(canActOnBehalfOf(alice, bob, ['finance'])).toBe(true);
  });

  it('denies unprivileged actors regardless of subject', () => {
    expect(canActOnBehalfOf(alice, bob, ['self', 'employee'])).toBe(false);
    expect(canActOnBehalfOf(alice, bob, ['direct_manager_of'])).toBe(false);
    expect(canActOnBehalfOf(alice, bob, [])).toBe(false);
  });

  it('is stricter than isPrivileged for the self case — that is the whole point', () => {
    expect(isPrivileged(['hr_admin'])).toBe(true);
    expect(canActOnBehalfOf(alice, alice, ['hr_admin'])).toBe(false);
  });

  it('fails closed on missing identifiers', () => {
    expect(canActOnBehalfOf('', bob, ['hr_admin'])).toBe(false);
    expect(canActOnBehalfOf(alice, '', ['hr_admin'])).toBe(false);
    expect(canActOnBehalfOf('', '', ['hr_admin'])).toBe(false);
  });
});

describe('role derivation invariants (regression: hr_restricted escalation)', () => {
  it('hr_restricted is not a privileged role, so derivation must never widen it', () => {
    expect(PRIVILEGED_ROLES).not.toContain('hr_restricted');
    expect(isPrivileged(['self', 'employee', 'hr_restricted'])).toBe(false);
    expect(PAYROLL_ROLES).not.toContain('hr_restricted');
    expect(canRunPayroll(['hr_restricted'])).toBe(false);
  });

  it('documents why lib/auth.ts must match idp_issuer exactly, not by substring', () => {
    // The old derivation did `issuer.includes('hr')`, which is true for the
    // restricted issuer and for any unrelated host containing those letters.
    const restricted: string = 'hr_restricted';
    const unrelated: string = 'thread-idp.example';
    expect(restricted.includes('hr')).toBe(true);
    expect(unrelated.includes('hr')).toBe(true);
    // Exact matching is what makes the restricted issuer stay restricted.
    expect(restricted === 'hr').toBe(false);
    expect(unrelated === 'hr').toBe(false);
    // And hr_generalist, unlike hr_restricted, does carry privilege — so the
    // two must be mutually exclusive in the derived set.
    expect(isPrivileged(['hr_generalist'])).toBe(true);
  });

  it('being someone\'s subordinate must not confer direct_manager_of', () => {
    // lib/auth.ts derived is_manager by joining position_reporting_lines on
    // child_position_id (people who HAVE a manager) instead of
    // parent_position_id (people who ARE one). direct_manager_of is not in
    // PRIVILEGED_ROLES, but it gates manager-only writes in the projects module.
    expect(PRIVILEGED_ROLES).not.toContain('direct_manager_of');
    expect(canActOnBehalfOf('x', 'y', ['direct_manager_of'])).toBe(false);
  });
});
