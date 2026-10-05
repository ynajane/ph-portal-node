// Classifies a Philippine holiday into the three categories the portal shows.
// Does NOT rely on one provider's English wording: it checks name + local name, and uses the fixed calendar date for the fixed-date holidays.
const ISLAMIC = /\beid\b|\beid[ '’-]?(l|ul|al)\b|fitr|adha|amun jadid|mawlid|maulid|isra|mi['’]?raj|islamic|muslim/i;
const MOVABLE_REGULAR = /maundy|holy thursday|huwebes santo|good friday|biyernes santo|national heroes|araw ng mga bayani/i;
// Regular holidays with a fixed date (RA 9492 / proclamations): Jan 1, Apr 9 (Araw ng Kagitingan), May 1, Jun 12, Nov 30, Dec 25, Dec 30
const FIXED_REGULAR = new Set(['01-01', '04-09', '05-01', '06-12', '11-30', '12-25', '12-30']);

export function classify(name = '', local = '', date = '') {
  const t = `${name} ${local}`, md = String(date).slice(5, 10);
  if (ISLAMIC.test(t)) return 'Islamic Holiday';
  if (FIXED_REGULAR.has(md) || MOVABLE_REGULAR.test(t)) return 'Regular Holiday';
  const d = new Date(`${date}T00:00:00Z`);                       // National Heroes Day = last Monday of August, whatever the provider calls it
  if (!Number.isNaN(+d) && d.getUTCMonth() === 7 && d.getUTCDay() === 1 && d.getUTCDate() >= 25) return 'Regular Holiday';
  return 'Special Non-Working Day';                               // Lunar New Year, Black Saturday, Ninoy Aquino, All Saints/Souls, Immaculate Conception, Christmas Eve, New Year's Eve ...
}
