import freeDomains from 'free-email-domains';
// ~14,000 known public/free mail providers (Gmail, Outlook, Yahoo, Rocketmail, iCloud, Proton, ...). Anything else = custom/corporate = blocked.
// Add your own with EXTRA_PUBLIC_DOMAINS=a.com,b.com in .env
export const PUBLIC = new Set([...freeDomains, ...String(process.env.EXTRA_PUBLIC_DOMAINS ?? '').toLowerCase().split(',').map((d) => d.trim()).filter(Boolean)]);
