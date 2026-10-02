import { ACTIVE_JOB_STATUSES, LeadFinderJob } from '../../models/leadFinderJob.model.js';
import { Prospect } from '../../models/prospect.model.js';
import { SalesLead } from '../../models/salesLead.model.js';
import { getLeadCount } from '../lead.controller.js';

export const getDashboard = async (req, res) => {
  const [activeJobs, prospects, salesLeads] = await Promise.all([
    LeadFinderJob.countDocuments({ status: { $in: ACTIVE_JOB_STATUSES } }),
    Prospect.estimatedDocumentCount(),
    SalesLead.countDocuments({ archived: false }),
  ]);

  res.json({
    success: true,
    data: {
      admin: req.admin.toJSON(),
      stats: { inboundLeads: getLeadCount(), leadFinder: { activeJobs, prospects }, salesLeads },
      modules: [{ key: 'lead-finder', name: 'AI Lead Finder', status: 'active' }],
      serverTime: new Date().toISOString(),
    },
  });
};
