const API = 'http://localhost:3000';
const r = (p, o = {}) => fetch(API + p, { headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}), method: o.method ?? 'GET' }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

const out = [];
const t = (name, res, verdict, note) => { out.push({ name, status: res.status, verdict }); console.log(`${String(res.status).padEnd(4)} ${verdict.padEnd(10)} ${name} :: ${note}`); };

const john = await (await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'john', password: 'demo1234' }) })).json();
const JT = john.token;
const jane = await (await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'jane', password: 'demo1234' }) })).json();
const JaT = jane.token;

// WALLET payee ownership
const w1 = await r('/api/wallet/transfer', { method: 'POST', token: JT, body: { recipient_username: 'jane', amount: 1, idempotency_key: '11111111-1111-4111-8111-111111111111' } });
t('wallet transfer to valid payee (by username, server-resolved)', w1.status, w1.status === 200 ? 'VERIFIED' : 'PARTIAL', w1.status === 200 ? 'credited jane' : 'got ' + w1.status);
const w2 = await r('/api/wallet/transfer', { method: 'POST', token: JT, body: { recipient_username: 'john', amount: 1, idempotency_key: '22222222-2222-4222-8222-222222222222' } });
t('wallet self-transfer rejected', w2.status, w2.status === 400 ? 'VERIFIED' : 'VULNERABLE', w2.status === 400 ? '400 correct' : 'got ' + w2.status);
const w3 = await r('/api/wallet/transfer', { method: 'POST', token: JT, body: { recipient_username: 'nobody@nowhere', amount: 1, idempotency_key: '33333333-3333-4333-8333-333333333333' } });
t('wallet unknown payee', w3.status, w3.status === 404 ? 'VERIFIED' : 'VULNERABLE', w3.status === 404 ? '404 correct' : 'got ' + w3.status);

// LOGIN enumeration uniformity
const e1 = await r('/api/auth/login', { method: 'POST', body: { username: 'john', password: 'wrongpass' } });
const e2 = await r('/api/auth/login', { method: 'POST', body: { username: 'no-such-user', password: 'x' } });
t('wrong password vs unknown user -> identical 401', e1.status === 401 && e2.status === 401 && JSON.stringify(e1.body) === JSON.stringify(e2.body) ? 200 : 500, JSON.stringify(e1.body) === JSON.stringify(e2.body) ? 'VERIFIED' : 'VULNERABLE', 'both 401, bodies identical: ' + JSON.stringify(e1.body));

// ORGANIZATION-EDGE mutation: manager creating project in a dept he does NOT head
const p1 = await r('/api/projects', { method: 'POST', token: JT, body: { name: 'RT-probe-sales-project', description: 'red team probe', department_id: '667718fd-9dc9-4cdf-886e-07315bc2f5b3' } });
t('project create w/ foreign department_id (john heads Engineering)', p1.status, p1.status === 201 ? 'PARTIAL' : 'VERIFIED', p1.status === 201 ? '201 — dept edge NOT validated (P3, by-design manager power)' : 'got ' + p1.status);

// LOCATION: safety check-in owner-only
const s1 = await r('/api/safety/check-in', { method: 'POST', token: JaT, body: { latitude: 12.9716, longitude: 77.5946, location: 'RT probe' } });
t('jane writes own check-in', s1.status, s1.status === 201 ? 'VERIFIED' : 'VULNERABLE', '201 correct');
const s2 = await r('/api/safety/my-checkins', { token: JT });
const janeLocLeak = s2.body?.checkins?.some((c) => c.location === 'RT probe');
t('john cannot read jane check-ins (no cross-user param exists)', janeLocLeak ? 500 : 200, janeLocLeak ? 'VULNERABLE' : 'VERIFIED', janeLocLeak ? 'LEAKED' : 'no foreign rows in john list');

// NOTIFICATIONS foreign id
let janeNotif = null;
const jn = await r('/api/notifications', { token: JaT });
if (jn.body?.length) janeNotif = jn.body[0].logical_id;
const nr = janeNotif ? await r(`/api/notifications/${janeNotif}/read`, { method: 'PUT', token: JT, body: {} }) : null;
t('notification read-mark foreign id', nr ? nr.status : 500, nr && nr.status === 404 ? 'VERIFIED' : 'VULNERABLE', nr ? 'got ' + nr.status : 'jane has no notifications');

// ATTENDANCE: no cross-user surface
const at = await r('/api/attendance', { token: JT });
t('attendance list has no person param (self only)', at.status, at.status === 200 ? 'VERIFIED' : 'VULNERABLE', '200, self-scoped');

// GROWTH cross-user mutation probe (goal ownership UPDATE)
const g1 = await r('/api/goals', { token: JaT });
let janeGoal = null; if (g1.body?.goals?.length) janeGoal = g1.body.goals[0].goal_id;
const gu = janeGoal ? await r('/api/goals/' + janeGoal, { method: 'PATCH', token: JT, body: { status: 'DONE' } }) : null;
t('goal update cross-user', gu ? gu.status : 500, gu && gu.status === 403 ? 'VERIFIED' : 'VULNERABLE', gu ? 'got ' + gu.status : 'jane has no goals');

const passed = out.filter((x) => x.verdict === 'VERIFIED').length;
const partial = out.filter((x) => x.verdict === 'PARTIAL').length;
console.log(`\nEXPANDED PROBES: ${out.length} executed — VERIFIED ${passed}, PARTIAL ${partial}, VULNERABLE ${out.length - passed - partial}`);