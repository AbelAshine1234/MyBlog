require('dotenv').config();
const { sendMail } = require('../email');

async function main() {
  const [to, subjectArg, bodyArg] = process.argv.slice(2);
  const subject = subjectArg || 'abelashine test email';
  const body = bodyArg || 'This is a test email from abelashine.';
  if (!to) {
    console.error('Usage: node scripts/send_test_email.js <toEmail> [subject] [body]');
    process.exit(1);
  }
  const ok = await sendMail({ to, subject, text: body, html: `<p>${body}</p>` });
  if (!ok) process.exit(2);
}

main();


