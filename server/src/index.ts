import { config } from './config.js';
import { createApp } from './app.js';
import { run, nowIso } from './db/db.js';
import { sweepStaleReservations } from './lib/usage.js';

const app = await createApp();

// Reservations left behind by a crash or redeploy would otherwise count against students forever.
const swept = sweepStaleReservations(15);
if (swept) console.log(`Released ${swept} stale usage reservation(s) from a previous run.`);

// Housekeeping: expire sessions/tokens, release stale reservations, drop used codes.
setInterval(() => {
  run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
  run('DELETE FROM auth_tokens WHERE expires_at < ? OR used_at IS NOT NULL', new Date(Date.now() - 86400_000).toISOString());
  run('DELETE FROM login_codes WHERE expires_at < ?', new Date(Date.now() - 86400_000).toISOString());
  sweepStaleReservations(15);
}, 15 * 60_000).unref();

app.listen(config.port, () => {
  console.log(`SelfLatitude Companion API listening on :${config.port} (${config.isProd ? 'production' : 'development'})`);
  import('./lib/openai.js').then(({ platformKey }) => { if (!platformKey()) console.warn('No OpenAI key configured yet - add one in Administration > OpenAI connection (or set OPENAI_API_KEY).'); });
});
