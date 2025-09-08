const bcrypt = require('bcryptjs');
const { getDb, run } = require('../db');

async function main() {
  const [emailArg, passwordArg] = process.argv.slice(2);
  const email = (emailArg || '').trim().toLowerCase();
  const password = (passwordArg || '').trim();
  if (!email || !password) {
    console.error('Usage: node scripts/create_admin.js <email> <password>');
    process.exit(1);
  }
  const db = getDb();
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    await run(db, 'INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash]);
    console.log(`Admin created: ${email}`);
  } catch (e) {
    if (e && e.message && e.message.includes('UNIQUE')) {
      console.log('User already exists. Updating password...');
      await run(db, 'UPDATE users SET password_hash = ? WHERE email = ?', [passwordHash, email]);
      console.log(`Password updated for: ${email}`);
    } else {
      console.error('Failed to create admin:', e);
      process.exit(1);
    }
  }
  process.exit(0);
}

main();


