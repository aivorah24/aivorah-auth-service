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
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
