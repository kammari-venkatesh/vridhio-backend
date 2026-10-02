import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;
export const MIN_PASSWORD_LENGTH = 12;

export const hashPassword = (plain) => bcrypt.hash(plain, SALT_ROUNDS);

export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Compared against when the email is unknown so response timing doesn't reveal which emails exist.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', SALT_ROUNDS);
