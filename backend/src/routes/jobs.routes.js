const express = require('express');
const controller = require('../controllers/jobs.controller');

const router = express.Router();
router.post('/', controller.createJobs);
router.get('/', controller.listJobs);
router.get('/:id', controller.getJob);

module.exports = router;
