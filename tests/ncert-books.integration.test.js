// Regression test for the "Real Book not coming up" bug: this route used to
// point at a Supabase Storage bucket ("ncert-books") that was never created
// in any environment, so it always 404'd. Fixed to redirect straight to the
// public Cloudinary `raw` upload where the files actually live.

jest.mock('../services/supabase', () => ({
  auth: { admin: { listUsers: jest.fn(), updateUserById: jest.fn() } },
  from: jest.fn(() => ({
    select: () => ({ eq: () => ({ maybeSingle: jest.fn() }) }),
  })),
}));

const request = require('supertest');
const app = require('../index');

describe('GET /data/ncert_books/*', () => {
  test('redirects to the public Cloudinary raw URL for the requested book path', async () => {
    const res = await request(app).get('/data/ncert_books/grade9/social_science/iest109.pdf');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'https://res.cloudinary.com/di5iq2mmb/raw/upload/ncert_books/grade9/social_science/iest109.pdf'
    );
  });
});
