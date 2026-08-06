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

  // NOTE: /user/send-verification and /user/verify/:token are NOT smoke-tested
  // here on purpose - they WRITE to the account (flip accountStatus to
  // pending_verification, send a real email) instead of just reading. Running
  // that against our real demo accounts on every test run would break their
  // "already verified" state. Covered instead by the Playwright signup specs
  // in aivorah-e2e-tests, which use disposable throwaway emails.

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
