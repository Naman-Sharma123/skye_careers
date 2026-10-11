function parsePagination(query) {
  const hasPage = query.page !== undefined;
  const hasLimit = query.limit !== undefined;

  if (!hasPage && !hasLimit) {
    return { isPaginated: false };
  }

  const page = query.page === undefined ? 1 : Number(query.page);
  if (!Number.isSafeInteger(page) || page < 1) {
    const error = new Error('page must be a positive integer');
    error.statusCode = 400;
    throw error;
  }

  let limit = undefined;
  if (hasLimit) {
    limit = Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      const error = new Error('limit must be a positive integer');
      error.statusCode = 400;
      throw error;
    }
  }

  const skip = limit ? (page - 1) * limit : 0;
  return {
    isPaginated: true,
    page,
    limit,
    skip,
  };
}

module.exports = { parsePagination };
