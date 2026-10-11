function notFound(req, res) {
  res.status(404).json({ success: false, message: 'Route not found' });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.statusCode)
    ? error.statusCode
    : Number.isInteger(error.status) ? error.status : 500;
  const message = status >= 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : error.message || 'Internal server error';
  if (status >= 500) console.error(error);
  return res.status(status).json({ success: false, message });
}

module.exports = { notFound, errorHandler };
