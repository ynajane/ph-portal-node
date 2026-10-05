# PH Portal (Node.js + Express + PostgreSQL)

## Run locally
```
npm install
cp .env.example .env          # set DATABASE_URL and CSRF_SECRET (openssl rand -hex 32)
npm run db                    # creates the tables (see Database below)
npm start                     # http://localhost:3000
```
With no SMTP / PhilSMS keys set, verification emails, unlock links and OTP codes are **printed in the terminal**, which is enough for testing.

## Security requirements: where each one lives
| Requirement | Where |
|---|---|
| i. HTTPS / TLS 1.3 | `server.js` bottom: `minVersion: 'TLSv1.3'` (if you set `TLS_KEY`/`TLS_CERT`). Behind a proxy, set it there: Nginx `ssl_protocols TLSv1.3;`, or Cloudflare > SSL/TLS > Edge Certificates > Minimum TLS Version 1.3. Also: HSTS + HTTP->HTTPS redirect in production. |
| ii. Argon2id | `security.js` `hashPassword` (64 MiB, 3 passes) |
| iii. 5 registrations / IP / hour | `security.js` `registerLimiter` (+ `trust proxy` in `server.js`) |
| iv. CSRF | `security.js` `issueCsrf` / `requireCsrf` (signed double-submit, applied to every POST) |

## Prove TLS 1.3 on your deployed domain
```
openssl s_client -connect yourdomain.com:443 -tls1_2   # must FAIL
openssl s_client -connect yourdomain.com:443 -tls1_3   # must succeed
```
localhost over plain HTTP can't demonstrate this; deploy first.

## Production checklist
- `NODE_ENV=production`, `SITE_URL=https://yourdomain.com`
- Real SMTP (Brevo, Resend SMTP, ...) and a PhilSMS token + approved sender ID
- PhilSMS only delivers to PH numbers; other countries need a second SMS provider
- Memory-based rate limiter resets on restart and is per-instance; use `rate-limit-redis` if you run several instances

## Behaviour notes
- Unverified accounts can't log in; only someone who knows the password is told to verify (no enumeration).
- Login: 3 wrong passwords lock the account and email an unlock link that works only after 2 minutes.
- OTP: 6 digits, 5 min, 3 wrong tries = 15-minute lockout (resend can't reset it), resend after 60 s.
- Holiday Regular/Special labels are inferred from names (Nager.Date has no such field); verify 2026-2027 against official proclamations.

## Database
Pick one, then set `DATABASE_URL` in `.env` and run `npm run db` (creates the 4 tables from `database/schema.sql`; safe to re-run):
- **Docker (easiest):** `docker compose up -d`, then `DATABASE_URL=postgres://portal:portal@localhost:5432/phportal`
- **Free hosted (no install):** create a project on neon.tech, copy its connection string.
- **Installed PostgreSQL 13+:** `createdb phportal`, then `DATABASE_URL=postgres://USER:PASS@localhost:5432/phportal`
Tables: `users`, `addresses`, `verification_tokens` (as in the requirements PDF) plus `sessions`. RLS is enabled on all of them with no policies.

## Making email + SMS really send
1. **Email with your Gmail:** Google Account > Security > turn on **2-Step Verification**, then myaccount.google.com/apppasswords > create an app password. In `.env`: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=you@gmail.com`, `SMTP_PASS=<16-char app password, no spaces>`, `MAIL_FROM="PH Portal <you@gmail.com>"`. Personal Gmail allows about 500 recipients/day. (Brevo is optional: set `BREVO_API_KEY` only if your host blocks SMTP.)
2. **SMS (PhilSMS):** app.philsms.com > Developers > copy the API token into `PHILSMS_API_TOKEN`; keep `PHILSMS_SENDER_ID=PhilSMS` until your own sender ID is approved. Load credits first.
3. **Test delivery first:** `npm run test:email -- you@gmail.com` and `npm run test:sms -- 9171234567`.
4. **`SITE_URL` must open from the user's device.** Emailed links use it. `http://localhost:3000` only works on your own computer; for a phone use your deployed HTTPS URL or a tunnel (`cloudflared tunnel --url http://localhost:3000`) and set `SITE_URL` to it.
5. Startup prints `Email: ... | SMS: ...`. If it says CONSOLE ONLY, nothing is really being sent.
