const API = 'http://localhost:3000';
const r = (p, o = {}) => fetch(API + p, { headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}), method: o.method ?? 'GET' }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

const out = [];
const t = (name, status, verdict, note) => { out.push({ name, status, verdict, note }); console.log(`${status === 200 ? '200' : String(status).padEnd(3)} ${verdict.padEnd(14)} ${name} :: ${note}`); };

const john = await (await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'john', password: 'demo1234' }) })).json();
const JT = john.token;
console.log('JOHN ROLES:', JSON.stringify(john.user.roles));

const david = await r('/api/auth/demo', { method: 'POST', token: null, body: { username: 'david' } });
const DT = david.body.token;
console.log('DAVID ROLES (via /auth/demo, no password):', JSON.stringify(david.body.user?.roles));

const depts = await r('/api/departments', { token: JT });
const sales = depts.body.find((d) => /sales/i.test(d.name)) ?? depts.body[0];
const eng = depts.body.find((d) => /engineering/i.test(d.name));
console.log('DEPTS:', depts.body.map((d) => d.name).join(', '));

const salesEmps = await r(`/api/departments/${sales.logical_id}/employees`, { token: JT });
t('departments/:id/employees (cross-dept legal names)', salesEmps.status, salesEmps.status === 403 ? 'VERIFIED' : 'VULNERABLE', salesEmps.status === 403 ? '403 correct (PII withheld)' : `got ${salesEmps.status} ${JSON.stringify(salesEmps.body).slice(0, 80)}`);
const victimId = '00000000-0000-0000-0000-000000000007';

const victimPerson = await r(`/api/persons/${victimId}`, { token: JT });
t('persons/:id (any employee DOB)', victimPerson.status, victimPerson.status === 403 ? 'VERIFIED' : 'VULNERABLE', victimPerson.status === 403 ? '403 correct (DOB withheld)' : `got ${victimPerson.status} ${JSON.stringify(victimPerson.body).slice(0, 80)}`);

const payrollRuns = await r('/api/payroll/runs', { token: JT });
t('payroll/runs LIST (payroll gate)', payrollRuns.status, payrollRuns.status === 200 ? 'VULNERABLE' : 'VERIFIED', payrollRuns.status === 200 ? `john listed ${payrollRuns.body?.length} payroll runs with net totals` : 'blocked');

const runCreate = await r('/api/payroll/runs', { method: 'POST', token: JT, body: { period_start: '2027-01-01', period_end: '2027-01-31' } });
t('payroll/runs CREATE (payroll gate)', runCreate.status, runCreate.status === 201 ? 'VULNERABLE' : 'VERIFIED', runCreate.status === 201 ? `john created+computed run ${runCreate.body?.run_id} (${runCreate.body?.entries} entries)` : JSON.stringify(runCreate.body).slice(0, 80));

const obs = await r('/api/system/observability');
t('system/observability (NO AUTH)', obs.status, obs.status === 200 ? 'VULNERABLE' : 'VERIFIED', obs.status === 200 ? `anonymous read scheduler/events state, jobs=${JSON.stringify(obs.body?.scheduler_jobs?.length)}` : 'blocked');

const unauthPersons = await r('/api/persons');
t('unauth persons (control)', unauthPersons.status, unauthPersons.status === 401 ? 'VERIFIED' : 'VULNERABLE', '401 expected');

const unauthLeave = await r('/api/leave-requests', { method: 'POST', body: { leave_type: 'ANNUAL', start_date: '2027-05-01', end_date: '2027-05-02' } });
t('unauth leave create (control)', unauthLeave.status, unauthLeave.status === 401 ? 'VERIFIED' : 'VULNERABLE', '401 expected');

let dPayslipId = null;
const dPayslips = await r('/api/payroll/my-payslips', { token: DT });
if (dPayslips.body?.length) dPayslipId = dPayslips.body[0].payslip_id;
const payslipX = await r(`/api/payroll/payslips/${dPayslipId}`, { token: JT });
t('payslips/:id of colleague (ownership)', payslipX.status, payslipX.status === 403 ? 'VERIFIED' : 'VULNERABLE', payslipX.status === 403 ? '403 correct' : `got ${payslipX.status}`);

let dLeaveId = null;
const dLeave = await r('/api/leave-requests', { token: DT });
if (dLeave.body?.length) dLeaveId = dLeave.body[0].logical_id;
const leaveX = await r(`/api/leave-requests/${dLeaveId}`, { token: JT });
t('leave-requests/:id of colleague (read)', leaveX.status, leaveX.status === 403 ? 'VERIFIED' : 'VULNERABLE', leaveX.status === 403 ? '403 correct' : `got ${leaveX.status}`);

const leaveApprove = await r(`/api/leave-requests/${dLeaveId}/approve`, { method: 'PUT', token: JT, body: {} });
t('leave-requests/:id/approve cross-user', leaveApprove.status, leaveApprove.status === 403 ? 'VERIFIED' : 'VULNERABLE', leaveApprove.status === 403 ? '403 correct' : `got ${leaveApprove.status}`);

const wlTeam = await r(`/api/workload/team?department_id=${sales.logical_id}`, { token: JT });
t('workload/team foreign dept', wlTeam.status, wlTeam.status === 403 ? 'VERIFIED' : 'VULNERABLE', wlTeam.status === 403 ? '403 correct' : `got ${wlTeam.status}`);

const th = await r(`/api/team-health?department_id=${sales.logical_id}`, { token: JT });
t('team-health foreign dept', th.status, th.status === 403 ? 'VERIFIED' : 'VULNERABLE', th.status === 403 ? '403 correct' : `got ${th.status}`);

const sc = await r(`/api/leadership/scorecard?department_id=${sales.logical_id}`, { token: JT });
t('leadership/scorecard foreign dept', sc.status, sc.status === 403 ? 'VERIFIED' : 'VULNERABLE', sc.status === 403 ? '403 correct' : `got ${sc.status}`);

const auditX = await r('/api/audit/query', { method: 'POST', token: JT, body: { person_id: victimId } });
t('audit/query other person', auditX.status, auditX.status === 403 ? 'VERIFIED' : 'VULNERABLE', auditX.status === 403 ? '403 correct' : `got ${auditX.status}`);

const goalsX = await r('/api/goals?person_id=' + victimId, { token: JT });
t('goals?person_id=other (leak check)', 200, goalsX.body?.goals?.length === 0 ? 'VERIFIED' : 'VULNERABLE', `returned ${goalsX.body?.goals?.length} goals`);

let dMsgId = null;
const dMsgs = await r('/api/messages', { token: DT });
if (dMsgs.body?.length) dMsgId = dMsgs.body[0].logical_id;
const msgRead = await r(`/api/messages/${dMsgId}/read`, { method: 'PUT', token: JT, body: {} });
t('messages/:id/read of colleague inbox', msgRead.status, msgRead.status === 404 ? 'VERIFIED' : 'VULNERABLE', msgRead.status === 404 ? '404 correct' : `got ${msgRead.status}`);

const myAudit = await r('/api/audit/query', { method: 'POST', token: JT, body: { person_id: john.user.personId } });
t('audit/query self (control)', myAudit.status, myAudit.status === 200 ? 'VERIFIED' : 'VULNERABLE', myAudit.status === 200 ? '200 correct' : `got ${myAudit.status}`);

const wlMe = await r('/api/workload/me', { token: JT });
t('workload/me self (control)', wlMe.status, wlMe.status === 200 ? 'VERIFIED' : 'VULNERABLE', `state=${wlMe.body?.state}`);

const sched = await r('/api/motivation/settings', { token: JT });
t('motivation/settings self (control)', sched.status, sched.status === 200 ? 'VERIFIED' : 'VULNERABLE', '200 correct');

console.log('\n===== VERDICT SUMMARY =====');
const vuln = out.filter((x) => x.verdict === 'VULNERABLE');
console.log('VULNERABLE:', vuln.length, vuln.map((x) => x.name).join(' | '));
console.log('VERIFIED (controls hold):', out.filter((x) => x.verdict === 'VERIFIED').length);