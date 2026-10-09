require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./config/database');
const jobsRoutes = require('./routes/jobs.routes');
const { notFound, errorHandler } = require('./middleware/error.middleware');

const app = express();
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', async (req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ success: true, message: 'Job API is running', database: 'connected' });
  } catch (error) {
    next(error);
  }
});
app.use('/api/jobs', jobsRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
