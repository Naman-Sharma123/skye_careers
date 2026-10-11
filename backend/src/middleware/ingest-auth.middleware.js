const crypto = require('node:crypto');

function requireIngestKey(req, res, next) {
  const expected = process.env.JOBS_API_KEY;

  // Keep local development convenient, but never expose an unprotected ingest
  // endpoint in a production deployment.
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ success: false, message: 'Job ingestion is not configured' });
    }
    return next();
  }

  const provided = req.get('x-api-key');
  if (typeof provided !== 'string') {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length
    || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }

  return next();
}

module.exports = { requireIngestKey };
