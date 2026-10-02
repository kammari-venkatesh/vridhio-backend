const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;

export const validateLogin = (body = {}) => {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const errors = {};
  if (!email || email.length > MAX_EMAIL_LENGTH) errors.email = 'Email is required.';
  if (!password || password.length > MAX_PASSWORD_LENGTH) errors.password = 'Password is required.';

  return { credentials: { email, password }, errors, isValid: Object.keys(errors).length === 0 };
};
