const prisma = require('../config/database');

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

module.exports = { listJobs, getJobById };
