// The four "Security Requirements" in one place: Argon2id, 5/IP/hour, CSRF. (TLS 1.3 is in server.js / README.)
import crypto from 'node:crypto';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';

const SECRET = process.env.CSRF_SECRET;
if (!SECRET || SECRET.length < 32) throw new Error('Set CSRF_SECRET (openssl rand -hex 32) in .env');

export const hmacHex = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ii. Password hashing: Argon2id, 64 MiB memory, 3 passes
export const hashPassword = (pw) => argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export const verifyPassword = (hash, pw) => argon2.verify(hash, pw);

// iii. Rate limiting: max 5 registration requests per IP per hour (server.js sets trust proxy for the real IP)
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again in an hour.' },
});

// iv. CSRF: signed double-submit token (cookie + header must match, and signature must verify)
export function issueCsrf(req, res) {
  const raw = crypto.randomBytes(32).toString('hex'), token = `${raw}.${hmacHex(raw)}`;
  res.cookie('csrf', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 36e5 });
  res.json({ csrf: token });
}
export function requireCsrf(req, res, next) {
  const h = req.get('x-csrf-token') ?? '', c = req.cookies?.csrf ?? '', [raw, sig] = h.split('.');
  if (!h || !raw || !sig || !safeEq(h, c) || !safeEq(sig, hmacHex(raw))) return res.status(403).json({ error: 'Invalid CSRF token.' });
  next();
}
