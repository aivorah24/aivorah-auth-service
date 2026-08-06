// Smoke test for the standalone service — proves it runs and answers
// correctly with ZERO dependency on the rest of the ai-mentor app.
//
// Run the service first (npm start), then: node tests/smoke.js
// Set BASE_URL and the 4 demo emails via env vars, or edit the defaults below.

const BASE_URL = process.env.BASE_URL || 'http://localhost:4001';

const DEMO_EMAILS = {
  student: process.env.DEMO_STUDENT_EMAIL || 'demo.student@aivorah.demo',
  teacher: process.env.DEMO_TEACHER_EMAIL || 'demo.teacher@aivorah.demo',
  parent:  process.env.DEMO_PARENT_EMAIL  || 'demo.parent@aivorah.demo',
};

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

async function main() {
  console.log(`Testing ${BASE_URL}\n`);

  console.log('GET /health');
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  check('responds ok:true', health.ok === true);

  console.log('\nPOST /user/sync with no email');
  const noEmailRes = await fetch(`${BASE_URL}/user/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('returns 400', noEmailRes.status === 400);

  for (const [role, email] of Object.entries(DEMO_EMAILS)) {
    console.log(`\nPOST /user/sync for ${role} (${email})`);
    const res = await fetch(`${BASE_URL}/user/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const body = await res.json();
    check('returns 200', res.status === 200);
    check(`role is "${role}"`, body.role === role);
    check('email matches', body.email === email);

    // GET /user/role is a plain read, safe to check here too.
    console.log(`GET /user/role for ${role} (${email})`);
    const roleRes = await fetch(`${BASE_URL}/user/role?email=${encodeURIComponent(email)}`);
    const roleBody = await roleRes.json();
    check('returns 200', roleRes.status === 200);
    check(`role is "${role}"`, roleBody.role === role);
  }

  // ── Signup flow: /user/send-verification and /user/verify/:token ──────────
  // These WRITE to the account (flip accountStatus, send a real email), so
  // they're run against a fresh DISPOSABLE email instead of the real demo
  // accounts above - same trick the Playwright signup specs in
  // aivorah-e2e-tests use, so it's safe to repeat on every run.
  const signupEmail = `smoke.test.${Date.now()}@aivorah.demo`;
  console.log(`\nSignup flow for a disposable account (${signupEmail})`);

  console.log('POST /user/sync (simulates account creation, like signup does)');
  const createRes = await fetch(`${BASE_URL}/user/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke Test User', email: signupEmail, role: 'student' }),
  });
  const createBody = await createRes.json();
  check('account created (200)', createRes.status === 200);
  check('role is "student"', createBody.role === 'student');

  console.log('POST /user/send-verification');
  const verifyRes = await fetch(`${BASE_URL}/user/send-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: signupEmail, name: 'Smoke Test User' }),
  });
  const verifyBody = await verifyRes.json();
  check('returns 200', verifyRes.status === 200);
  check('returns ok:true', verifyBody.ok === true);

  console.log('GET /user/verify/:token with a deliberately WRONG token (we can\'t read the real email)');
  const badTokenRes = await fetch(
    `${BASE_URL}/user/verify/wrong-token-123?email=${encodeURIComponent(signupEmail)}`,
    { redirect: 'manual' },
  );
  const location = badTokenRes.headers.get('location') || '';
  check('redirects (3xx)', badTokenRes.status >= 300 && badTokenRes.status < 400);
  check('redirect has error=1 (bad token correctly rejected)', location.includes('error=1'));

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
