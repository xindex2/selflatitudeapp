import { one, run } from './db.js';
import { config } from '../config.js';
import { hashPassword, newId } from '../lib/crypto.js';
import { migrate } from './migrate.js';

/**
 * Create the first Super Admin from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD
 * if no superadmin exists yet. MFA must then be enabled from the Settings page
 * before the Super Admin area unlocks.
 */
export async function bootstrapAdmin() {
  const existing = one("SELECT id FROM users WHERE role = 'superadmin' AND status != 'deleted'");
  if (existing) return;
  const { adminEmail, adminPassword } = config.bootstrap;
  if (!adminEmail || !adminPassword) {
    console.warn('No Super Admin exists. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD to create one.');
    return;
  }
  const id = newId('usr');
  run(
    `INSERT INTO users (id, email, name, password_hash, role, status, companion_start, must_change_password, onboarding_completed)
     VALUES (?, ?, 'Owner', ?, 'superadmin', 'active', date('now'), 0, 1)`,
    id, adminEmail.toLowerCase(), await hashPassword(adminPassword),
  );
  console.log(`Created Super Admin ${adminEmail}. Sign in and enable MFA in Settings to unlock user management.`);
}

/** Dev seed: a demo student with companion access. `npm run seed` */
export async function seedDemo() {
  if (one('SELECT id FROM users WHERE email = ?', 'student@example.com')) return;
  const start = new Date();
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  run(
    `INSERT INTO users (id, email, name, password_hash, role, status, companion_start, companion_end)
     VALUES (?, 'student@example.com', 'Demo Student', ?, 'student', 'active', ?, ?)`,
    newId('usr'), await hashPassword('student-demo-pass'), start.toISOString().slice(0, 10), end.toISOString().slice(0, 10),
  );
  console.log('Seeded demo student: student@example.com / student-demo-pass');
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  migrate();
  await bootstrapAdmin();
  await seedDemo();
}
