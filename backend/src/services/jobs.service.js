const prisma = require('../config/database');
const crypto = require('node:crypto');

const MAX_IMPORT_BATCH = 500;

function clean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  return String(value);
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  let date;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const numeric = Number(value);
    date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  } else {
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapIncomingJob(item) {
  const isHimalayasRecord = item.guid !== undefined || item.pubDate !== undefined
    || item.locationRestrictions !== undefined || item.companyName !== undefined;
  const source = clean(item.source) || (isHimalayasRecord ? 'Himalayas' : 'Unknown');
  const sourceJobId = clean(item.jobId ?? item.guid ?? item.id);
  const sourceUrl = clean(item.jobUrl ?? item.applicationLink ?? item.sourceUrl ?? item.url);
  const company = clean(item.company ?? item.companyName?.name ?? item.companyName);
  const title = clean(item.title);
  const rawLocation = item.location ?? item.locationRestrictions;
  const location = Array.isArray(rawLocation)
    ? rawLocation.map((entry) => clean(entry?.name ?? entry)).filter(Boolean).join('; ') || null
    : clean(rawLocation);
  const fallbackIdentity = [source, company, title, location]
    .map((part) => (clean(part) || '').toLowerCase()).join('|');
  const identity = sourceJobId ? `${source}|id|${sourceJobId}`
    : sourceUrl ? `${source}|url|${sourceUrl}` : fallbackIdentity;
  const skills = Array.isArray(item.skills)
    ? item.skills.map(clean).filter(Boolean)
    : typeof item.skills === 'string'
      ? item.skills.split(/[,;]/).map(clean).filter(Boolean)
      : [];
  const timestamp = item.postedAt ?? item.pubDate;

  return {
    title,
    company,
    location,
    country: clean(item.country),
    state: clean(item.state),
    city: clean(item.city),
    jobType: clean(item.jobType),
    employmentType: clean(item.employmentType),
    experience: clean(item.experience),
    salary: clean(item.salary),
    description: clean(item.description),
    skills,
    source,
    sourceJobId,
    sourceUrl,
    postedDate: parseDate(timestamp),
    rawData: item,
    dedupeKey: crypto.createHash('sha256').update(identity).digest('hex'),
  };
}

const FILTER_FIELDS = [
  'location', 'country', 'city', 'jobType', 'employmentType',
  'experience', 'company', 'source',
];

function textFilter(value, name) {
  if (Array.isArray(value) || typeof value !== 'string' || value.length > 200) {
    const error = new Error(`${name} must be a text value up to 200 characters`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

function buildWhere(query) {
  const where = {};
  for (const field of FILTER_FIELDS) {
    if (query[field] !== undefined) {
      const value = textFilter(query[field], field);
      if (value) where[field] = { contains: value, mode: 'insensitive' };
    }
  }

  if (query.search !== undefined) {
    const search = textFilter(query.search, 'search');
    if (search) {
      where.OR = ['title', 'company', 'skills', 'location', 'description'].map((field) =>
        field === 'skills'
          ? { skills: { has: search } }
          : { [field]: { contains: search, mode: 'insensitive' } },
      );
    }
  }
  return where;
}

async function listJobs(query, pagination) {
  const where = buildWhere(query);
  const sort = query.sort === undefined ? 'newest' : textFilter(query.sort, 'sort');
  if (!['newest', 'oldest', 'relevance'].includes(sort)) {
    const error = new Error('sort must be newest, oldest, or relevance');
    error.statusCode = 400;
    throw error;
  }
  const orderBy = sort === 'oldest'
    ? [{ postedDate: 'asc' }, { createdAt: 'asc' }]
    : [{ postedDate: 'desc' }, { createdAt: 'desc' }];
  const [jobs, totalJobs] = await Promise.all([
    prisma.jobScrape.findMany({ where, skip: pagination.skip, take: pagination.limit, orderBy }),
    prisma.jobScrape.count({ where }),
  ]);
  return {
    jobs,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      totalJobs,
      totalPages: Math.ceil(totalJobs / pagination.limit),
    },
  };
}

async function getJobById(id) {
  return prisma.jobScrape.findUnique({ where: { id } });
}

async function createJobs(input) {
  if (!Array.isArray(input) || input.length === 0) {
    const error = new Error('Request body must contain a non-empty jobs array');
    error.statusCode = 400;
    throw error;
  }
  if (input.length > MAX_IMPORT_BATCH) {
    const error = new Error(`A maximum of ${MAX_IMPORT_BATCH} jobs can be sent per request`);
    error.statusCode = 413;
    throw error;
  }

  const mapped = [];
  let skipped = 0;
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !clean(item.title)) {
      skipped += 1;
      continue;
    }
    mapped.push(mapIncomingJob(item));
  }

  const result = mapped.length
    ? await prisma.jobScrape.createMany({ data: mapped, skipDuplicates: true })
    : { count: 0 };
  return {
    received: input.length,
    created: result.count,
    duplicates: mapped.length - result.count,
    skipped,
  };
}

module.exports = { createJobs, listJobs, getJobById };
