/**
 * Integration tests against the real Express app with an in-memory SQLite database.
 * Covers: login, access control, monthly usage limits, API-key secrecy, memory approval, deletion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { authenticator } from 'otplib';

process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@test.local';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'admin-pass-123456';

let server: Server;
let base: string;

class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data, text };
  }
}

beforeAll(async () => {
  const { createApp } = await import('./app.js');
  const app = await createApp();
  await new Promise<void>((r) => { server = app.listen(0, r); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server?.close());

describe('auth and access control', () => {
  it('refuses public sign-up until the owner turns it on', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/auth/register', { email: 'walkin@test.local', name: 'Walk In', password: 'walkin-pass-1' });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe('registration_closed');
    expect((await c.req('GET', '/api/auth/config')).data.allowSelfRegistration).toBe(false);
    // enable it for the remaining tests
    const { setSetting } = await import('./db/db.js');
    setSetting('auth', { allowSelfRegistration: true, selfRegistrationMonths: 0, requireEmailCodeForAll: false, requireMfaForAdmins: true, emailCodeMinutes: 10 });
    expect((await c.req('GET', '/api/auth/config')).data.allowSelfRegistration).toBe(true);
  });

  it('registers, signs in, and reports no companion access by default', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/auth/register', { email: 'stu@test.local', name: 'Stu', password: 'student-pass-1' });
    expect(r.status).toBe(200);
    expect(r.data.user.companionActive).toBe(false);
    const conv = await c.req('POST', '/api/conversations', {});
    expect(conv.status).toBe(403);
    expect(conv.data.code).toBe('forbidden');
  });

  it('rejects wrong passwords and unauthenticated access', async () => {
    const c = new Client();
    expect((await c.req('POST', '/api/auth/login', { email: 'stu@test.local', password: 'nope' })).status).toBe(401);
    expect((await c.req('GET', '/api/conversations')).status).toBe(401);
    expect((await c.req('GET', '/api/admin/companion')).status).toBe(401);
  });

  it('blocks students from admin routes and requires MFA for Super Admin routes', async () => {
    const s = new Client();
    await s.req('POST', '/api/auth/login', { email: 'stu@test.local', password: 'student-pass-1' });
    expect((await s.req('GET', '/api/admin/companion')).status).toBe(403);

    const a = new Client();
    const login = await a.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
    expect(login.status).toBe(200);
    // Owner-level route OK, Super Admin route locked until MFA
    expect((await a.req('GET', '/api/admin/companion')).status).toBe(200);
    const locked = await a.req('GET', '/api/admin/users');
    expect(locked.status).toBe(403);
    expect(locked.data.error).toMatch(/multifactor/i);
  });
});

/**
 * A fully signed-in Super Admin: password, then the second factor. Enrolls an
 * authenticator on the first call and verifies with it on later calls, because
 * re-enrolling from an unverified session is (correctly) refused.
 */
async function adminClient() {
  const { one } = await import('./db/db.js');
  const { decrypt } = await import('./lib/crypto.js');
  const a = new Client();
  const login = await a.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
  expect(login.status).toBe(200);

  const row = one<any>('SELECT id, mfa_secret_enc, mfa_enabled, mfa_method FROM users WHERE email = ?', 'admin@test.local');
  if (row?.mfa_enabled && row.mfa_secret_enc) {
    const verify = await a.req('POST', '/api/auth/mfa/verify', { code: authenticator.generate(decrypt(row.mfa_secret_enc)) });
    expect(verify.status).toBe(200);
    return a;
  }
  if (row?.mfa_method === 'email') {
    const { run } = await import('./db/db.js');
    const { keyedHash } = await import('./lib/crypto.js');
    run('DELETE FROM login_codes WHERE user_id = ? AND purpose = ?', row.id, 'mfa');
    run(`INSERT INTO login_codes (id, user_id, code_hash, purpose, expires_at) VALUES (?, ?, ?, 'mfa', ?)`,
      `lc-admin-${Date.now()}`, row.id, keyedHash('424242', `${row.id}|mfa`), new Date(Date.now() + 600_000).toISOString());
    const verify = await a.req('POST', '/api/auth/mfa/verify', { code: '424242' });
    expect(verify.status).toBe(200);
    return a;
  }
  const setup = await a.req('POST', '/api/auth/mfa/setup');
  expect(setup.status).toBe(200);
  const enable = await a.req('POST', '/api/auth/mfa/enable', { code: authenticator.generate(setup.data.secret) });
  expect(enable.status).toBe(200);
  return a;
}

describe('super admin user management', () => {
  it('grants access, sets temp password, creates one-time link, never exposes secrets', async () => {
    const a = await adminClient();
    const list = await a.req('GET', '/api/admin/users?q=stu@');
    expect(list.status).toBe(200);
    const u = list.data.users[0];
    expect(u).not.toHaveProperty('password_hash');
    expect(u).not.toHaveProperty('mfa_secret_enc');

    const grant = await a.req('POST', `/api/admin/users/${u.id}/access`, { action: 'grant', months: 12 });
    expect(grant.data.user.companionEnd > grant.data.user.companionStart).toBe(true);

    const link = await a.req('POST', `/api/admin/users/${u.id}/one-time-link`, { minutes: 15 });
    expect(link.data.link).toMatch(/\/one-time\?token=/);
    const token = link.data.link.split('token=')[1];
    const s = new Client();
    expect((await s.req('POST', '/api/auth/one-time', { token })).status).toBe(200);
    // one-time only
    expect((await new Client().req('POST', '/api/auth/one-time', { token })).status).toBe(400);

    const audit = await a.req('GET', '/api/admin/audit');
    expect(audit.data.entries.some((e: any) => e.action === 'admin.one_time_link')).toBe(true);
  });
});

describe('usage, API keys and secrecy', () => {
  it('stops sponsored requests when the reply limit is reached and never counts failures', async () => {
    const a = await adminClient();
    const u = (await a.req('GET', '/api/admin/users?q=stu@')).data.users[0];
    await a.req('PATCH', `/api/admin/users/${u.id}`, { replyLimitOverride: 1 });

    const s = new Client();
    await s.req('POST', '/api/auth/login', { email: 'stu@test.local', password: 'student-pass-1' });
    await s.req('POST', '/api/auth/onboarding', { acceptTerms: true, acceptPrivacy: true, isAdult: true, memoryEnabled: true });
    const conv = (await s.req('POST', '/api/conversations', { depth: 'fast' })).data.conversation;
    expect(conv.id).toBeTruthy();

    // No OPENAI_API_KEY in tests -> the platform client is unavailable (503) and nothing is reserved/counted.
    const r1 = await s.req('POST', `/api/conversations/${conv.id}/messages`, { content: 'hello' });
    expect(r1.status).toBe(503);
    expect(r1.data.code).toBe('companion_unavailable');
    // the student's message was NOT saved, so resending will not duplicate it
    expect((await s.req('GET', `/api/conversations/${conv.id}`)).data.messages).toHaveLength(0);
    const usage = (await s.req('GET', '/api/usage')).data.usage;
    expect(usage.repliesUsed).toBe(0);
    expect(usage.repliesLimit).toBe(1);

    // Simulate one completed sponsored reply, then the next request must be refused.
    const { run } = await import('./db/db.js');
    run(
      `INSERT INTO usage_ledger (id, user_id, period_start, period_end, model_id, payment_source, status, reserved_cost, actual_cost)
       VALUES ('t1', ?, ?, ?, 'gpt-4.1-mini', 'included', 'completed', 0, 0.01)`,
      u.id, usage.periodStart, usage.periodEnd,
    );
    const after = (await s.req('GET', '/api/usage')).data.usage;
    expect(after.repliesRemaining).toBe(0);
    expect(after.includedExhausted).toBe(true);
    process.env.OPENAI_API_KEY = 'sk-platform-test';
    const { config } = await import('./config.js');
    (config as any).openaiApiKey = 'sk-platform-test';
    const r2 = await s.req('POST', `/api/conversations/${conv.id}/messages`, { content: 'again' });
    expect(r2.status).toBe(402);
    expect(r2.data.code).toBe('usage_exhausted');
    expect(r2.data.resetDate).toBe(usage.periodEnd);
    (config as any).openaiApiKey = '';
  });

  it('stores the customer key encrypted and never exposes it to admins or exports', async () => {
    const { run, one } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const u = one<any>('SELECT id FROM users WHERE email = ?', 'stu@test.local');
    // Insert directly (validation against OpenAI is not possible offline)
    run(
      `INSERT INTO customer_api_keys (user_id, key_enc, last4, validated_at, valid) VALUES (?, ?, 'abcd', ?, 1)`,
      u.id, encrypt('sk-secret-key-value-abcd'), new Date().toISOString(),
    );
    const raw = one<any>('SELECT key_enc FROM customer_api_keys WHERE user_id = ?', u.id);
    expect(raw.key_enc).not.toContain('sk-secret');

    const s = new Client();
    await s.req('POST', '/api/auth/login', { email: 'stu@test.local', password: 'student-pass-1' });
    const before = (await s.req('GET', '/api/usage')).data.usage;
    expect(before.paymentSource).toBe('included'); // saved but not activated
    const act = await s.req('POST', '/api/usage/api-key/activate', {});
    expect(act.data.usage.paymentSource).toBe('customer_key');
    expect(act.data.usage.customerKey.last4).toBe('abcd');
    const exp = await s.req('GET', '/api/privacy/export/account.json');
    expect(exp.text).not.toContain('sk-secret');
    expect(exp.text).not.toContain(raw.key_enc);

    const a = await adminClient();
    const detail = await a.req('GET', `/api/admin/users/${u.id}`);
    expect(detail.text).not.toContain('sk-secret');
    expect(detail.text).not.toContain(raw.key_enc);
    expect(detail.data.apiKey.last4).toBe('abcd');
    expect(detail.data).not.toHaveProperty('conversationsContent');

    const back = await s.req('POST', '/api/usage/api-key/deactivate', {});
    expect(back.data.usage.paymentSource).toBe('included');
  });
});

describe('memory approval and deletion', () => {
  it('pending memories are not used until approved; students can edit and delete', async () => {
    const s = new Client();
    await s.req('POST', '/api/auth/login', { email: 'stu@test.local', password: 'student-pass-1' });
    const { createMemory, relevantMemories } = await import('./lib/memory.js');
    const { one } = await import('./db/db.js');
    const u = one<any>('SELECT id FROM users WHERE email = ?', 'stu@test.local');
    const pending = await createMemory(u.id, { category: 'goal', content: 'Run a marathon next spring', status: 'pending' });
    expect((await relevantMemories(u.id, 'marathon running', 5)).length).toBe(0);

    const list = await s.req('GET', '/api/memories');
    expect(list.data.memories[0].status).toBe('pending');
    const approve = await s.req('PATCH', `/api/memories/${pending.id}`, { status: 'approved', content: 'Run a half marathon next spring' });
    expect(approve.data.memory.status).toBe('approved');
    expect((await relevantMemories(u.id, 'marathon running', 5)).length).toBe(1);

    expect((await s.req('DELETE', `/api/memories/${pending.id}`)).status).toBe(200);
    expect((await relevantMemories(u.id, 'marathon', 5)).length).toBe(0);
    // other users cannot touch it
    const other = new Client();
    await other.req('POST', '/api/auth/register', { email: 'other@test.local', name: 'O', password: 'other-pass-123' });
    expect((await other.req('DELETE', `/api/memories/${pending.id}`)).status).toBe(404);
  });

  it('journal entries are private and deletable; account deletion wipes everything', async () => {
    const s = new Client();
    await s.req('POST', '/api/auth/login', { email: 'stu@test.local', password: 'student-pass-1' });
    const e = (await s.req('POST', '/api/journal', { title: 'Morning' })).data.entry;
    await s.req('PATCH', `/api/journal/${e.id}`, { contentHtml: '<p>Private <b>thoughts</b><script>x</script></p>' });
    const got = (await s.req('GET', `/api/journal/${e.id}`)).data.entry;
    expect(got.contentHtml).toBe('<p>Private <b>thoughts</b></p>');
    const other = new Client();
    await other.req('POST', '/api/auth/login', { email: 'other@test.local', password: 'other-pass-123' });
    expect((await other.req('GET', `/api/journal/${e.id}`)).status).toBe(404);

    const del = await s.req('POST', '/api/privacy/delete-account', { password: 'student-pass-1', confirm: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await s.req('GET', '/api/auth/me')).data.user).toBeNull();
    const { one } = await import('./db/db.js');
    expect(one('SELECT id FROM journal_entries WHERE id = ?', e.id)).toBeUndefined();
    expect(one('SELECT id FROM users WHERE email = ?', 'stu@test.local')).toBeUndefined();
    expect(one('SELECT user_id FROM customer_api_keys')).toBeUndefined();
  });
});

describe('plans and JVZoo payment notifications', () => {
  it('verifies the JVZoo signature, creates the account, applies the plan, and is idempotent', async () => {
    const { setSetting, one, all } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const { jvzooVerify } = await import('./routes/webhooks.js');
    const secret = 'test-jvzoo-secret';
    setSetting('jvzoo', { enabled: true, secretEnc: encrypt(secret), productMap: { '101': 'foundations' }, sendWelcomeEmail: true, revokeOnRefund: true });

    const sign = (f: Record<string, string>) => {
      const crypto = require('node:crypto');
      const pop = Object.keys(f).filter((k) => k !== 'cverify').sort().map((k) => `${f[k]}|`).join('') + secret;
      return crypto.createHash('sha1').update(pop, 'utf8').digest('hex').slice(0, 8).toUpperCase();
    };
    const post = async (fields: Record<string, string>) => {
      const body = new URLSearchParams({ ...fields, cverify: sign(fields) });
      const res = await fetch(base + '/api/webhooks/jvzoo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      return { status: res.status, text: await res.text() };
    };

    const sale = { ctransaction: 'SALE', ctransreceipt: 'RCPT-1', ccustemail: 'buyer@test.local', ccustname: 'Bea Buyer', cproditem: '101', cprodtitle: 'Foundations', ctransamount: '497.00', ccurrency: 'USD' };
    expect(jvzooVerify({ ...sale, cverify: sign(sale) }, secret)).toBe(true);
    expect(jvzooVerify({ ...sale, cverify: sign(sale) }, 'wrong-secret')).toBe(false);

    expect((await post(sale)).status).toBe(200);
    const user = one<any>('SELECT * FROM users WHERE email = ?', 'buyer@test.local');
    expect(user).toBeTruthy();
    expect(user.plan_id).toBe('foundations');
    expect(user.source).toBe('jvzoo');
    expect(user.must_change_password).toBe(1);
    expect(user.companion_end > user.companion_start).toBe(true);
    const firstEnd = user.companion_end;

    // the same notification again changes nothing
    expect((await post(sale)).status).toBe(200);
    expect(one<any>('SELECT companion_end FROM users WHERE id = ?', user.id).companion_end).toBe(firstEnd);
    expect(all('SELECT id FROM payments WHERE receipt = ? AND transaction_type = ? AND result = ?', 'RCPT-1', 'SALE', 'processed')).toHaveLength(1);

    // a rebill extends access from the existing end date
    expect((await post({ ...sale, ctransaction: 'BILL', ctransreceipt: 'RCPT-2' })).status).toBe(200);
    expect(one<any>('SELECT companion_end FROM users WHERE id = ?', user.id).companion_end > firstEnd).toBe(true);

    // a refund ends Companion access but keeps lifetime course access
    expect((await post({ ...sale, ctransaction: 'RFND', ctransreceipt: 'RCPT-3' })).status).toBe(200);
    const after = one<any>('SELECT companion_end, course_access FROM users WHERE id = ?', user.id);
    expect(after.companion_end < new Date().toISOString().slice(0, 10)).toBe(true);
    expect(after.course_access).toBe(1);
  });

  it('ignores notifications with a bad signature and never creates an account', async () => {
    const res = await fetch(base + '/api/webhooks/jvzoo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ctransaction: 'SALE', ctransreceipt: 'BAD-1', ccustemail: 'forger@test.local', cproditem: '101', cverify: 'DEADBEEF' }),
    });
    expect(res.status).toBe(200); // never leak whether the secret matched
    const { one } = await import('./db/db.js');
    expect(one('SELECT id FROM users WHERE email = ?', 'forger@test.local')).toBeUndefined();
    // recorded for the admin log under a suffixed receipt so a corrected retry is never blocked
    expect(one<any>("SELECT result FROM payments WHERE receipt LIKE 'BAD-1%'").result).toBe('error');
  });

  it('applies plan limits to included usage and returns copyable credentials for admin-created users', async () => {
    const a = await adminClient();
    const { run, one } = await import('./db/db.js');
    run(`INSERT INTO plans (id, name, description, price_cents, currency, duration_months, grants_course, replies_per_period, cost_ceiling_usd, is_default, active, sort_order)
         VALUES ('tiny', 'Tiny plan', '', 100, 'USD', 3, 0, 7, 1.5, 0, 1, 9)`);

    const created = await a.req('POST', '/api/admin/users', { email: 'planned@test.local', name: 'Plan Ned', planId: 'tiny', sendWelcomeEmail: false });
    expect(created.status).toBe(200);
    expect(created.data.credentials.email).toBe('planned@test.local');
    expect(created.data.credentials.password).toHaveLength(14);
    expect(created.data.user.planId).toBe('tiny');
    expect(created.data.user.mustChangePassword).toBe(true);

    const s = new Client();
    const login = await s.req('POST', '/api/auth/login', { email: 'planned@test.local', password: created.data.credentials.password });
    expect(login.status).toBe(200);
    const usage = (await s.req('GET', '/api/usage')).data.usage;
    expect(usage.repliesLimit).toBe(7);      // from the plan, not the global 250
    expect(usage.costLimit).toBe(1.5);

    // a personal override still wins over the plan
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'planned@test.local').id;
    await a.req('PATCH', `/api/admin/users/${uid}`, { replyLimitOverride: 3 });
    expect((await s.req('GET', '/api/usage')).data.usage.repliesLimit).toBe(3);

    // plans in use cannot be deleted by accident
    const del = await a.req('DELETE', '/api/admin/plans/tiny');
    expect(del.status).toBe(400);
    expect(del.data.error).toMatch(/user\(s\) are on this plan/);
  });
});

describe('emailed sign-in codes', () => {
  it('requires a valid code, rejects wrong ones, and expires them', async () => {
    const { one, run } = await import('./db/db.js');
    const { keyedHash } = await import('./lib/crypto.js');
    // Switching methods requires the current factor first.
    const half = new Client();
    await half.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
    const refused = await half.req('POST', '/api/auth/mfa/use-email');
    expect(refused.status).toBe(403);
    expect(refused.data.code).toBe('mfa_required');

    const a = await adminClient();
    expect((await a.req('POST', '/api/auth/mfa/use-email')).status).toBe(200);

    // a fresh sign-in now needs a code
    const b = new Client();
    const login = await b.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
    expect(login.data.mfaRequired).toBe(true);
    expect(login.data.mfaMethod).toBe('email');
    expect((await b.req('GET', '/api/admin/users')).status).toBe(403); // locked until verified

    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'admin@test.local').id;
    expect((await b.req('POST', '/api/auth/mfa/verify', { code: '000000' })).status).toBe(401);

    // read the stored hash to derive a known-good code for the test
    run('DELETE FROM login_codes WHERE user_id = ?', uid);
    run(`INSERT INTO login_codes (id, user_id, code_hash, purpose, expires_at) VALUES ('lc-test', ?, ?, 'mfa', ?)`,
      uid, keyedHash('123456', `${uid}|mfa`), new Date(Date.now() + 600_000).toISOString());
    expect((await b.req('POST', '/api/auth/mfa/verify', { code: '123456' })).status).toBe(200);
    expect((await b.req('GET', '/api/admin/users')).status).toBe(200);

    // codes are single use
    expect((await b.req('POST', '/api/auth/mfa/verify', { code: '123456' })).status).toBe(401);

    // expired codes are refused
    const c = new Client();
    await c.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
    run('DELETE FROM login_codes WHERE user_id = ?', uid);
    run(`INSERT INTO login_codes (id, user_id, code_hash, purpose, expires_at) VALUES ('lc-old', ?, ?, 'mfa', ?)`,
      uid, keyedHash('654321', `${uid}|mfa`), new Date(Date.now() - 1000).toISOString());
    const expired = await c.req('POST', '/api/auth/mfa/verify', { code: '654321' });
    expect(expired.status).toBe(401);
    expect(expired.data.error).toMatch(/expired/i);
  });
});

describe('payment notification safety', () => {
  it('processes only one of two simultaneous identical notifications', async () => {
    const { setSetting, one, all } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const secret = 'race-secret';
    setSetting('jvzoo', { enabled: true, secretEnc: encrypt(secret), productMap: {}, sendWelcomeEmail: false, revokeOnRefund: true });
    const crypto = await import('node:crypto');
    const f: Record<string, string> = {
      ctransaction: 'SALE', ctransreceipt: 'RACE-1', ccustemail: 'racer@test.local',
      ccustname: 'Ray Racer', cproditem: '999', ctransamount: '497.00',
    };
    const pop = Object.keys(f).sort().map((k) => `${f[k]}|`).join('') + secret;
    f.cverify = crypto.createHash('sha1').update(pop, 'utf8').digest('hex').slice(0, 8).toUpperCase();
    const send = () => fetch(base + '/api/webhooks/jvzoo', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f),
    });
    const results = await Promise.all([send(), send(), send()]);
    for (const r of results) expect(r.status).toBe(200);

    const processed = all(`SELECT id FROM payments WHERE receipt = 'RACE-1' AND result = 'processed'`);
    expect(processed).toHaveLength(1);
    const u = one<any>('SELECT companion_start, companion_end FROM users WHERE email = ?', 'racer@test.local');
    expect(u).toBeTruthy();
    // exactly one 12-month grant, not two or three
    const months = (new Date(u.companion_end).getTime() - new Date(u.companion_start).getTime()) / 86400000;
    expect(months).toBeGreaterThan(360);
    expect(months).toBeLessThan(370);
  });

  it('never shortens access that has no expiry', async () => {
    const { run, one } = await import('./db/db.js');
    const { applyPlanToUser, getPlan } = await import('./lib/plans.js');
    run(`INSERT INTO plans (id, name, description, price_cents, currency, duration_months, grants_course, is_default, active, sort_order)
         VALUES ('lifetime-companion', 'Lifetime', '', 99900, 'USD', 0, 1, 0, 1, 8)`);
    const u = one<any>('SELECT id FROM users WHERE email = ?', 'racer@test.local');
    applyPlanToUser(u.id, getPlan('lifetime-companion')!, 'start');
    expect(one<any>('SELECT companion_end FROM users WHERE id = ?', u.id).companion_end).toBeNull();
    // a later 12-month renewal must not put an expiry back on
    applyPlanToUser(u.id, getPlan('foundations')!, 'extend');
    expect(one<any>('SELECT companion_end FROM users WHERE id = ?', u.id).companion_end).toBeNull();
  });
});

describe('profile', () => {
  it('changes the sign-in email only after the code sent to the new address is entered', async () => {
    const { one, run } = await import('./db/db.js');
    const { keyedHash } = await import('./lib/crypto.js');
    const a = await adminClient();
    const created = await a.req('POST', '/api/admin/users', { email: 'mover@test.local', name: 'Mo Ver', planId: null, grantCompanionMonths: 12, sendWelcomeEmail: false });
    const password = created.data.credentials.password;

    const s = new Client();
    await s.req('POST', '/api/auth/login', { email: 'mover@test.local', password });

    // wrong password is refused
    expect((await s.req('POST', '/api/profile/email', { newEmail: 'moved@test.local', password: 'not-it' })).status).toBe(400);
    // an address in use is refused
    expect((await s.req('POST', '/api/profile/email', { newEmail: 'admin@test.local', password })).status).toBe(400);

    const start = await s.req('POST', '/api/profile/email', { newEmail: 'moved@test.local', password });
    expect(start.status).toBe(200);
    const uid = one<any>('SELECT id, email, pending_email FROM users WHERE email = ?', 'mover@test.local');
    expect(uid.pending_email).toBe('moved@test.local');
    expect(uid.email).toBe('mover@test.local'); // not changed yet

    expect((await s.req('POST', '/api/profile/email/verify', { code: '000000' })).status).toBe(400);
    run('DELETE FROM login_codes WHERE user_id = ? AND purpose = ?', uid.id, 'verify_email');
    run(`INSERT INTO login_codes (id, user_id, code_hash, purpose, expires_at) VALUES ('lc-mail', ?, ?, 'verify_email', ?)`,
      uid.id, keyedHash('222333', `${uid.id}|verify_email`), new Date(Date.now() + 600_000).toISOString());
    const done = await s.req('POST', '/api/profile/email/verify', { code: '222333' });
    expect(done.status).toBe(200);
    const after = one<any>('SELECT email, pending_email, email_verified FROM users WHERE id = ?', uid.id);
    expect(after.email).toBe('moved@test.local');
    expect(after.pending_email).toBeNull();
    expect(after.email_verified).toBe(1);
    // the code cannot be replayed
    expect((await s.req('POST', '/api/profile/email/verify', { code: '222333' })).status).toBe(400);
  });

  it('stores an avatar, serves it to its owner and to admins, and hides it from other students', async () => {
    const { one } = await import('./db/db.js');
    const a = await adminClient();
    const c1 = await a.req('POST', '/api/admin/users', { email: 'pic@test.local', name: 'Pic', grantCompanionMonths: 12, sendWelcomeEmail: false });
    const c2 = await a.req('POST', '/api/admin/users', { email: 'nosy@test.local', name: 'Nosy', grantCompanionMonths: 12, sendWelcomeEmail: false });

    const owner = new Client();
    await owner.req('POST', '/api/auth/login', { email: 'pic@test.local', password: c1.data.credentials.password });
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'pic@test.local').id;

    // a 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('avatar', new Blob([png], { type: 'image/png' }), 'me.png');
    const up = await fetch(base + '/api/profile/avatar', { method: 'POST', headers: { cookie: owner.cookie }, body: form });
    expect(up.status).toBe(200);

    // a text file pretending to be an image is refused
    const bad = new FormData();
    bad.append('avatar', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'x.png');
    expect((await fetch(base + '/api/profile/avatar', { method: 'POST', headers: { cookie: owner.cookie }, body: bad })).status).toBe(400);

    const fetchAvatar = (cookie: string) => fetch(`${base}/api/profile/avatar/${uid}`, { headers: { cookie } });
    expect((await fetchAvatar(owner.cookie)).status).toBe(200);
    expect((await fetchAvatar(a.cookie)).status).toBe(200); // administrators may see it

    const nosy = new Client();
    await nosy.req('POST', '/api/auth/login', { email: 'nosy@test.local', password: c2.data.credentials.password });
    expect((await fetchAvatar(nosy.cookie)).status).toBe(404); // another student may not

    expect((await owner.req('DELETE', '/api/profile/avatar')).status).toBe(200);
    expect((await fetchAvatar(owner.cookie)).status).toBe(404);
  });
});

describe('two-step verification cannot be bypassed', () => {
  it('refuses to re-enrol, switch method, or disable from a session that has not passed the second step', async () => {
    const { one, run } = await import('./db/db.js');
    // ensure the admin is on an authenticator again for this test
    const a = await adminClient();
    const setup = await a.req('POST', '/api/auth/mfa/setup');
    await a.req('POST', '/api/auth/mfa/enable', { code: authenticator.generate(setup.data.secret) });

    const attacker = new Client(); // has the password only
    const login = await attacker.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
    expect(login.data.mfaRequired).toBe(true);

    for (const path of ['/api/auth/mfa/setup', '/api/auth/mfa/use-email']) {
      const r = await attacker.req('POST', path);
      expect(r.status).toBe(403);
      expect(r.data.code).toBe('mfa_required');
    }
    expect((await attacker.req('POST', '/api/auth/mfa/disable', { password: 'admin-pass-123456' })).status).toBe(403);
    // and the admin area stays locked
    expect((await attacker.req('GET', '/api/admin/users')).status).toBe(403);
    // the real authenticator secret is untouched
    const row = one<any>('SELECT mfa_enabled, mfa_method FROM users WHERE email = ?', 'admin@test.local');
    expect(row.mfa_enabled).toBe(1);
    expect(row.mfa_method).toBe('totp');
    void run;
  });

  it('blocks ordinary student data behind the second step, not just the admin area', async () => {
    const { one, run } = await import('./db/db.js');
    const { keyedHash } = await import('./lib/crypto.js');
    const a = await adminClient();
    const created = await a.req('POST', '/api/admin/users', { email: 'twostep@test.local', name: 'Two Step', grantCompanionMonths: 12, sendWelcomeEmail: false });
    const password = created.data.credentials.password;

    const s = new Client();
    await s.req('POST', '/api/auth/login', { email: 'twostep@test.local', password });
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'twostep@test.local').id;
    // student opts into emailed codes while properly signed in (no second factor enrolled yet)
    expect((await s.req('POST', '/api/auth/mfa/use-email')).status).toBe(200);

    const thief = new Client();
    await thief.req('POST', '/api/auth/login', { email: 'twostep@test.local', password });
    for (const path of ['/api/conversations', '/api/journal', '/api/memories', '/api/privacy/export/account.json']) {
      const r = await thief.req('GET', path);
      expect(r.status).toBe(403);
      expect(r.data.code).toBe('mfa_required');
    }
    // signing out and checking who you are still work
    expect((await thief.req('GET', '/api/auth/me')).status).toBe(200);

    run('DELETE FROM login_codes WHERE user_id = ?', uid);
    run(`INSERT INTO login_codes (id, user_id, code_hash, purpose, expires_at) VALUES ('lc-2s', ?, ?, 'mfa', ?)`,
      uid, keyedHash('777888', `${uid}|mfa`), new Date(Date.now() + 600_000).toISOString());
    expect((await thief.req('POST', '/api/auth/mfa/verify', { code: '777888' })).status).toBe(200);
    expect((await thief.req('GET', '/api/conversations')).status).toBe(200);
  });
});

describe('regenerate accounting', () => {
  it('releases the superseded reply so regenerating does not consume extra credits', async () => {
    const { one, run } = await import('./db/db.js');
    const a = await adminClient();
    const created = await a.req('POST', '/api/admin/users', { email: 'regen@test.local', name: 'Reg En', grantCompanionMonths: 12, sendWelcomeEmail: false });
    const s = new Client();
    await s.req('POST', '/api/auth/login', { email: 'regen@test.local', password: created.data.credentials.password });
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'regen@test.local').id;
    const conv = (await s.req('POST', '/api/conversations', {})).data.conversation;

    // simulate a completed exchange that consumed one reply
    const usage = (await s.req('GET', '/api/usage')).data.usage;
    run(`INSERT INTO messages (id, conversation_id, role, content) VALUES ('m-user', ?, 'user', 'hi')`, conv.id);
    run(`INSERT INTO messages (id, conversation_id, role, content, model_id) VALUES ('m-asst', ?, 'assistant', 'hello', 'gpt-5-mini')`, conv.id);
    run(`INSERT INTO usage_ledger (id, user_id, period_start, period_end, conversation_id, message_id, model_id, payment_source, status, reserved_cost, actual_cost)
         VALUES ('u-regen', ?, ?, ?, ?, 'm-asst', 'gpt-5-mini', 'included', 'completed', 0, 0.01)`,
      uid, usage.periodStart, usage.periodEnd, conv.id);
    expect((await s.req('GET', '/api/usage')).data.usage.repliesUsed).toBe(1);

    // With the Companion unavailable the request is refused up front and nothing is destroyed.
    const refused = await s.req('POST', `/api/conversations/${conv.id}/regenerate`);
    expect(refused.status).toBe(503);
    expect(one(`SELECT id FROM messages WHERE id = 'm-asst'`)).toBeTruthy();
    expect(one<any>(`SELECT status FROM usage_ledger WHERE id = 'u-regen'`).status).toBe('completed');

    // When it does proceed, the superseded reply is removed and its usage released.
    const { supersedeAssistantMessage } = await import('./routes/conversations.js');
    supersedeAssistantMessage('m-asst');
    expect(one(`SELECT id FROM messages WHERE id = 'm-asst'`)).toBeUndefined();
    expect(one<any>(`SELECT status FROM usage_ledger WHERE id = 'u-regen'`).status).toBe('released');
    expect((await s.req('GET', '/api/usage')).data.usage.repliesUsed).toBe(0);
  });
});

describe('stale usage reservations', () => {
  it('are swept so they stop counting against the student', async () => {
    const { run, one } = await import('./db/db.js');
    const { sweepStaleReservations } = await import('./lib/usage.js');
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'regen@test.local').id;
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    run(`INSERT INTO usage_ledger (id, user_id, period_start, period_end, model_id, payment_source, status, reserved_cost, created_at)
         VALUES ('u-stale', ?, date('now'), date('now','+1 month'), 'gpt-5-mini', 'included', 'reserved', 0.03, ?)`, uid, old);
    run(`INSERT INTO usage_ledger (id, user_id, period_start, period_end, model_id, payment_source, status, reserved_cost)
         VALUES ('u-fresh', ?, date('now'), date('now','+1 month'), 'gpt-5-mini', 'included', 'reserved', 0.03)`, uid);

    expect(sweepStaleReservations(15)).toBe(1);
    expect(one<any>(`SELECT status FROM usage_ledger WHERE id = 'u-stale'`).status).toBe('released');
    expect(one<any>(`SELECT status FROM usage_ledger WHERE id = 'u-fresh'`).status).toBe('reserved');
  });
});

describe('streaming visibility', () => {
  it('hides memory suggestion tags but keeps streaming the text after them', async () => {
    const { visibleSoFar } = await import('./lib/chat.js');
    expect(visibleSoFar('Here is a thought')).toBe('Here is a thought');
    expect(visibleSoFar('Text <memory')).toBe('Text ');                    // partial tag held back
    expect(visibleSoFar('Text <memory_suggestion>[goal]: run')).toBe('Text ');
    // once the tag closes, the text after it must flow again
    expect(visibleSoFar('Text <memory_suggestion>[goal]: run</memory_suggestion> and more'))
      .toBe('Text  and more');
  });
});

describe('payment notifications without a receipt', () => {
  it('are refused rather than granted, because they cannot be de-duplicated', async () => {
    const { setSetting, one } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const crypto = await import('node:crypto');
    const secret = 'no-receipt-secret';
    setSetting('jvzoo', { enabled: true, secretEnc: encrypt(secret), productMap: {}, sendWelcomeEmail: false, revokeOnRefund: true });
    const f: Record<string, string> = { ctransaction: 'SALE', ctransreceipt: '', ccustemail: 'ghost@test.local', ccustname: 'Ghost', cproditem: '1', ctransamount: '497.00' };
    const pop = Object.keys(f).sort().map((k) => `${f[k]}|`).join('') + secret;
    f.cverify = crypto.createHash('sha1').update(pop, 'utf8').digest('hex').slice(0, 8).toUpperCase();
    const res = await fetch(base + '/api/webhooks/jvzoo', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f),
    });
    expect(res.status).toBe(200);
    expect(one('SELECT id FROM users WHERE email = ?', 'ghost@test.local')).toBeUndefined();
  });
});

describe('JVZoo transaction lifecycle', () => {
  const secret = 'lifecycle-secret';
  let post: (f: Record<string, string>) => Promise<number>;

  beforeAll(async () => {
    const { setSetting, run, one } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const crypto = await import('node:crypto');
    if (!one('SELECT id FROM plans WHERE id = ?', 'lifetime-course')) {
      run(`INSERT INTO plans (id, name, description, price_cents, currency, duration_months, grants_course, is_default, active, sort_order)
           VALUES ('lifetime-course', 'Course + lifetime companion', '', 99700, 'USD', 0, 1, 0, 1, 20)`);
    }
    setSetting('jvzoo', {
      enabled: true,
      secretEnc: encrypt(secret),
      // 100 = the $497 bundle (12 months + course), 200 = renewal (12 months, no course),
      // 300 = a lifetime upsell
      productMap: { '100': 'foundations', '200': 'companion-renewal', '300': 'lifetime-course' },
      sendWelcomeEmail: false,
      revokeOnRefund: true,
    });
    post = async (f: Record<string, string>) => {
      const pop = Object.keys(f).sort().map((k) => `${f[k]}|`).join('') + secret;
      const signed = { ...f, cverify: crypto.createHash('sha1').update(pop, 'utf8').digest('hex').slice(0, 8).toUpperCase() };
      const res = await fetch(base + '/api/webhooks/jvzoo', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(signed),
      });
      return res.status;
    };
  });

  const monthsBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / (30.44 * 86400000));

  it('refunding a renewal takes back only that renewal, leaving the original purchase intact', async () => {
    const { one } = await import('./db/db.js');
    const base_ = { ccustemail: 'life@test.local', ccustname: 'Life Cycle', ctransamount: '497.00' };

    // 1. the original $497 purchase: 12 months + lifetime course
    expect(await post({ ...base_, ctransaction: 'SALE', ctransreceipt: 'LC-1', cproditem: '100' })).toBe(200);
    const afterSale = one<any>('SELECT * FROM users WHERE email = ?', 'life@test.local');
    expect(afterSale.plan_id).toBe('foundations');
    expect(afterSale.course_access).toBe(1);
    expect(monthsBetween(afterSale.companion_start, afterSale.companion_end)).toBe(12);

    // 2. a renewal a year later: another 12 months, no course entitlement
    expect(await post({ ...base_, ctransaction: 'SALE', ctransreceipt: 'LC-2', cproditem: '200', ctransamount: '297.00' })).toBe(200);
    const afterRenewal = one<any>('SELECT * FROM users WHERE email = ?', 'life@test.local');
    expect(monthsBetween(afterRenewal.companion_start, afterRenewal.companion_end)).toBe(24);
    expect(afterRenewal.plan_id).toBe('companion-renewal');

    // 3. they refund the renewal only
    expect(await post({ ...base_, ctransaction: 'RFND', ctransreceipt: 'LC-2', cproditem: '200', ctransamount: '297.00' })).toBe(200);
    const afterRefund = one<any>('SELECT * FROM users WHERE email = ?', 'life@test.local');
    expect(monthsBetween(afterRefund.companion_start, afterRefund.companion_end)).toBe(12); // back to the original year
    expect(afterRefund.course_access).toBe(1);                                             // course untouched
    expect(afterRefund.plan_id).toBe('foundations');                                       // moved off the refunded plan
    expect(one<any>(`SELECT reversed_at, reversed_by FROM payments WHERE receipt='LC-2' AND transaction_type='SALE'`).reversed_by).toBe('LC-2');

    // the same refund arriving twice must not subtract twice
    expect(await post({ ...base_, ctransaction: 'RFND', ctransreceipt: 'LC-2', cproditem: '200', ctransamount: '297.00' })).toBe(200);
    const afterDuplicate = one<any>('SELECT companion_end FROM users WHERE email = ?', 'life@test.local');
    expect(afterDuplicate.companion_end).toBe(afterRefund.companion_end);
  });

  it('refunding the original purchase ends access and takes back course entitlement', async () => {
    const { one } = await import('./db/db.js');
    const f = { ccustemail: 'refundall@test.local', ccustname: 'Ref Und', ctransamount: '497.00', cproditem: '100' };
    expect(await post({ ...f, ctransaction: 'SALE', ctransreceipt: 'RA-1' })).toBe(200);
    expect(one<any>('SELECT course_access FROM users WHERE email = ?', 'refundall@test.local').course_access).toBe(1);

    expect(await post({ ...f, ctransaction: 'RFND', ctransreceipt: 'RA-1' })).toBe(200);
    const u = one<any>('SELECT * FROM users WHERE email = ?', 'refundall@test.local');
    const today = new Date().toISOString().slice(0, 10);
    expect(u.companion_end < today).toBe(true);   // no Companion access
    expect(u.course_access).toBe(0);              // the course purchase was refunded
    expect(u.plan_id).toBeNull();
    expect(u.status).toBe('active');              // the account itself remains
  });

  it('a chargeback on an upsell removes only the upsell', async () => {
    const { one } = await import('./db/db.js');
    const f = { ccustemail: 'upsell@test.local', ccustname: 'Up Sell' };
    expect(await post({ ...f, ctransaction: 'SALE', ctransreceipt: 'US-1', cproditem: '100', ctransamount: '497.00' })).toBe(200);
    // the lifetime upsell: access no longer expires
    expect(await post({ ...f, ctransaction: 'SALE', ctransreceipt: 'US-2', cproditem: '300', ctransamount: '997.00' })).toBe(200);
    const upgraded = one<any>('SELECT * FROM users WHERE email = ?', 'upsell@test.local');
    expect(upgraded.companion_end).toBeNull();
    expect(upgraded.plan_id).toBe('lifetime-course');

    expect(await post({ ...f, ctransaction: 'CGBK', ctransreceipt: 'US-2', cproditem: '300', ctransamount: '997.00' })).toBe(200);
    const after = one<any>('SELECT * FROM users WHERE email = ?', 'upsell@test.local');
    expect(after.companion_end).not.toBeNull();      // no longer unlimited
    expect(after.course_access).toBe(1);             // still theirs from the original purchase
    expect(after.plan_id).toBe('foundations');
  });

  it('a cancelled subscription keeps access it already paid for, and resuming adds none', async () => {
    const { one } = await import('./db/db.js');
    const f = { ccustemail: 'canceller@test.local', ccustname: 'Can Celler', cproditem: '200', ctransamount: '297.00' };
    expect(await post({ ...f, ctransaction: 'SALE', ctransreceipt: 'CN-1' })).toBe(200);
    const paid = one<any>('SELECT companion_end FROM users WHERE email = ?', 'canceller@test.local').companion_end;

    expect(await post({ ...f, ctransaction: 'CANCEL-REBILL', ctransreceipt: 'CN-1' })).toBe(200);
    expect(one<any>('SELECT companion_end FROM users WHERE email = ?', 'canceller@test.local').companion_end).toBe(paid);

    expect(await post({ ...f, ctransaction: 'UNCANCEL-REBILL', ctransreceipt: 'CN-1' })).toBe(200);
    expect(one<any>('SELECT companion_end FROM users WHERE email = ?', 'canceller@test.local').companion_end).toBe(paid);

    // a failed rebill attempt changes nothing either
    expect(await post({ ...f, ctransaction: 'INSF', ctransreceipt: 'CN-1' })).toBe(200);
    expect(one<any>('SELECT companion_end FROM users WHERE email = ?', 'canceller@test.local').companion_end).toBe(paid);

    // the next successful rebill extends from where they were
    expect(await post({ ...f, ctransaction: 'BILL', ctransreceipt: 'CN-2' })).toBe(200);
    const extended = one<any>('SELECT companion_end FROM users WHERE email = ?', 'canceller@test.local').companion_end;
    expect(extended > paid).toBe(true);
  });

  it('a refund for an account we never granted anything to still ends Companion access', async () => {
    const { one, run } = await import('./db/db.js');
    const { hashPassword, newId } = await import('./lib/crypto.js');
    const id = newId('usr');
    run(`INSERT INTO users (id, email, name, password_hash, role, status, companion_start, companion_end)
         VALUES (?, 'legacy@test.local', 'Leg Acy', ?, 'student', 'active', date('now','-1 month'), date('now','+11 months'))`,
      id, await hashPassword('legacy-pass-123'));
    expect(await post({ ctransaction: 'RFND', ctransreceipt: 'LEG-1', ccustemail: 'legacy@test.local', ccustname: 'Leg Acy', cproditem: '100', ctransamount: '497.00' })).toBe(200);
    const u = one<any>('SELECT companion_end, course_access FROM users WHERE id = ?', id);
    expect(u.companion_end < new Date().toISOString().slice(0, 10)).toBe(true);
    expect(u.course_access).toBe(1); // untouched: we do not know what that purchase covered
  });
});

describe('secret handling and account security', () => {
  it('signs other devices out when the password changes, and invalidates outstanding links', async () => {
    const { one } = await import('./db/db.js');
    const a = await adminClient();
    const created = await a.req('POST', '/api/admin/users', { email: 'rotate@test.local', name: 'Ro Tate', grantCompanionMonths: 12, sendWelcomeEmail: false });
    const password = created.data.credentials.password;
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'rotate@test.local').id;

    const phone = new Client();
    const laptop = new Client();
    await phone.req('POST', '/api/auth/login', { email: 'rotate@test.local', password });
    await laptop.req('POST', '/api/auth/login', { email: 'rotate@test.local', password });
    expect((await phone.req('GET', '/api/conversations')).status).toBe(200);

    // an admin-issued sign-in link is outstanding
    const link = await a.req('POST', `/api/admin/users/${uid}/one-time-link`, { minutes: 60 });
    const token = link.data.link.split('token=')[1];

    expect((await laptop.req('POST', '/api/auth/change-password', { currentPassword: password, newPassword: 'a-much-better-password' })).status).toBe(200);

    expect((await laptop.req('GET', '/api/conversations')).status).toBe(200);  // the device that changed it stays
    expect((await phone.req('GET', '/api/conversations')).status).toBe(401);   // the other one is signed out
    expect((await new Client().req('POST', '/api/auth/one-time', { token })).status).toBe(400); // link is dead
  });

  it('throttles sign-in attempts against a single account, not just a single address', async () => {
    const a = await adminClient();
    await a.req('POST', '/api/admin/users', { email: 'target@test.local', name: 'Tar Get', grantCompanionMonths: 12, sendWelcomeEmail: false });
    let sawThrottle = false;
    for (let i = 0; i < 14; i++) {
      const r = await new Client().req('POST', '/api/auth/login', { email: 'target@test.local', password: `guess-${i}` });
      if (r.status === 429) { sawThrottle = true; expect(r.data.code).toBe('too_many_attempts'); break; }
      expect(r.status).toBe(401);
    }
    expect(sawThrottle).toBe(true);
    // a different account is unaffected
    expect((await new Client().req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'wrong' })).status).toBe(401);
  });

  it('accepts the local dev server on any port, and any origin listed in ALLOWED_ORIGINS', async () => {
    const { isAllowedOrigin } = await import('./app.js');
    const { config } = await import('./config.js');

    // The Vite dev server moves ports; development must not fight that.
    expect(isAllowedOrigin('http://localhost:5177')).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4000')).toBe(true);
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('not a url')).toBe(false);

    // A deployed instance accepts only its own address plus what the owner listed.
    const realDeployed = config.looksDeployed;
    const realExtra = config.extraOrigins;
    const realAppUrl = config.appUrl;
    try {
      (config as any).looksDeployed = true;
      (config as any).appUrl = 'https://companion.selflatitude.com';
      (config as any).extraOrigins = ['https://www.selflatitude.com'];
      expect(isAllowedOrigin('https://companion.selflatitude.com')).toBe(true);
      expect(isAllowedOrigin('https://www.selflatitude.com')).toBe(true);
      expect(isAllowedOrigin('http://localhost:5177')).toBe(false);
      expect(isAllowedOrigin('https://companion.selflatitude.com.evil.example')).toBe(false);
    } finally {
      (config as any).looksDeployed = realDeployed;
      (config as any).appUrl = realAppUrl;
      (config as any).extraOrigins = realExtra;
    }
  });

  it('refuses state-changing requests that carry another site\'s Origin', async () => {
    const a = await adminClient();
    const evil = await fetch(base + '/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: a.cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'csrf@test.local', name: 'C Srf' }),
    });
    expect(evil.status).toBe(403);
    const { one } = await import('./db/db.js');
    expect(one('SELECT id FROM users WHERE email = ?', 'csrf@test.local')).toBeUndefined();
    // reads are unaffected, and same-origin writes still work
    expect((await fetch(base + '/api/admin/users', { headers: { cookie: a.cookie, origin: 'https://evil.example' } })).status).toBe(200);
  });

  it('never writes a student API key, platform key or SMTP password to the database in the clear', async () => {
    const { run, one, setSetting, getSetting } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const secrets = {
      studentKey: 'sk-student-plaintext-must-not-appear',
      platformKey: 'sk-platform-plaintext-must-not-appear',
      smtpPassword: 'smtp-plaintext-must-not-appear',
      jvzooSecret: 'jvzoo-plaintext-must-not-appear',
    };
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'rotate@test.local').id;
    run(`INSERT OR REPLACE INTO customer_api_keys (user_id, key_enc, last4, valid) VALUES (?, ?, 'appe', 1)`, uid, encrypt(secrets.studentKey));
    setSetting('openai_platform_key', { enc: encrypt(secrets.platformKey), last4: 'pear', validatedAt: new Date().toISOString() });
    setSetting('smtp', { host: 'smtp.test', port: 587, secure: false, user: 'u', passEnc: encrypt(secrets.smtpPassword), from: 'a@b.c', replyTo: '' });
    setSetting('jvzoo', { enabled: false, secretEnc: encrypt(secrets.jvzooSecret), productMap: {}, sendWelcomeEmail: false, revokeOnRefund: true });

    // dump every text column of every table and look for the plaintext
    const tables = (await import('./db/db.js')).all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    );
    let dump = '';
    for (const t of tables) {
      if (t.name.endsWith('_fts') || t.name.includes('_fts_')) continue;
      for (const row of (await import('./db/db.js')).all<any>(`SELECT * FROM "${t.name}"`)) dump += JSON.stringify(row);
    }
    for (const [name, value] of Object.entries(secrets)) {
      expect(dump.includes(value), `${name} found in the database in the clear`).toBe(false);
    }

    // and they still decrypt correctly
    const { decrypt } = await import('./lib/crypto.js');
    expect(decrypt(one<any>('SELECT key_enc FROM customer_api_keys WHERE user_id = ?', uid).key_enc)).toBe(secrets.studentKey);
    expect(decrypt(getSetting<any>('openai_platform_key', {}).enc)).toBe(secrets.platformKey);
    expect(decrypt(getSetting<any>('smtp', {}).passEnc)).toBe(secrets.smtpPassword);
    expect(decrypt(getSetting<any>('jvzoo', {}).secretEnc)).toBe(secrets.jvzooSecret);

    // no endpoint hands them back
    const detail = await a_admin().then((c) => c.req('GET', `/api/admin/users/${uid}`));
    for (const value of Object.values(secrets)) expect(detail.text).not.toContain(value);
    const emailSettings = await a_admin().then((c) => c.req('GET', '/api/admin/settings/email'));
    expect(emailSettings.text).not.toContain(secrets.smtpPassword);
    expect(emailSettings.data.settings.hasPassword).toBe(true);
    const jvzooSettings = await a_admin().then((c) => c.req('GET', '/api/admin/settings/jvzoo'));
    expect(jvzooSettings.text).not.toContain(secrets.jvzooSecret);
    expect(jvzooSettings.data.settings.hasSecret).toBe(true);

    setSetting('jvzoo', { enabled: false, secretEnc: '', productMap: {}, sendWelcomeEmail: false, revokeOnRefund: true });
    run('DELETE FROM settings WHERE key IN (?, ?)', 'smtp', 'openai_platform_key');
  });
});

/** Shorthand used above so each assertion gets a fully verified admin session. */
const a_admin = () => adminClient();

describe('audit follow-ups', () => {
  it('a global code policy still blocks enrolling a new factor from an unverified session', async () => {
    const { setSetting, one, run } = await import('./db/db.js');
    const { keyedHash } = await import('./lib/crypto.js');
    const a = await adminClient();
    const created = await a.req('POST', '/api/admin/users', { email: 'policy@test.local', name: 'Pol Icy', grantCompanionMonths: 12, sendWelcomeEmail: false });
    const password = created.data.credentials.password;
    const uid = one<any>('SELECT id, mfa_method FROM users WHERE email = ?', 'policy@test.local');
    expect(uid.mfa_method).toBe('none'); // not individually enrolled

    // the owner requires a code from everyone
    setSetting('auth', { allowSelfRegistration: true, selfRegistrationMonths: 0, requireEmailCodeForAll: true, requireMfaForAdmins: true, emailCodeMinutes: 10 });
    try {
      const attacker = new Client();
      const login = await attacker.req('POST', '/api/auth/login', { email: 'policy@test.local', password });
      expect(login.data.mfaRequired).toBe(true);

      // enrolling an authenticator would otherwise hand the attacker a factor of their own
      const setup = await attacker.req('POST', '/api/auth/mfa/setup');
      expect(setup.status).toBe(403);
      expect(setup.data.code).toBe('mfa_required');
      expect((await attacker.req('POST', '/api/auth/mfa/use-email')).status).toBe(403);
      expect((await attacker.req('GET', '/api/journal')).status).toBe(403);

      // the real student passes the emailed code first, and can then enrol
      run('DELETE FROM login_codes WHERE user_id = ?', uid.id);
      run(`INSERT INTO login_codes (id, user_id, code_hash, purpose, expires_at) VALUES ('lc-pol', ?, ?, 'mfa', ?)`,
        uid.id, keyedHash('321321', `${uid.id}|mfa`), new Date(Date.now() + 600_000).toISOString());
      expect((await attacker.req('POST', '/api/auth/mfa/verify', { code: '321321' })).status).toBe(200);
      expect((await attacker.req('POST', '/api/auth/mfa/setup')).status).toBe(200);
    } finally {
      setSetting('auth', { allowSelfRegistration: true, selfRegistrationMonths: 0, requireEmailCodeForAll: false, requireMfaForAdmins: true, emailCodeMinutes: 10 });
    }
  });

  it('owner-level admin routes check suspension and two-step, not just the role', async () => {
    const { run, one } = await import('./db/db.js');
    const a = await adminClient();
    const created = await a.req('POST', '/api/admin/users', { email: 'owner2@test.local', name: 'Own Er', role: 'owner', grantCompanionMonths: 0, sendWelcomeEmail: false });
    const password = created.data.credentials.password;
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'owner2@test.local').id;

    const owner = new Client();
    await owner.req('POST', '/api/auth/login', { email: 'owner2@test.local', password });
    expect((await owner.req('GET', '/api/admin/companion')).status).toBe(200);

    // switching this owner to emailed codes means a password-only session is not enough
    expect((await owner.req('POST', '/api/auth/mfa/use-email')).status).toBe(200);
    const half = new Client();
    await half.req('POST', '/api/auth/login', { email: 'owner2@test.local', password });
    for (const path of ['/api/admin/companion', '/api/admin/overview', '/api/admin/settings/email', '/api/admin/plans']) {
      const r = await half.req('GET', path);
      expect(r.status, path).toBe(403);
      expect(r.data.code, path).toBe('mfa_required');
    }

    // and a suspended owner is refused outright
    run("UPDATE users SET status = 'suspended', mfa_method = 'none' WHERE id = ?", uid);
    const suspended = new Client();
    const login = await suspended.req('POST', '/api/auth/login', { email: 'owner2@test.local', password });
    expect(login.status).toBe(403);
    run("UPDATE users SET status = 'active' WHERE id = ?", uid);
  });

  it('lets a development machine turn off the admin two-step requirement, but never a live site', async () => {
    const { getSetting, setSetting } = await import('./db/db.js');
    const { config } = await import('./config.js');
    const a = await adminClient();
    const before = getSetting<any>('auth', {});
    const body = { allowSelfRegistration: true, selfRegistrationMonths: 0, requireEmailCodeForAll: false, requireMfaForAdmins: false, emailCodeMinutes: 10 };

    // A live site may not weaken it, whatever the request says.
    const realDeployed = config.looksDeployed;
    try {
      (config as any).looksDeployed = true;
      const refused = await a.req('PUT', '/api/admin/settings/auth', body);
      expect(refused.status).toBe(400);
      expect(refused.data.error).toMatch(/cannot be turned off on a live site/i);
    } finally {
      (config as any).looksDeployed = realDeployed;
    }

    // On a development machine the policy may be turned off.
    expect((await a.req('PUT', '/api/admin/settings/auth', body)).status).toBe(200);

    // It still does not disable a factor the administrator chose to enrol for themselves.
    const { run, one } = await import('./db/db.js');
    const enrolled = new Client();
    await enrolled.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
    expect(one<any>('SELECT mfa_method FROM users WHERE email = ?', 'admin@test.local').mfa_method).not.toBe('none');
    expect((await enrolled.req('GET', '/api/admin/users')).status).toBe(403);

    // With no factor enrolled and the policy off, Super Admin pages open on the password alone.
    run("UPDATE users SET mfa_enabled = 0, mfa_method = 'none', mfa_secret_enc = NULL WHERE email = ?", 'admin@test.local');
    const plain = new Client();
    await plain.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
    expect((await plain.req('GET', '/api/admin/users')).status).toBe(200);

    // Turning the policy back on locks them out until they enrol again.
    setSetting('auth', { ...body, requireMfaForAdmins: true });
    const again = new Client();
    await again.req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123456' });
    const locked = await again.req('GET', '/api/admin/users');
    expect(locked.status).toBe(403);
    expect(locked.data.error).toMatch(/multifactor/i);
    setSetting('auth', before);
  });

  it('a payment never lifts a suspension an administrator applied', async () => {
    const { one, run, setSetting } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const crypto = await import('node:crypto');
    const secret = 'suspend-secret';
    setSetting('jvzoo', { enabled: true, secretEnc: encrypt(secret), productMap: {}, sendWelcomeEmail: false, revokeOnRefund: true });

    const a = await adminClient();
    await a.req('POST', '/api/admin/users', { email: 'banned@test.local', name: 'Ban Ned', grantCompanionMonths: 0, sendWelcomeEmail: false });
    const uid = one<any>('SELECT id FROM users WHERE email = ?', 'banned@test.local').id;
    run("UPDATE users SET status = 'suspended' WHERE id = ?", uid);

    const f: Record<string, string> = { ctransaction: 'SALE', ctransreceipt: 'SUS-1', ccustemail: 'banned@test.local', ccustname: 'Ban Ned', cproditem: '100', ctransamount: '497.00' };
    const pop = Object.keys(f).sort().map((k) => `${f[k]}|`).join('') + secret;
    f.cverify = crypto.createHash('sha1').update(pop, 'utf8').digest('hex').slice(0, 8).toUpperCase();
    const res = await fetch(base + '/api/webhooks/jvzoo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
    expect(res.status).toBe(200);

    const after = one<any>('SELECT status, companion_end FROM users WHERE id = ?', uid);
    expect(after.status).toBe('suspended');          // still banned
    expect(after.companion_end).toBeTruthy();        // the purchase is recorded on the account
    expect(one<any>(`SELECT result FROM payments WHERE receipt = 'SUS-1'`).result).toBe('processed');
  });

  it('never stores the body of a notification whose signature did not check out', async () => {
    const { one, all, setSetting } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const { resetSignatureFailures } = await import('./routes/webhooks.js');
    resetSignatureFailures();
    setSetting('jvzoo', { enabled: true, secretEnc: encrypt('real-secret'), productMap: {}, sendWelcomeEmail: false, revokeOnRefund: true });

    const res = await fetch(base + '/api/webhooks/jvzoo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ctransaction: 'SALE', ctransreceipt: 'FORGE-1', ccustemail: 'forge@test.local',
        ccustname: 'INJECTED-MARKER-TEXT', cproditem: '1', cverify: 'AAAAAAAA',
      }),
    });
    expect(res.status).toBe(200);
    const row = one<any>(`SELECT payload_json, result FROM payments WHERE receipt LIKE 'FORGE-1%'`);
    expect(row.result).toBe('error');
    expect(row.payload_json).toBeNull();            // the unverified body is not kept
    expect(one('SELECT id FROM users WHERE email = ?', 'forge@test.local')).toBeUndefined();
    void all;
  });

  it('stops recording forged notifications once the hourly budget is spent', async () => {
    const { all, setSetting } = await import('./db/db.js');
    const { encrypt } = await import('./lib/crypto.js');
    const { resetSignatureFailures, signatureFailureCount } = await import('./routes/webhooks.js');
    resetSignatureFailures();
    setSetting('jvzoo', { enabled: true, secretEnc: encrypt('real-secret'), productMap: {}, sendWelcomeEmail: false, revokeOnRefund: true });

    const before = all(`SELECT id FROM payments WHERE receipt LIKE 'FLOOD%'`).length;
    for (let i = 0; i < 60; i++) {
      await fetch(base + '/api/webhooks/jvzoo', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ctransaction: 'SALE', ctransreceipt: `FLOOD-${i}`, ccustemail: 'f@test.local', cverify: 'BBBBBBBB' }),
      });
    }
    const written = all(`SELECT id FROM payments WHERE receipt LIKE 'FLOOD%'`).length - before;
    expect(signatureFailureCount()).toBe(60);
    expect(written).toBeLessThanOrEqual(50);   // the budget caps what reaches the database
    resetSignatureFailures();
  });
});
