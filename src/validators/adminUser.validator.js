import { MIN_PASSWORD_LENGTH } from '../utils/password.js';

export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isPlainObject = (body) => body !== null && typeof body === 'object' && !Array.isArray(body);

const unknownFields = (body, allowed) =>
  Object.fromEntries(Object.keys(body).filter((k) => !allowed.includes(k)).map((k) => [k, 'This field is not allowed.']));

const passwordError = (password) => {
  if (typeof password !== 'string' || !password) return 'Password is required.';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (!password.trim()) return 'Password cannot be only spaces.';
  return null;
};

/** New admin: email + password only. Role, status and creator are set by the server. */
export const validateCreateAdmin = (body) => {
  if (!isPlainObject(body)) return { value: {}, errors: { body: 'Invalid request body.' }, isValid: false };
  const errors = unknownFields(body, ['email', 'password']);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address.';
  const pwError = passwordError(body.password);
  if (pwError) errors.password = pwError;
  return { value: { email, password: body.password }, errors, isValid: Object.keys(errors).length === 0 };
};

export const validateStatusChange = (body) => {
  if (!isPlainObject(body)) return { value: {}, errors: { body: 'Invalid request body.' }, isValid: false };
  const errors = unknownFields(body, ['disabled']);
  if (typeof body.disabled !== 'boolean') errors.disabled = 'disabled must be true or false.';
  return { value: { disabled: body.disabled }, errors, isValid: Object.keys(errors).length === 0 };
};

/** Password reset. `currentPassword` is required (and checked) only when changing your own password. */
export const validatePasswordChange = (body) => {
  if (!isPlainObject(body)) return { value: {}, errors: { body: 'Invalid request body.' }, isValid: false };
  const errors = unknownFields(body, ['password', 'currentPassword']);
  const pwError = passwordError(body.password);
  if (pwError) errors.password = pwError;
  if ('currentPassword' in body && (typeof body.currentPassword !== 'string' || body.currentPassword.length > MAX_PASSWORD_LENGTH)) {
    errors.currentPassword = 'Invalid current password.';
  }
  return {
    value: { password: body.password, currentPassword: body.currentPassword },
    errors,
    isValid: Object.keys(errors).length === 0,
  };
};
