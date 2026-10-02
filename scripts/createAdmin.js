/**
 * Creates the initial admin user. Server-side only; there is no HTTP equivalent.
 *
 * Interactive:      npm run admin:create
 * With email flag:  npm run admin:create -- --email you@company.com
 * Non-interactive:  ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run admin:create
 */
import { stdin, stdout } from 'node:process';
import readline from 'node:readline';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { AdminUser } from '../src/models/adminUser.model.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/utils/password.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const readFlag = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const ask = (question, { hidden = false } = {}) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    if (hidden) {
      // Readline redraws the prompt together with typed characters, so silence it entirely.
      stdout.write(question);
      rl._writeToOutput = () => {};
    }
    rl.question(hidden ? '' : question, (answer) => {
      rl.close();
      if (hidden) stdout.write('\n');
      resolve(answer);
    });
  });

const promptPassword = async () => {
  const password = await ask(`Password (min ${MIN_PASSWORD_LENGTH} chars): `, { hidden: true });
  const confirmation = await ask('Confirm password: ', { hidden: true });
  if (password !== confirmation) throw new Error('Passwords do not match.');
  return password;
};

const main = async () => {
  const email = (readFlag('email') ?? process.env.ADMIN_EMAIL ?? (await ask('Admin email: ')))
    .trim()
    .toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error('A valid email address is required.');

  const password = process.env.ADMIN_PASSWORD ?? (await promptPassword());
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  await connectDB();

  if (await AdminUser.exists({ email })) {
    throw new Error(`An admin with email ${email} already exists. Refusing to overwrite it.`);
  }

  await AdminUser.create({ email, passwordHash: await hashPassword(password), role: 'admin' });
  console.log(`Admin created: ${email}`);
};

main()
  .then(() => disconnectDB())
  .catch(async (err) => {
    console.error(`Failed to create admin: ${err.message}`);
    await disconnectDB();
    process.exitCode = 1;
  });
