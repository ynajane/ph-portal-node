import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword, verifyPassword, hmacHex, registerLimiter, issueCsrf, requireCsrf } from './security.js';
import { CO, validate } from './validate.js';
import { sendMail, sendSms, mode } from './services.js';
import { geo, check, checkAddress, checkEmail } from './geo.js';
import { classify } from './holidays.js';
import { withIslamic } from './islamic.js';

const E = process.env, PROD = E.NODE_ENV === 'production', APP = E.APP_NAME ?? 'Activity #2';
const SITE = (E.SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const isLocalDb = /localhost|127\.0\.0\.1/.test(E.DATABASE_URL ?? '');
const db = new pg.Pool({ connectionString: E.DATABASE_URL, ssl: isLocalDb ? undefined : { rejectUnauthorized: false } });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rnd = () => crypto.randomBytes(32).toString('hex');
const q = (text, p) => db.query(text, p);
const G = 'Invalid email or password. If your account is locked, check your email for the unlock link.';
const DUMMY = await hashPassword('dummy-password-for-timing');   // so unknown emails cost the same as real ones

const app = express();
// Trust X-Forwarded-For ONLY when really behind a proxy (Nginx/Cloudflare): set TRUST_PROXY=1 (number of proxy hops) in .env.
// Left on by default it lets anyone fake their IP header and dodge the 5-per-IP-per-hour registration limit.
app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY ?? '') ? Number(process.env.TRUST_PROXY) : false);
app.disable('x-powered-by');
app.use(helmet({
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  contentSecurityPolicy: { useDefaults: true, directives: {
    scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
    upgradeInsecureRequests: PROD ? [] : null } },
}));
if (PROD) app.use((req, res, next) => (req.secure ? next() : res.redirect(301, SITE + req.originalUrl)));   // HTTP -> HTTPS
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// ---------- helpers ----------
async function sendUnlock(u) {
  const raw = rnd();
  await q(`delete from verification_tokens where user_id=$1 and type='account_unlock'`, [u.id]);
  await q(`insert into verification_tokens(user_id,token_hash,type,expired_at) values($1,$2,'account_unlock',now()+interval '24 hours')`, [u.id, sha(raw)]);
  await sendMail(u.email, `Security alert: your ${APP} account was locked`,
    `Dear ${u.first_name},\n\nThere were 3 failed sign-in attempts on your account, so we locked it.\nFor your protection the unlock link works only after a 2-minute cooling period:\n\n${SITE}/unlock?token=${raw}\n\nIf this wasn't you, change your password after unlocking.\n\nThe ${APP} Security Team`);
}
async function sendVerify(first, em, raw) {
  const link = `${SITE}/verify-email?token=${raw}`;
  await sendMail(em, `Action Required: Verify your email address for ${APP}`,
    `Dear ${first},\n\nThank you for registering with ${APP}. We are thrilled to welcome you to our community.\n\nTo ensure the security of your account and complete your registration, please verify your email address by clicking the secure link below:\n\n${link}\n\nIf you did not initiate this request, please disregard this message. This link will expire in 24 hours for your protection.\n\nWarm regards,\nThe ${APP} Security Team`,
    `<p>Dear ${first.replace(/[<>&"]/g, '')},</p><p>Thank you for registering with ${APP}. We are thrilled to welcome you to our community.</p><p>To ensure the security of your account and complete your registration, please verify your email address by clicking the secure link below:</p><p><a href="${link}" style="background:#0b3a5b;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold">Verify My Email Address</a></p><p>If you did not initiate this request, please disregard this message. This link will expire in 24 hours for your protection.</p><p>Warm regards,<br>The ${APP} Security Team</p>`);
}
async function auth(req, res, next) {
  const sid = req.cookies?.sid;
  const r = sid && (await q(`select u.* from sessions s join users u on u.id=s.user_id where s.token_hash=$1 and s.expires_at>now()`, [sha(sid)])).rows[0];
  if (!r) return res.status(401).json({ error: 'Not signed in.' });
  req.user = r; next();
}
// After the email link is clicked we give a short-lived signed cookie that is accepted ONLY by the OTP routes,
// so the flow is: email link -> OTP -> login -> dashboard. It cannot open the dashboard or any other route.
const pendTok = (id) => { const exp = Date.now() + 30 * 60e3; return `${id}.${exp}.${hmacHex(`pend:${id}:${exp}`)}`; };
async function otpAuth(req, res, next) {
  const [id, exp, sig] = String(req.cookies?.pend ?? '').split('.');
  const want = id && exp ? hmacHex(`pend:${id}:${exp}`) : '';
  if (want && +exp > Date.now() && sig?.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
    const u = (await q('select * from users where id=$1', [id])).rows[0];
    if (u) { req.user = u; return next(); }
  }
  return auth(req, res, next);   // otherwise a normal logged-in session
}
// Login feedback: shows attempts left WITHOUT revealing whether the email exists (unknown emails get a fake counter).
const ghosts = new Map();
function ghostFail(em) {
  const now = Date.now(), g = ghosts.get(em);
  const n = g && g.exp > now ? g.n + 1 : 1;
  ghosts.set(em, { n, exp: now + 24 * 36e5 });
  if (ghosts.size > 5000) ghosts.delete(ghosts.keys().next().value);
  return n;
}
const attemptMsg = (n) => (n >= 3
  ? 'Too many failed attempts. If this account exists, it is now locked and an unlock link was sent to its email. Check your inbox (the link works after a 2-minute wait).'
  : `Invalid email or password. ${3 - n} attempt${3 - n === 1 ? '' : 's'} left before the account is locked.`);
async function safeUnlock(u) { try { await sendUnlock(u); } catch (err) { console.error('unlock email failed:', err.message); } }

const verified = (req, res, next) => (req.user.email_verified_at && req.user.mobile_verified ? next() : res.status(403).json({ error: 'Verify your email and mobile number first.' }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: G } });

// ---------- public ----------
app.get('/api/csrf', issueCsrf);
const lookupLimiter = rateLimit({ windowMs: 60e3, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many lookups. Slow down.' } });
app.use('/api/geo', lookupLimiter, geo);      // countries, states, cities, zip lookup, address match
app.post('/api/check/email', lookupLimiter, requireCsrf, async (req, res) => {   // public domain + MX + not already registered
  const r = await checkEmail(req.body?.email);
  if (r.ok && (await q('select 1 from users where email=$1', [r.email])).rowCount) return res.json({ ok: false, domain: r.domain, error: 'This email is already registered.' });
  res.json(r);
});
app.use('/api/check', lookupLimiter, requireCsrf, check);   // live mobile / email checks
app.get('/api/countries', (_req, res) => res.json(Object.fromEntries(Object.entries(CO).map(([k, v]) => [k, { name: v.name, prefix: v.prefix, zip: v.zip.source, zf: v.zip.flags, mob: v.mob.source, trunk: !!v.trunk, ex: v.ex }]))));

// Registration: rate limit (5/IP/hour) -> CSRF -> validation -> Argon2id -> unverified account + 24h email token
app.post('/api/register', registerLimiter, requireCsrf, async (req, res) => {
  const b = req.body ?? {}, { e, em, mob, c } = validate(b), s = (k) => String(b[k] ?? '').trim();
  if (!e.email && (await q('select 1 from users where email=$1', [em])).rowCount) e.email = 'This email is already registered.';
  if (!e.email) { const ce = await checkEmail(em); if (!ce.ok) e.email = ce.error; }
  if (!e.state && !e.city && !e.zip_code && c) { const a = await checkAddress({ country: s('country'), state: s('state'), city: s('city'), zip: s('zip_code') }); Object.assign(e, a.errors); }
  if (Object.keys(e).length) return res.status(400).json({ errors: e });
  const hash = await hashPassword(String(b.password)), raw = rnd(), cl = await db.connect();
  try {
    await cl.query('begin');
    const id = (await cl.query(`insert into users(first_name,last_name,middle_initial,birthday,password_hash,email,mobile_number)
      values($1,$2,$3,to_date($4,'MM/DD/YYYY'),$5,$6,$7) returning id`, [s('first_name'), s('last_name'), s('middle_initial') || null, s('birthday'), hash, em, c.prefix + mob])).rows[0].id;
    await cl.query('insert into addresses(user_id,house_street,country,city,state,zip_code) values($1,$2,$3,$4,$5,$6)', [id, s('house_street'), c.name, s('city'), s('state'), s('zip_code').toUpperCase()]);
    await cl.query(`insert into verification_tokens(user_id,token_hash,type,expired_at) values($1,$2,'email_verify',now()+interval '24 hours')`, [id, sha(raw)]);
    await cl.query('commit');
  } catch (err) {
    await cl.query('rollback');
    if (err.code === '23505') return res.status(400).json({ errors: { email: 'This email is already registered.' } });
    throw err;
  } finally { cl.release(); }
  try { await sendVerify(s('first_name'), em, raw); } catch (err) { console.error('verification email failed:', err.message); }
  res.json({ ok: true, email: em });
});

// Expired/lost verification link -> new 24h link (same response whether or not the email exists)
const resendLimiter = rateLimit({ windowMs: 36e5, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again in an hour.' } });
app.post('/api/resend-verification', resendLimiter, requireCsrf, async (req, res) => {
  const em = String(req.body?.email ?? '').trim().toLowerCase();
  const u = em && (await q('select id,first_name,email from users where email=$1 and email_verified_at is null', [em])).rows[0];
  if (u) {
    const raw = rnd();
    await q(`delete from verification_tokens where user_id=$1 and type='email_verify'`, [u.id]);
    await q(`insert into verification_tokens(user_id,token_hash,type,expired_at) values($1,$2,'email_verify',now()+interval '24 hours')`, [u.id, sha(raw)]);
    try { await sendVerify(u.first_name, u.email, raw); } catch (err) { console.error('verification email failed:', err.message); }
  }
  res.json({ ok: true });
});

app.get('/verify-email', async (req, res) => {
  const t = (await q(`select id,user_id from verification_tokens where type='email_verify' and token_hash=$1 and expired_at>now()`, [sha(String(req.query.token ?? ''))])).rows[0];
  if (!t) return res.redirect('/?verified=invalid');
  await q('update users set email_verified_at=now(), updated_at=now() where id=$1', [t.user_id]);
  await q('delete from verification_tokens where id=$1', [t.id]);
  res.cookie('pend', pendTok(t.user_id), { httpOnly: true, secure: PROD, sameSite: 'lax', maxAge: 30 * 60e3 });
  res.redirect('/?verified=ok');
});

// Login: generic errors, constant-ish timing, 3-strike lock + unlock email with 2-minute cooling period
app.post('/api/login', loginLimiter, requireCsrf, async (req, res) => {
  const em = String(req.body?.email ?? '').trim().toLowerCase(), pw = String(req.body?.password ?? '');
  if (!em || !pw || pw.length > 128) return res.status(400).json({ error: G });
  const u = (await q('select * from users where email=$1', [em])).rows[0];
  if (!u) {                                   // unknown email: behave EXACTLY like a real account (same counter, same messages)
    await verifyPassword(DUMMY, pw).catch(() => {});
    return res.status(401).json({ error: attemptMsg(ghostFail(em)) });
  }
  if (u.is_locked) {
    await verifyPassword(DUMMY, pw).catch(() => {});
    if (!(await q(`select 1 from verification_tokens where user_id=$1 and type='account_unlock' and expired_at>now()`, [u.id])).rowCount) await safeUnlock(u);
    return res.status(401).json({ error: attemptMsg(3) });
  }
  if (!(await verifyPassword(u.password_hash, pw).catch(() => false))) {
    const n = u.failed_login_attempts + 1;
    if (n >= 3) { await q(`update users set failed_login_attempts=$2,is_locked=true,lockout_until=now()+interval '2 minutes',updated_at=now() where id=$1`, [u.id, n]); await safeUnlock(u); }
    else await q('update users set failed_login_attempts=$2,updated_at=now() where id=$1', [u.id, n]);
    return res.status(401).json({ error: attemptMsg(n) });
  }
  // Only someone who knows the password learns the account is unverified (no email enumeration)
  if (!u.email_verified_at) return res.status(403).json({ error: 'Please verify your email address first (check your inbox).' });
  await q('update users set failed_login_attempts=0 where id=$1', [u.id]);
  const sid = rnd();
  await q(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '8 hours')`, [sha(sid), u.id]);
  res.cookie('sid', sid, { httpOnly: true, secure: PROD, sameSite: 'lax', maxAge: 8 * 36e5 });
  res.json({ ok: true });
});

app.get('/unlock', async (req, res) => {
  const t = (await q(`select t.id,t.user_id,u.lockout_until from verification_tokens t join users u on u.id=t.user_id where t.type='account_unlock' and t.token_hash=$1 and t.expired_at>now()`, [sha(String(req.query.token ?? ''))])).rows[0];
  if (!t) return res.redirect('/?unlock=invalid');
  const left = new Date(t.lockout_until).getTime() - Date.now();
  if (left > 0) return res.redirect(`/?unlock=wait&s=${Math.ceil(left / 1000)}`);        // 2-minute cooling period
  await q('update users set is_locked=false,failed_login_attempts=0,lockout_until=null where id=$1', [t.user_id]);
  await q('delete from verification_tokens where id=$1', [t.id]);
  res.redirect('/?unlock=ok');
});

// ---------- signed-in ----------
app.post('/api/logout', requireCsrf, async (req, res) => { if (req.cookies?.sid) await q('delete from sessions where token_hash=$1', [sha(req.cookies.sid)]); res.clearCookie('sid'); res.json({ ok: true }); });
app.get('/api/me', auth, async (req, res) => {
  const u = req.user, a = (await q('select * from addresses where user_id=$1 limit 1', [u.id])).rows[0] ?? {};
  res.json({ first_name: u.first_name, last_name: u.last_name, middle_initial: u.middle_initial, email: u.email, birthday: u.birthday.toISOString?.().slice(0, 10) ?? u.birthday,
    mobile_number: u.mobile_number, mobile_verified: u.mobile_verified, email_verified: !!u.email_verified_at, house_street: a.house_street, country: a.country, city: a.city, state: a.state, zip_code: a.zip_code });
});

// Mobile OTP: 6 digits, 5 min, 3 attempts then 15-minute lockout, resend only after 60 s
app.get('/api/otp/info', otpAuth, (req, res) => res.json({ mobile_verified: req.user.mobile_verified, phone: req.user.mobile_number.replace(/.(?=.{4})/g, '•') }));
app.post('/api/otp/resend', requireCsrf, otpAuth, async (req, res) => {
  const u = req.user;
  if (!u.email_verified_at) return res.status(403).json({ error: 'Verify your email first.' });
  if (u.mobile_verified) return res.json({ ok: true, done: true });
  const last = (await q(`select attempts,extract(epoch from now()-created_at) age from verification_tokens where user_id=$1 and type='mobile_otp' order by created_at desc limit 1`, [u.id])).rows[0];
  if (last?.attempts >= 3 && last.age < 900) return res.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil((900 - last.age) / 60)} minute(s).` });
  if (last && last.age < 60) return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code.' });
  const otp = String(crypto.randomInt(100000, 1000000));
  await q(`delete from verification_tokens where user_id=$1 and type='mobile_otp'`, [u.id]);
  await q(`insert into verification_tokens(user_id,token_hash,type,expired_at) values($1,$2,'mobile_otp',now()+interval '5 minutes')`, [u.id, hmacHex(otp + u.id)]);
  try { await sendSms(u.mobile_number, otp); } catch (err) { console.error(err); return res.status(502).json({ error: 'Could not send the SMS code. Please try again.' }); }
  res.json({ ok: true });
});
app.post('/api/otp/verify', requireCsrf, otpAuth, async (req, res) => {
  const u = req.user, code = String(req.body?.code ?? '');
  const t = (await q(`select id,token_hash,attempts from verification_tokens where user_id=$1 and type='mobile_otp' and expired_at>now() order by created_at desc limit 1`, [u.id])).rows[0];
  if (!t) return res.status(400).json({ error: 'Code expired. Request a new one.' });
  if (t.attempts >= 3) return res.status(429).json({ error: 'Too many attempts. Locked for 15 minutes from when the code was sent.' });
  const n = (await q('update verification_tokens set attempts=attempts+1 where id=$1 returning attempts', [t.id])).rows[0].attempts;   // count first: no race
  const a = Buffer.from(hmacHex(code + u.id)), b = Buffer.from(t.token_hash);
  if (!/^\d{6}$/.test(code) || a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(400).json({ error: n >= 3 ? 'Too many attempts. Locked for 15 minutes from when the code was sent.' : `Incorrect code. ${3 - n} attempt(s) left.` });
  await q('update users set mobile_verified=true, updated_at=now() where id=$1', [u.id]);
  await q('delete from verification_tokens where id=$1', [t.id]);
  res.clearCookie('pend');
  res.json({ ok: true });
});

// ---------- verified-only ----------
app.get('/api/users', auth, verified, async (_req, res) => {
  const { rows } = await q('select first_name,last_name,email,email_verified_at,mobile_verified from users order by created_at desc limit 100');
  res.json(rows.map((u) => ({ name: `${u.first_name} ${u.last_name}`, email: u.email.replace(/^(.).*(@.*)$/, '$1***$2'), email_ok: !!u.email_verified_at, mobile_ok: !!u.mobile_verified })));
});

const cache = new Map();
app.get('/api/holidays/:year', auth, verified, async (req, res) => {   // async fetch of the official holiday dataset for ONE year (2020-2027)
  const y = Number(req.params.year); if (!Number.isInteger(y) || y < 2020 || y > 2027) return res.status(400).json({ error: 'Year must be 2020-2027.' });
  if (!cache.has(y)) {
    try {
      const x = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/PH`, { signal: AbortSignal.timeout(8000) });
      const raw = x.ok ? await x.json() : null;
      if (!Array.isArray(raw) || !raw.length) throw new Error('empty');
      cache.set(y, withIslamic(y, raw.map((h) => ({ date: h.date, name: h.name, local: h.localName, type: classify(h.name, h.localName, h.date) }))));   // adds Eid'l Fitr/Adha etc. when the provider omits them
    } catch { return res.status(502).json({ error: 'Holiday service unavailable. Try again shortly.' }); }   // failures are never cached
  }
  res.json(cache.get(y));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error. Please try again.' }); });

// ---------- start: i. TLS 1.3 ----------
console.log('Email:', mode().email, '| SMS:', mode().sms);
// Friendly startup check: the most common first-run problem is PostgreSQL not running (ECONNREFUSED :5432).
try { await q('select 1'); console.log('Database: connected'); }
catch (err) {
  const code = err.code || err.errors?.[0]?.code || err.message;
  console.error(`\n!!  Cannot reach PostgreSQL (${code}). Registration and login will fail until it is running.\n    1) Start it: "docker compose up -d" (Docker Desktop must be open), or start your local PostgreSQL service, or use a Neon connection string.\n    2) Make sure DATABASE_URL in .env matches it, then run "npm run db" once to create the tables.\n`);
}
if (PROD && /CONSOLE/.test(mode().email + mode().sms)) console.warn('WARNING: production without a real email/SMS provider. Users will never receive links or codes.');
const port = +(E.PORT ?? 3000);
if (E.TLS_KEY && E.TLS_CERT)
  https.createServer({ key: fs.readFileSync(E.TLS_KEY), cert: fs.readFileSync(E.TLS_CERT), minVersion: 'TLSv1.3' }, app).listen(port, () => console.log(`HTTPS (TLS 1.3 only) on :${port}`));
else app.listen(port, () => console.log(`HTTP on :${port}` + (PROD ? ' (behind a proxy: enforce TLS 1.3 there)' : ' (dev)')));