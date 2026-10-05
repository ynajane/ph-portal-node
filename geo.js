// Location + contact validation APIs (mounted at /api/geo and /api/check in server.js).
// Data: country-state-city (offline), libphonenumber-js (mobile), zippopotam.us (optional ZIP lookup, server-side only).
import { Router } from 'express';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { Country, State, City } from 'country-state-city';
import { parsePhoneNumberFromString, getCountryCallingCode } from 'libphonenumber-js/max';
import { PUBLIC } from './domains.js';

// Postal-code formats. Countries not listed here fall back to a loose 3-10 char check.
const ZIP = {
  PH: /^\d{4}$/, US: /^\d{5}(-\d{4})?$/, CA: /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/, GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i,
  AU: /^\d{4}$/, NZ: /^\d{4}$/, SG: /^\d{6}$/, MY: /^\d{5}$/, ID: /^\d{5}$/, TH: /^\d{5}$/, VN: /^\d{6}$/, JP: /^\d{3}-?\d{4}$/,
  KR: /^\d{5}$/, CN: /^\d{6}$/, IN: /^[1-9]\d{5}$/, DE: /^\d{5}$/, FR: /^\d{5}$/, ES: /^\d{5}$/, IT: /^\d{5}$/, NL: /^\d{4} ?[A-Za-z]{2}$/,
  BE: /^\d{4}$/, CH: /^\d{4}$/, AT: /^\d{4}$/, SE: /^\d{3} ?\d{2}$/, NO: /^\d{4}$/, DK: /^\d{4}$/, FI: /^\d{5}$/, IE: /^[A-Za-z]\d{2} ?[A-Za-z\d]{4}$/,
  PT: /^\d{4}-\d{3}$/, BR: /^\d{5}-?\d{3}$/, MX: /^\d{5}$/, AE: null, SA: /^\d{5}$/, ZA: /^\d{4}$/, HK: null,
};
const LOOSE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/;

const norm = (s = '') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\b(city of|city|province of|province|municipality of|region|state of)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const same = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };

const fold = (s = '') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const rank = (n, q) => { n = fold(n); return n.startsWith(q) ? 0 : n.split(/[ -]/).some((w) => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : 9; };
const search = (list, q, get = (x) => x) => { q = fold(q); return !q ? list : list.filter((x) => rank(get(x), q) < 9).sort((a, b) => rank(get(a), q) - rank(get(b), q) || get(a).localeCompare(get(b))); };
const cc = (c) => String(c ?? '').toUpperCase();
export const countryInfo = (code) => {
  const c = Country.getCountryByCode(cc(code)); if (!c) return null;
  let dial; try { dial = '+' + getCountryCallingCode(c.isoCode); } catch { dial = '+' + String(c.phonecode).split('-')[0].replace(/\D/g, ''); }
  return { code: c.isoCode, name: c.name, dial, flag: c.flag, zipFormat: (ZIP[c.isoCode] ?? LOOSE).source, zipFlags: (ZIP[c.isoCode] ?? LOOSE).flags };
};
const states = (code) => State.getStatesOfCountry(cc(code));
const findState = (code, v) => states(code).find((s) => s.isoCode.toLowerCase() === String(v).toLowerCase() || same(s.name, v));
const hasCity = (code, name, stateCode) => {
  const all = stateCode ? City.getCitiesOfState(cc(code), stateCode) : City.getCitiesOfCountry(cc(code)) ?? [];
  return all.some((c) => same(c.name, name));
};

// ---- Philippines: official PHLPost ZIP list bundled in data/ph-zip.json (offline). A ZIP names a barangay/district, NOT the city: 1428 = "Bagong Silang" (Caloocan, Metro Manila).
const PHZ = new Map();
try { for (const x of JSON.parse(fs.readFileSync(new URL('./data/ph-zip.json', import.meta.url), 'utf8'))) (PHZ.get(x.z) ?? PHZ.set(x.z, []).get(x.z)).push({ city: x.a, state: x.p, region: x.r }); } catch { /* file missing -> falls back to format-only */ }

// ---- other countries: api.zippopotam.us, cached; failure never blocks the user ----
const cache = new Map();
async function zipLookup(code, zip) {
  if (cc(code) === 'PH') return PHZ.get(zip) ?? null;   // unknown to our list = unknown, not invalid
  if (process.env.ZIP_LOOKUP === 'off') return null;
  const k = `${cc(code)}:${zip}`; if (cache.has(k)) return cache.get(k);
  let out = null;
  try {
    const r = await fetch(`https://api.zippopotam.us/${cc(code).toLowerCase()}/${encodeURIComponent(zip.split(' ')[0])}`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { const j = await r.json(); out = (j.places ?? []).map((p) => ({ city: p['place name'], state: p.state })); }
    else if (r.status === 404) out = [];        // zip does not exist
  } catch { out = null; }                       // lookup service down -> unknown
  if (out !== null) { if (cache.size > 5000) cache.delete(cache.keys().next().value); cache.set(k, out); }
  return out;
}

// ---- checks (also used by /api/register) ----
export function checkMobile(country, mobile) {
  const c = countryInfo(country); if (!c) return { ok: false, error: 'Select a country first.' };
  const p = parsePhoneNumberFromString(String(mobile ?? ''), c.code);   // handles trunk "0" and typed +prefix
  if (!p || p.country !== c.code && !(p.countryCallingCode === c.dial.slice(1)) || !p.isValid()) return { ok: false, dial: c.dial, error: `Invalid ${c.name} mobile number.` };
  const t = p.getType();
  if (t && !['MOBILE', 'FIXED_LINE_OR_MOBILE'].includes(t)) return { ok: false, dial: c.dial, error: `That is not a ${c.name} mobile number.` };
  return { ok: true, dial: c.dial, e164: p.number, national: p.nationalNumber, example: undefined };
}

// MX/DNS lookup is OFF by default (it can fail on restricted networks). Turn on with EMAIL_MX_CHECK=on in .env.
export async function checkEmail(email, { mx = process.env.EMAIL_MX_CHECK === 'on' } = {}) {
  const em = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 255) return { ok: false, error: 'Enter a valid email address.' };
  const domain = em.split('@')[1];
  if (!PUBLIC.has(domain)) return { ok: false, domain, error: 'Only public email providers (Gmail, Outlook, Yahoo, iCloud...) are allowed.' };
  if (mx) { try { if (!(await dns.resolveMx(domain)).length) throw 0; } catch { return { ok: false, domain, error: 'That email domain cannot receive mail.' }; } }
  return { ok: true, email: em, domain };
}

export async function checkAddress({ country, state, city, zip }) {
  const c = countryInfo(country), errors = {}; const out = { ok: false, errors, zipVerified: false };
  if (!c) return { ...out, errors: { country: 'Select a country.' } };
  const z = String(zip ?? '').trim();
  if (!(ZIP[c.code] ?? LOOSE).test(z)) errors.zip_code = `Invalid ZIP/postal code for ${c.name}.`;
  const sl = states(c.code), st = sl.length ? findState(c.code, state) : null;
  if (sl.length && !st) errors.state = `"${state}" is not a state/province of ${c.name}.`;
  const warnings = [];
  if (!errors.zip_code) {
    const places = await zipLookup(c.code, z);
    if (!places?.length) warnings.push(`We could not confirm ZIP ${z} in our records; format is valid so it was accepted.`);
    else {
      out.zipVerified = true; out.zipPlaces = places;
      // A ZIP is a postal zone (barangay/district), so compare against place, province AND region; fail only if NOTHING relates.
      const hit = places.some((p) => [city, state, st?.name].some((v) => same(p.city, v) || same(p.state, v) || same(p.region, v)));
      if (!hit) errors.zip_code = `ZIP ${z} is for ${places[0].city}, ${places[0].state ?? c.name}, which does not match your ${city ? `city (${city}) or ` : ''}state/province.`;
    }
  }
  if (city && !errors.state && !hasCity(c.code, city, null)) warnings.push(`"${city}" is not in our city list; double-check the spelling.`);
  out.warnings = warnings;
  return { ...out, ok: !Object.keys(errors).length, errors, state: st?.name ?? state, stateCode: st?.isoCode };
}

// ---- routes ----
export const geo = Router();
geo.get('/countries', (q, r) => r.json(search(Country.getAllCountries().map((c) => countryInfo(c.isoCode)).filter(Boolean), q.query.q, (c) => c.name)));   // ?q=p -> Philippines, Pakistan, ... (type-ahead)
geo.get('/countries/:code', (q, r) => { const c = countryInfo(q.params.code); c ? r.json(c) : r.status(404).json({ error: 'Unknown country.' }); });
geo.get('/states', (q, r) => {
  if (!countryInfo(q.query.country)) return r.status(400).json({ error: 'Valid ?country=XX required.' });
  r.json(search(states(q.query.country).map((s) => ({ code: s.isoCode, name: s.name })), q.query.q, (s) => s.name));
});
geo.get('/cities', (q, r) => {
  const { country, state } = q.query; if (!countryInfo(country)) return r.status(400).json({ error: 'Valid ?country=XX required.' });
  const s = state ? findState(country, state) : null;
  let L = (s ? City.getCitiesOfState(cc(country), s.isoCode) : null) ?? [];
  if (!L.length) L = City.getCitiesOfCountry(cc(country)) ?? [];       // dataset has no cities filed under this state -> fall back to the whole country
  const names = [...new Set(L.map((c) => c.name))].sort((a, b) => a.localeCompare(b));
  r.json(search(names, q.query.q).slice(0, 100));
});
geo.get('/zip', async (q, r) => {                       // ZIP -> city/state (for auto-fill)
  const { country, zip } = q.query; const c = countryInfo(country); if (!c || !zip) return r.status(400).json({ error: '?country=XX&zip=... required.' });
  const formatOk = (ZIP[c.code] ?? LOOSE).test(String(zip).trim()), places = formatOk ? await zipLookup(c.code, String(zip).trim()) : [];
  r.json({ formatOk, found: !!places?.length, lookupAvailable: places !== null, places: places ?? [] });
});
geo.post('/validate', async (q, r) => r.json(await checkAddress(q.body ?? {})));   // country+state+city+zip match

export const check = Router();
check.post('/mobile', (q, r) => r.json(checkMobile(q.body?.country, q.body?.mobile)));
check.post('/email', async (q, r) => r.json(await checkEmail(q.body?.email)));