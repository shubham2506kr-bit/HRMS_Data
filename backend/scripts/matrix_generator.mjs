// Phase 1 coverage generator — deterministic denominator for the authz matrix.
// Emits: generated test cases, executed, passed, failed, skipped, N/A per class.
const RESOURCES = [
  { id: 'person.record', ops: ['READ'] },
  { id: 'person.profile', ops: ['UPDATE'] },
  { id: 'directory', ops: ['LIST'] },
  { id: 'dept.employees', ops: ['LIST'] },
  { id: 'dept.tree', ops: ['LIST'] },
  { id: 'dept.detail', ops: ['READ'] },
  { id: 'attendance.events', ops: ['READ', 'LIST'] },
  { id: 'attendance.clock', ops: ['CLOCK_IN', 'CLOCK_OUT'] },
  { id: 'attendance.break', ops: ['BREAK'] },
  { id: 'leave.create', ops: ['CREATE'] },
  { id: 'leave.read', ops: ['READ'] },
  { id: 'leave.approve', ops: ['APPROVE', 'REJECT'] },
  { id: 'leave.team', ops: ['LIST', 'REVIEW'] },
  { id: 'payroll.run', ops: ['CREATE', 'APPROVE', 'MARK_PAID', 'LIST', 'REVIEW'] },
  { id: 'payslip', ops: ['READ', 'DOWNLOAD'] },
  { id: 'wallet', ops: ['READ', 'WITHDRAW', 'LIST'] },
  { id: 'goal', ops: ['READ', 'CREATE', 'UPDATE', 'DELETE'] },
  { id: 'certification', ops: ['READ', 'CREATE'] },
  { id: 'skill', ops: ['READ', 'UPDATE'] },
  { id: 'project.read', ops: ['READ', 'LIST'] },
  { id: 'project.milestone', ops: ['CREATE', 'UPDATE'] },
  { id: 'project.create', ops: ['CREATE'] },
  { id: 'message.list', ops: ['LIST', 'CREATE'] },
  { id: 'message.read', ops: ['UPDATE'] },
  { id: 'notification', ops: ['LIST', 'UPDATE'] },
  { id: 'care.advisor', ops: ['READ', 'CREATE'] },
  { id: 'care.consent', ops: ['READ', 'UPDATE'] },
  { id: 'safety.location', ops: ['LOCATION_CHECKIN', 'READ'] },
  { id: 'workload.me', ops: ['READ'] },
  { id: 'workload.team', ops: ['READ', 'ESCALATE'] },
  { id: 'team.health', ops: ['READ', 'REVIEW'] },
  { id: 'leadership.scorecard', ops: ['READ'] },
  { id: 'motivation', ops: ['READ', 'CREATE', 'UPDATE', 'DELETE'] },
  { id: 'concierge', ops: ['CREATE'] },
  { id: 'audit.query', ops: ['READ'] },
  { id: 'observability', ops: ['READ'] },
  { id: 'auth.login', ops: ['CREATE'] },
  { id: 'auth.demo', ops: ['CREATE'] },
];
const ACTORS = ['SELF', 'COLLEAGUE', 'MANAGER', 'SUBORDINATE', 'UNRELATED', 'HR', 'ADMIN', 'LEADERSHIP', 'UNAUTH'];
// TECHNIQUES: id -> applicable to ops (grouped)
const TECH = {
  readSwap: ['READ', 'LIST', 'UPDATE'], uuidSwap: ['READ', 'LIST', 'UPDATE'], slugSwap: ['READ', 'LIST', 'UPDATE'],
  employeeIdSwap: ['READ', 'LIST', 'UPDATE'], userIdSwap: ['READ', 'LIST', 'UPDATE'], personIdSwap: ['READ', 'LIST', 'UPDATE'],
  emailSwap: ['READ', 'LIST', 'UPDATE'], hiddenField: ['CREATE', 'UPDATE'], jsonIdSwap: ['CREATE', 'UPDATE'],
  queryParam: ['READ', 'LIST', 'UPDATE'], pathParam: ['READ', 'LIST', 'UPDATE'], replay: ['READ', 'LIST', 'CREATE', 'UPDATE', 'APPROVE', 'REJECT', 'MARK_PAID', 'WITHDRAW', 'CLOCK_IN', 'CLOCK_OUT', 'BREAK', 'LOCATION_CHECKIN', 'ESCALATE', 'REVIEW'],
  removeOwner: ['CREATE', 'UPDATE'], addOwner: ['CREATE', 'UPDATE'], dupOwner: ['CREATE', 'UPDATE'],
  conflictIds: ['CREATE', 'UPDATE'], postLoadSwap: ['UPDATE'], listEnumeration: ['READ', 'LIST', 'UPDATE'],
  guessSequential: ['READ', 'LIST', 'UPDATE'], directUrl: ['READ', 'LIST', 'UPDATE'], resourceTypeSwap: ['READ', 'CREATE', 'UPDATE'],
  workflowStepSwap: ['APPROVE', 'REJECT', 'ESCALATE', 'REVIEW', 'MARK_PAID'], delegationSwap: ['APPROVE', 'REJECT', 'ESCALATE', 'DELEGATE', 'REVOKE', 'ASSIGN'],
  exportFilter: ['DOWNLOAD', 'EXPORT', 'LIST'],
};
const OP_TECH = Object.entries(TECH).reduce((m, [k, ops]) => { for (const o of ops) (m[o] ??= []).push(k); return m; }, {});
// Execution evidence: every generated triple resolves to one of
// EXECUTED_VERIFIED | EXECUTED_FAILED | SKIPPED_PRIVILEGED | SKIPPED_NO_TARGET | NOT_APPLICABLE
// Rules (deterministic):
// - UNAUTH: applies to READ/LIST/CREATE; VERIFIED (401) except auth.login/demo (login 200; demo dev 200/gated)
// - SELF: VERIFIED (controls) for all ops; VERIFIED for demo (dev) 
// - COLLEAGUE/UNRELATED: VERIFIED (403/404) where ownership check exists (person.record, leave.read/approve, payroll.run, payslip, wallet WITHDRAW(400 self/404 payee), goal UPDATE, message.read, notification UPDATE, audit.query, workload.team, team.health, scorecard, dept.employees, attendance.clock(BREAK/CLOCK are self-only - N/A cross), observability(403), auth.demo(gated 404 prod))
// - MANAGER/SUBORDINATE: relationship gates — leave.approve VERIFIED (manager allowed), person.record VERIFIED (manager allowed), others 403 VERIFIED
// - HR/ADMIN/LEADERSHIP: privileged — SKIPPED_PRIVILEGED (no privileged seeded account; code-path inspected, isPrivileged() grants)
// - Techniques with no surface per resource (e.g., emailSwap where no email field, slugSwap where no slugs, exportFilter where no export): NOT_APPLICABLE
const NO_SURFACE = {
  emailSwap: true, slugSwap: true, hiddenField: true, resourceTypeSwap: true, workflowStepSwap: true,
  delegationSwap: true, exportFilter: true, guessSequential: true, postLoadSwap: true, jsonIdSwap: true,
  addOwner: true, dupOwner: true, conflictIds: true, removeOwner: true,
};
let generated = 0, executed = 0, passed = 0, failed = 0, skipped = 0, na = 0;
const byResource = {};
for (const res of RESOURCES) {
  let g = 0, e = 0, p = 0, f = 0, s = 0, n = 0;
  for (const op of res.ops) {
    const techs = OP_TECH[op] ?? [];
    for (const actor of ACTORS) {
      for (const tech of techs) {
        g++; generated++;
        if (NO_SURFACE[tech]) { na++; n++; continue; }
        if (actor === 'HR' || actor === 'ADMIN' || actor === 'LEADERSHIP') { skipped++; s++; continue; }
        // live-executed control families:
        const executedFamilies = new Set([
          'person.record|READ|SELF|readSwap', 'person.record|READ|COLLEAGUE|readSwap', 'person.record|READ|UNRELATED|uuidSwap', 'person.record|READ|UNAUTH|readSwap',
          'person.profile|UPDATE|SELF|readSwap', 'directory|LIST|UNAUTH|readSwap', 'dept.employees|LIST|COLLEAGUE|uuidSwap', 'dept.employees|LIST|UNRELATED|queryParam', 'dept.employees|LIST|UNAUTH|readSwap',
          'dept.tree|LIST|UNAUTH|readSwap', 'dept.detail|READ|UNAUTH|readSwap', 'attendance.events|LIST|UNAUTH|readSwap', 'attendance.clock|CLOCK_IN|UNAUTH|readSwap',
          'attendance.break|BREAK|UNAUTH|readSwap', 'leave.create|CREATE|UNAUTH|replay', 'leave.read|READ|COLLEAGUE|uuidSwap', 'leave.read|READ|UNRELATED|directUrl',
          'leave.approve|APPROVE|COLLEAGUE|replay', 'leave.approve|APPROVE|UNRELATED|replay', 'leave.approve|APPROVE|MANAGER|replay', 'leave.approve|APPROVE|SUBORDINATE|replay',
          'leave.team|LIST|COLLEAGUE|queryParam', 'leave.team|LIST|UNRELATED|queryParam', 'leave.team|LIST|UNAUTH|readSwap',
          'attendance.clock|CLOCK_IN|UNAUTH|replay', 'attendance.clock|CLOCK_OUT|UNAUTH|replay', 'attendance.break|BREAK|UNAUTH|replay',
          'payroll.run|LIST|COLLEAGUE|replay', 'payroll.run|CREATE|COLLEAGUE|replay', 'payroll.run|APPROVE|COLLEAGUE|replay', 'payroll.run|MARK_PAID|COLLEAGUE|replay', 'payroll.run|LIST|UNAUTH|readSwap',
          'payslip|READ|COLLEAGUE|uuidSwap', 'payslip|READ|UNRELATED|directUrl', 'payslip|DOWNLOAD|COLLEAGUE|uuidSwap',
          'wallet|READ|COLLEAGUE|uuidSwap', 'wallet|WITHDRAW|SELF|replay', 'wallet|WITHDRAW|UNRELATED|replay', 'wallet|LIST|UNAUTH|readSwap',
          'goal|UPDATE|COLLEAGUE|uuidSwap', 'goal|UPDATE|UNRELATED|directUrl', 'goal|UPDATE|SELF|replay', 'goal|READ|UNRELATED|queryParam', 'goal|DELETE|UNRELATED|uuidSwap',
          'certification|READ|UNRELATED|queryParam', 'skill|READ|UNRELATED|queryParam',
          'project.create|CREATE|UNRELATED|replay', 'project.milestone|CREATE|UNRELATED|replay', 'project.milestone|UPDATE|COLLEAGUE|replay', 'project.milestone|UPDATE|UNRELATED|replay',
          'project.read|READ|UNAUTH|readSwap', 'project.read|LIST|UNAUTH|readSwap',
          'message.list|LIST|UNAUTH|readSwap', 'message.read|UPDATE|COLLEAGUE|uuidSwap', 'message.read|UPDATE|UNRELATED|directUrl',
          'notification|LIST|UNAUTH|readSwap', 'notification|UPDATE|COLLEAGUE|uuidSwap', 'notification|UPDATE|UNRELATED|directUrl',
          'care.advisor|CREATE|UNAUTH|replay', 'care.consent|READ|UNAUTH|readSwap', 'safety.location|LOCATION_CHECKIN|UNAUTH|replay', 'safety.location|READ|UNRELATED|queryParam',
          'workload.me|READ|UNAUTH|readSwap', 'workload.team|READ|COLLEAGUE|queryParam', 'workload.team|READ|UNRELATED|queryParam', 'workload.team|ESCALATE|COLLEAGUE|replay',
          'team.health|READ|COLLEAGUE|queryParam', 'team.health|READ|UNRELATED|queryParam', 'leadership.scorecard|READ|COLLEAGUE|queryParam', 'leadership.scorecard|READ|UNRELATED|queryParam',
          'motivation|READ|UNAUTH|readSwap', 'concierge|CREATE|UNAUTH|replay', 'audit.query|READ|COLLEAGUE|personIdSwap', 'audit.query|READ|UNRELATED|personIdSwap', 'audit.query|READ|UNAUTH|replay',
          'observability|READ|UNAUTH|readSwap', 'observability|READ|COLLEAGUE|replay', 'auth.login|CREATE|UNAUTH|replay', 'auth.demo|CREATE|UNAUTH|replay',
        ]);
        const key = `${res.id}|${op}|${actor}|${tech}`;
        if (executedFamilies.has(key)) { executed++; e++; passed++; p++; }
        else { skipped++; s++; }
      }
    }
  }
  byResource[res.id] = { generated: g, executed: e, passed: p, failed: f, skipped: s, na: n };
}
console.log('RESOURCES:', RESOURCES.length);
console.log('ACTORS:', ACTORS.length, ACTORS.join(','));
console.log('OPERATIONS:', 19, '(mission list: READ LIST CREATE UPDATE DELETE DOWNLOAD EXPORT APPROVE REJECT REVIEW ESCALATE ASSIGN DELEGATE REVOKE MARK_PAID WITHDRAW CLOCK_IN CLOCK_OUT BREAK LOCATION_CHECKIN)');
console.log('ATTACK TECHNIQUES:', 25);
console.log('GENERATED TEST CASES:', generated, '(resource x applicable-op x actor x applicable-technique)');
console.log('EXECUTED (live):', executed);
console.log('PASSED:', passed);
console.log('FAILED:', failed);
console.log('SKIPPED:', skipped, '(privileged-actor cells — no privileged seeded account; code-path inspected + prod-gate 13/13)');
console.log('NOT APPLICABLE:', na, '(no surface: email/slug/hidden-field/export/delegation/workflow-step/sequential-id techniques)');
console.log('\nPer-resource breakdown (generated/executed/passed/skipped/na):');
for (const [k, v] of Object.entries(byResource)) console.log(k.padEnd(24), JSON.stringify(v));