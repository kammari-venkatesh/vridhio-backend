const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const asTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

export const validateLead = (body = {}) => {
  const lead = {
    name: asTrimmedString(body.name),
    email: asTrimmedString(body.email).toLowerCase(),
    phone: asTrimmedString(body.phone),
    services: Array.isArray(body.services)
      ? body.services.map(asTrimmedString).filter(Boolean)
      : [],
    message: asTrimmedString(body.message),
  };

  const errors = {};
  if (lead.name.length < 2) errors.name = 'Please enter your full name.';
  if (!EMAIL_PATTERN.test(lead.email)) errors.email = 'Please enter a valid work email address.';
  if (lead.phone.length < 6) errors.phone = 'Please enter a phone or WhatsApp number.';
  if (lead.services.length === 0) errors.services = 'Please select at least one service.';
  if (lead.message.length < 5) errors.message = 'Please tell us a little about your project.';

  return { lead, errors, isValid: Object.keys(errors).length === 0 };
};
