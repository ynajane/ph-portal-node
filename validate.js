// Same rules the browser runs; the server never trusts the browser.
// mob = national number WITHOUT the +prefix and WITHOUT the trunk "0" (trunk:true => a leading 0 typed by the user is dropped).
// Patterns follow each country's mobile numbering plan; ex = example shown as the placeholder.
export const CO = {
  PH: { name: 'Philippines', prefix: '+63', zip: /^\d{4}$/, mob: /^9\d{9}$/, trunk: true, ex: '9171234567' },
  US: { name: 'United States', prefix: '+1', zip: /^\d{5}(-\d{4})?$/, mob: /^[2-9]\d{2}[2-9]\d{6}$/, ex: '2025550123' },
  GB: { name: 'United Kingdom', prefix: '+44', zip: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i, mob: /^7[1-57-9]\d{8}$/, trunk: true, ex: '7912345678' },
  CA: { name: 'Canada', prefix: '+1', zip: /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/, mob: /^[2-9]\d{2}[2-9]\d{6}$/, ex: '4165550123' },
  AU: { name: 'Australia', prefix: '+61', zip: /^\d{4}$/, mob: /^4\d{8}$/, trunk: true, ex: '412345678' },
  SG: { name: 'Singapore', prefix: '+65', zip: /^\d{6}$/, mob: /^[89]\d{7}$/, ex: '81234567' },
};
import { PUBLIC } from './domains.js';
import { countryInfo, checkMobile } from './geo.js';
export { PUBLIC };

export function validate(b) {
  const e = {}, s = (k) => String(b[k] ?? '').trim();
  for (const k of ['first_name', 'last_name']) if (!/^(?=.*\p{L})[\p{L}\p{M}'’ -]{2,50}$/u.test(s(k))) e[k] = '2-50 letters, spaces, hyphens or apostrophes only.';
  if (s('middle_initial') && !/^[\p{L}]\.?$/u.test(s('middle_initial'))) e.middle_initial = 'Use one letter, optionally followed by a period (A or A.).';
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s('birthday'));
  if (!m) e.birthday = 'Use MM/DD/YYYY.';
  else {
    const [, mo, d, y] = m.map(Number), dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1900) e.birthday = 'Enter a real calendar date.';
    else { const t = new Date(); if (dt > new Date(Date.UTC(t.getUTCFullYear() - 13, t.getUTCMonth(), t.getUTCDate()))) e.birthday = 'You must be at least 13 years old.'; }
  }
  const p = String(b.password ?? '');
  if (p.length < 12 || p.length > 128 || !/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/\d/.test(p) || !/[^A-Za-z0-9]/.test(p)) e.password = '12+ characters with upper, lower, number and special character.';
  if (p !== String(b.confirm_password ?? '')) e.confirm_password = 'Passwords do not match.';
  if (!/^[\p{L}0-9 .,#'’\/-]{3,255}$/u.test(s('house_street'))) e.house_street = 'Enter a valid house number and street.';
  const ci = countryInfo(s('country')), c = ci && { name: ci.name, prefix: ci.dial }; if (!ci) e.country = 'Select a country.';
  for (const k of ['city', 'state']) if (!/^[\p{L}\p{M}0-9 .,'’()\/&-]{2,100}$/u.test(s(k))) e[k] = 'Enter a valid name (2-100 characters).';
  if (ci && !new RegExp(ci.zipFormat, ci.zipFlags).test(s('zip_code'))) e.zip_code = `Invalid ZIP/postal code for ${c.name}.`;
  const em = s('email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 255) e.email = 'Enter a valid email address.';
  else if (!PUBLIC.has(em.split('@')[1])) e.email = 'Only public email providers (Gmail, Outlook, Yahoo, iCloud...) are allowed.';
  let mob = ''; if (ci) { const m = checkMobile(ci.code, s('mobile')); if (m.ok) mob = m.national; else e.mobile = m.error; }
  return { e, em, mob, c };
}