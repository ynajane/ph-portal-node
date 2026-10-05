// Prove real delivery BEFORE using the registration form:
//   npm run test:email -- you@gmail.com
//   npm run test:sms   -- 9171234567        (PH mobile, without +63)
import 'dotenv/config';
import { sendMail, sendSms, mode } from '../services.js';
const [kind, target] = process.argv.slice(2);
console.log('Active mode:', mode());
try {
  if (kind === 'email' && target) { await sendMail(target, 'Activity #2 test email', 'If you can read this, email delivery works.', '<p>If you can read this, <b>email delivery works</b>.</p>'); console.log('Email handed to provider. Check the inbox AND spam.'); }
  else if (kind === 'sms' && target) { await sendSms('+63' + target.replace(/\D/g, '').replace(/^0|^63/, ''), '123456'); console.log('SMS handed to provider. It should arrive within a minute.'); }
  else console.log('Usage: node scripts/test-send.js email you@gmail.com | sms 9171234567');
} catch (e) { console.error('FAILED:', e.message); process.exit(1); }