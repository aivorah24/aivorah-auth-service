// Standalone login microservice — extracted from ai-mentor/server/routes/user.js.
// Serves the same /user/sync endpoint the app already calls, on its own port.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoute = require('./routes/auth');
const supabase = require('./services/supabase');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/user', authRoute);

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

app.get('/health', (req, res) => res.json({ ok: true, service: 'aivorah-auth-service' }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`[aivorah-auth-service] listening on port ${PORT}`));
