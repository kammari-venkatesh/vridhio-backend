// Single source of truth for the Lead Workspace vocabulary and limits. The admin UI
// reads these through GET /api/admin/lead-workspace/meta, so nothing is duplicated
// in the frontend.

export const SALES_LEAD_STATUSES = [
  'NEW',
  'REVIEWED',
  'CONTACTED',
  'REPLIED',
  'INTERESTED',
  'MEETING',
  'PROPOSAL',
  'WON',
  'LOST',
];

export const SALES_LEAD_SOURCES = ['AI_DISCOVERY', 'MANUAL', 'CSV_IMPORT', 'OTHER'];

// Services Vridhio sells. The first ten use the same IDs as the public site's catalogue
// (Agencia/src/data/services.ts); the rest are sales-only services. IDs are stable
// (stored in AI qualifications); names are what leads store and the UI shows.
export const SERVICE_CATALOG = Object.freeze([
  { id: 'website-development', name: 'Website Development' },
  { id: 'app-development', name: 'App Development' },
  { id: 'ai-automation', name: 'AI Automation' },
  { id: 'graphic-design', name: 'Graphic Design' },
  { id: 'video-editing', name: 'Video Editing' },
  { id: 'seo', name: 'SEO' },
  { id: 'google-ads', name: 'Google Ads' },
  { id: 'meta-ads', name: 'Meta Ads' },
  { id: 'social-media-marketing', name: 'Social Media Marketing' },
  { id: 'lead-generation', name: 'Lead Generation' },
  { id: 'website-redesign', name: 'Website Redesign' },
  { id: 'aeo', name: 'AEO' },
  { id: 'digital-marketing', name: 'Digital Marketing' },
]);

// "Need to Know" marks a lead whose needs are not yet known; it is not a service.
export const NEED_TO_KNOW = 'Need to Know';
export const SALES_SERVICES = [...SERVICE_CATALOG.map((s) => s.name), NEED_TO_KNOW];

export const leadWorkspaceConfig = {
  pagination: { defaultLimit: 50, maxLimit: 100 },
  sortFields: {
    businessName: 'businessName',
    category: 'category',
    city: 'city',
    status: 'status',
    source: 'source',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  limits: {
    searchMaxLength: 100,
    notesMaxLength: 5000,
    maxTags: 20,
    tagMaxLength: 40,
    maxServices: 20,
    maxCustomFields: 30,
    customFieldKeyMaxLength: 60,
    customFieldValueMaxLength: 1000,
    bulkMaxIds: 500,
    // Rows pasted into the table in one request; larger sets belong in Import.
    batchMaxRows: 500,
  },
  // Discovered businesses are added to the workspace automatically as AI_DISCOVERY leads.
  autoAddProspects: process.env.LEAD_WORKSPACE_AUTO_ADD_PROSPECTS !== 'false',
  import: {
    maxContentLength: 2_000_000,
    maxRows: 5000,
    maxColumns: 50,
    maxCellLength: 2000,
    previewRows: 20,
    maxReportedIssues: 200,
  },
  export: { maxRows: 10_000 },
};
