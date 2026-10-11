const express = require('express');
const controller = require('../controllers/jobs.controller');
const { requireIngestKey } = require('../middleware/ingest-auth.middleware');

const router = express.Router();
router.post('/', requireIngestKey, controller.createJobs);
router.get('/', controller.listJobs);
router.get('/:id', controller.getJob);

module.exports = router;
