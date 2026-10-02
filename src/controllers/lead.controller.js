import { randomUUID } from 'node:crypto';
import { ApiError } from '../utils/ApiError.js';
import { validateLead } from '../validators/lead.validator.js';

// In-memory store; replace with a database (e.g. MongoDB/PostgreSQL) for persistence.
const leads = [];

export const createLead = (req, res) => {
  const { lead, errors, isValid } = validateLead(req.body);
  if (!isValid) throw new ApiError(400, 'Validation failed', errors);

  const saved = { id: randomUUID(), ...lead, createdAt: new Date().toISOString() };
  leads.push(saved);

  res.status(201).json({ success: true, message: 'Message received.', data: saved });
};

export const listLeads = (_req, res) => {
  res.json({ success: true, count: leads.length, data: leads });
};
