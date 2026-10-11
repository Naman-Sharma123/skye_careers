const jobsService = require('../services/jobs.service');
const { parsePagination } = require('../utils/pagination');

async function createJobs(req, res, next) {
  try {
    const jobs = await jobsService.createJobs(req.body?.jobs);
    return res.status(201).json({ success: true, ...jobs });
  } catch (error) {
    return next(error);
  }
}

async function listJobs(req, res, next) {
  try {
    const result = await jobsService.listJobs(req.query, parsePagination(req.query));
    res.json({ success: true, data: result.jobs, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

async function getJob(req, res, next) {
  try {
    if (!req.params.id || req.params.id.length > 100) {
      return res.status(400).json({ success: false, message: 'Invalid job ID' });
    }
    const job = await jobsService.getJobById(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    return res.json({ success: true, data: job });
  } catch (error) {
    return next(error);
  }
}

module.exports = { createJobs, listJobs, getJob };
