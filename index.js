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
// Files live in the private Supabase Storage bucket "ncert-books" (path
// mirrors grade<N>/<subject>/<code>.pdf), uploaded by ai-mentor's
// scripts/upload-pdfs-to-supabase.js. This route was ported over from
// ai-mentor/server/index.js, whose equivalent route was never actually live
// on the deployed aivorah.ai backend — every request fell through to that
// app's SPA catch-all and returned index.html (200 OK), so the iframe
// silently rendered the landing page instead of a book page.
const NCERT_BOOKS_BUCKET = 'ncert-books';
app.get('/data/ncert_books/*', async (req, res) => {
  const key = req.path.replace(/^\/data\/ncert_books\//, '');
  try {
    const { data, error } = await supabase.storage
      .from(NCERT_BOOKS_BUCKET)
      .createSignedUrl(key, 600); // 10 min — plenty for one page view
    if (error || !data?.signedUrl) {
      return res.status(404).json({ error: 'Book page not found' });
    }
    return res.redirect(302, data.signedUrl);
  } catch (e) {
    return res.status(404).json({ error: 'Book page not found' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'aivorah-auth-service' }));

const PORT = process.env.PORT || 4001;
// Only start listening when run directly (`node index.js`) — not when
// required by tests, so Supertest can exercise `app` in-memory.
if (require.main === module) {
  app.listen(PORT, () => console.log(`[aivorah-auth-service] listening on port ${PORT}`));
}

module.exports = app;
