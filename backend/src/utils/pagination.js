function parsePagination(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);

  if (!Number.isSafeInteger(page) || page < 1) {
    const error = new Error('page must be a positive integer');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error('limit must be an integer between 1 and 100');
    error.statusCode = 400;
    throw error;
  }

  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { parsePagination };
