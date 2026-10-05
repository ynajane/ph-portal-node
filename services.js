import nodemailer from 'nodemailer';
const E = process.env, APP = E.APP_NAME ?? 'Activity #2';
const smtp = E.SMTP_HOST ? nodemailer.createTransport({ host: E.SMTP_HOST, port: +(E.SMTP_PORT ?? 587), secure: +(E.SMTP_PORT ?? 587) === 465, auth: { user: E.SMTP_USER, pass: E.SMTP_PASS } }) : null;
const parseFrom = (f = '') => { const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(f); return m ? { name: m[1].trim() || APP, email: m[2].trim() } : { name: APP, email: f.trim() }; };

export const mode = () => ({
  email: E.BREVO_API_KEY ? 'Brevo HTTP API' : smtp ? `SMTP (${E.SMTP_HOST})` : 'CONSOLE ONLY (nothing is really sent)',
  sms: E.PHILSMS_API_TOKEN ? 'PhilSMS' : 'CONSOLE ONLY (nothing is really sent)',
});

export async function sendMail(to, subject, text, html) {
  if (E.BREVO_API_KEY) {                       // HTTPS API: works on hosts that block SMTP ports (Render, etc.)
    const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST',
      headers: { 'api-key': E.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: parseFrom(E.MAIL_FROM), to: [{ email: to }], subject, textContent: text, ...(html && { htmlContent: html }) }) });
    if (!r.ok) throw new Error('Brevo API ' + r.status + ' ' + (await r.text()));
    return;
  }
  if (!smtp) return console.log(`\n[EMAIL to ${to}] ${subject}\n${text}\n`);
  await smtp.sendMail({ from: E.MAIL_FROM, to, subject, text, html });
}

const TZ = [['+63', 'Asia/Manila'], ['+65', 'Asia/Singapore'], ['+61', 'Australia/Sydney'], ['+44', 'Europe/London'], ['+1', 'America/New_York']];
export async function sendSms(phone, otp) {
  const tz = TZ.find(([p]) => phone.startsWith(p))?.[1] ?? 'UTC';
  const time = new Date().toLocaleString('en-PH', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
  const message = `${APP}: your code is ${otp}. Valid for 5 minutes. Sent ${time} (${tz}). Do not share it.`;
  if (!E.PHILSMS_API_TOKEN) return console.log(`\n[SMS to ${phone}] ${message}\n`);
  const r = await fetch(E.PHILSMS_URL ?? 'https://app.philsms.com/api/v3/sms/send', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${E.PHILSMS_API_TOKEN.trim()}` },
    body: JSON.stringify({ recipient: phone.replace('+', ''), sender_id: E.PHILSMS_SENDER_ID || 'PhilSMS', type: 'plain', message }) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || out.status === 'error') throw new Error(`PhilSMS ${r.status}: ${out.message ?? JSON.stringify(out)}`);
}