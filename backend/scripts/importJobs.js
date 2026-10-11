require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const prisma = require('../src/config/database');

const { mapIncomingJob } = require('../src/services/jobs.service');

const inputFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../../output/wellfound_jobs.json');
const BATCH_SIZE = 250;

function clean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  return String(value);
}

async function main() {
  if (!fs.existsSync(inputFile)) throw new Error(`Job data file not found: ${inputFile}`);
  const jobs = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  if (!Array.isArray(jobs)) throw new Error('Job data file must contain a JSON array');
  const stats = { imported: 0, skipped: 0, duplicates: 0, errors: 0 };
  console.log(`Reading ${jobs.length} jobs from ${inputFile}`);

  for (let start = 0; start < jobs.length; start += BATCH_SIZE) {
    const batch = jobs.slice(start, start + BATCH_SIZE);
    const mapped = [];
    for (const item of batch) {
      try {
        if (!item || typeof item !== 'object' || !clean(item.title)) {
          stats.skipped += 1;
          continue;
        }
        mapped.push(mapIncomingJob(item));
      } catch (error) {
        stats.errors += 1;
        console.error(`Could not map record ${start + mapped.length + 1}: ${error.message}`);
      }
    }

    if (mapped.length) {
      const result = await prisma.jobScrape.createMany({ data: mapped, skipDuplicates: true });
      stats.imported += result.count;
      stats.duplicates += mapped.length - result.count;
    }
    console.log(`Processed ${Math.min(start + BATCH_SIZE, jobs.length)}/${jobs.length}`);
  }

  console.log(`Import complete. Imported: ${stats.imported}, Skipped: ${stats.skipped}, Duplicates: ${stats.duplicates}, Errors: ${stats.errors}`);
}

main().catch((error) => {
  console.error(`Import failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
