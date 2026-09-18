// Standalone login microservice — extracted from ai-mentor/server/routes/user.js.
// Serves the same /user/sync endpoint the app already calls, on its own port.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoute = require('./routes/auth');
const accountRoute = require('./routes/account');
const supabase = require('./services/supabase');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/user', authRoute);
app.use('/user', accountRoute);

// Resolves the short verification link (/v/:code) emailed to users back to
// the full /user/verify/:token?... URL stored at send-verification time.
app.get('/v/:code', async (req, res) => {
  const { code } = req.params;
  const { data: link } = await supabase
    .from('short_links')
    .select('url, expires_at')
    .eq('code', code)
    .maybeSingle();

  if (!link || (link.expires_at && new Date(link.expires_at) < new Date())) {
    return res.status(404).send('This verification link is invalid or has expired.');
  }

  res.redirect(link.url);
});

// Serves the real NCERT textbook PDFs for the "View in Book" reading pane.
// This route originally pointed at a Supabase Storage bucket "ncert-books"
// that was never actually created in ANY Supabase project (Dev or Test) —
// every request 404'd from day one, in every environment. The real files
// (1387 of them, path mirrors grade<N>/<subject>/<code>.pdf) were instead
// uploaded to Cloudinary as public `raw` resources under `ncert_books/`, so
// this just redirects there directly — no signed URL needed, they're public.
const NCERT_CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'di5iq2mmb';
app.get('/data/ncert_books/*', (req, res) => {
  const key = req.path.replace(/^\/data\/ncert_books\//, '');
  const url = `https://res.cloudinary.com/${NCERT_CLOUDINARY_CLOUD_NAME}/raw/upload/ncert_books/${key}`;
  return res.redirect(302, url);
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'aivorah-auth-service' }));

const PORT = process.env.PORT || 4001;
// Only start listening when run directly (`node index.js`) — not when
// required by tests, so Supertest can exercise `app` in-memory.
if (require.main === module) {
  app.listen(PORT, () => console.log(`[aivorah-auth-service] listening on port ${PORT}`));
}

module.exports = app;
