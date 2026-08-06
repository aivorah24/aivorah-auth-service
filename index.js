// Standalone login microservice — extracted from ai-mentor/server/routes/user.js.
// Serves the same /user/sync endpoint the app already calls, on its own port.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoute = require('./routes/auth');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/user', authRoute);

app.get('/health', (req, res) => res.json({ ok: true, service: 'aivorah-auth-service' }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`[aivorah-auth-service] listening on port ${PORT}`));
