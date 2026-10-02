import { Prospect } from '../../models/prospect.model.js';
import { findJobOrThrow } from './leadFinderJob.service.js';

const DUPLICATE_KEY = 11000;

export const toProspectDto = (p) => ({
  id: p._id.toString(),
  businessName: p.businessName,
  category: p.category,
  categories: [...p.categories],
  address: p.address,
  city: p.city ?? null,
  state: p.state ?? null,
  country: p.country ?? null,
  phone: p.phone,
  website: p.website,
  googleMapsUrl: p.googleMapsUrl,
  latitude: p.latitude,
  longitude: p.longitude,
  source: p.source,
  status: p.status,
  createdAt: p.createdAt,
});

const isDuplicateKeyError = (err) =>
  err?.code === DUPLICATE_KEY || err?.writeErrors?.some?.((e) => e.code === DUPLICATE_KEY);

/**
 * Inserts new businesses and links already-known ones to this job, keyed by
 * source + sourceId. Existing prospect details are not overwritten. Returns how
 * many businesses were new.
 */
export const upsertDiscoveredProspects = async (businesses, jobId) => {
  if (businesses.length === 0) return 0;
  const now = new Date();
  const operations = businesses.map(({ source, sourceId, ...details }) => ({
    updateOne: {
      filter: { source, sourceId },
      update: {
        $setOnInsert: { ...details, source, sourceId, jobId, status: 'new' },
        $addToSet: { jobIds: jobId },
        $set: { lastSeenAt: now },
      },
      upsert: true,
    },
  }));

  try {
    const result = await Prospect.bulkWrite(operations, { ordered: false });
    return result.upsertedCount;
  } catch (err) {
    // Two jobs inserting the same new business at once: one upsert loses the race on the
    // unique index. Retrying turns the losing inserts into plain updates.
    if (!isDuplicateKeyError(err)) throw err;
    const inserted = err.result?.upsertedCount ?? err.result?.nUpserted ?? 0;
    const retry = await Prospect.bulkWrite(operations, { ordered: false });
    return inserted + retry.upsertedCount;
  }
};

export const listProspectsForJob = async (jobId, { page, limit }) => {
  const job = await findJobOrThrow(jobId);
  const filter = { jobIds: job._id };
  const [prospects, total] = await Promise.all([
    Prospect.find(filter)
      .sort({ businessName: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Prospect.countDocuments(filter),
  ]);
  return { items: prospects.map(toProspectDto), page, limit, total, totalPages: Math.ceil(total / limit) };
};
