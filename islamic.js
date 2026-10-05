// Islamic holidays for the Philippines.
// Why this exists: Eid'l Fitr / Eid'l Adha follow the moon sighting, so holiday providers (Nager.Date) often leave them out.
// If the provider already returned one, it is kept; otherwise it is computed here from the Islamic (Umm al-Qura) calendar.
// Computed dates are PROVISIONAL (the PH government/NCMF may declare a day earlier or later).
// To use the official proclaimed date, put it in data/islamic-dates.json, e.g. { "2026": { "eid_fitr": "2026-03-20" } }  (keys: eid_fitr, eid_adha)
import fs from 'node:fs';

const KINDS = [
  { key: 'eid_fitr', m: 10, d: 1, name: "Eid'l Fitr (Feast of Ramadan)", local: 'Eidul Fitr', seen: /fitr/i },
  { key: 'eid_adha', m: 12, d: 10, name: "Eid'l Adha (Feast of Sacrifice)", local: 'Eidul Adha', seen: /adha/i },
];
const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });

let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(new URL('./data/islamic-dates.json', import.meta.url), 'utf8')); } catch { /* optional file */ }

function computed(year) {
  const out = [];
  for (let t = Date.UTC(year, 0, 1, 12); t < Date.UTC(year + 1, 0, 1, 12); t += 864e5) {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    for (const k of KINDS) if (+p.month === k.m && +p.day === k.d) out.push({ k, date: new Date(t).toISOString().slice(0, 10) });
  }
  return out;
}

export function withIslamic(year, list) {
  const have = (k) => list.some((h) => k.seen.test(`${h.name} ${h.local}`));
  const extra = [];
  for (const { k, date } of computed(year)) {
    if (have(k)) continue;                                   // provider already supplied it -> trust the provider
    const o = overrides?.[year]?.[k.key];
    extra.push({ date: o ?? date, name: k.name, local: k.local, type: 'Islamic Holiday', provisional: !o });
  }
  return [...list, ...extra].sort((a, b) => a.date.localeCompare(b.date));
}