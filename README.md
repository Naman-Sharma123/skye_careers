# Job Scraper

Node.js scripts for collecting job listings from Himalayas and Wellfound. Scrapers write JSON files locally; the PostgreSQL API and database importer are documented separately in [`backend/README.md`](backend/README.md).

## Project layout

```text
job-scrapper/
├── backend/                    # Express API, Prisma schema, JSON-to-database importer
├── output/                     # Generated scrape files (not committed)
├── scripts/
│   ├── himalayas-jobs/scrape.mjs # Himalayas API scraper (worker thread)
│   ├── wellfound-jobs/           # Wellfound scraper and PostgreSQL pipeline
│   ├── scrapper.js               # Combined Himalayas + Wellfound scraper
│   ├── automated_scraper.js      # Older scheduled combined scraper
│   └── debug_job.js              # Himalayas API debugging helper
├── package.json
└── README.md
```

## Requirements

- Node.js 18 or newer (the scripts use built-in `fetch` and worker threads).
- npm.
- Internet access to the job sources.
- PostgreSQL only if you plan to run a PostgreSQL pipeline or import results into the backend.

Install scraper dependencies from this directory:

```bash
npm install
```

## Scrape Himalayas

The dedicated Himalayas scraper requests up to 10,000 jobs, saves progress to `output/himalayas_jobs.json`, and posts the completed results to the backend API:

```bash
cd backend
npm run dev
```

In another terminal, from the project root:

```bash
node scripts/himalayas-jobs/scrape.mjs
```

The backend must be running and connected to PostgreSQL. Set `JOBS_API_URL` to the API endpoint if it is not at `http://localhost:5000/api/jobs`. For a deployed API, set `JOBS_API_KEY` to the same secret configured on the backend. The scraper deduplicates records while collecting them, periodically saves progress, then uploads jobs in size-limited batches. It stores the source API records in their raw shape; the API maps the common Himalayas fields. If the upload fails, the JSON file remains available and the script exits with an error.

To upload to a deployed Render backend from PowerShell, set these in the same terminal before running the scraper:

```powershell
$env:JOBS_API_URL = "https://YOUR-RENDER-SERVICE.onrender.com/api/jobs"
$env:JOBS_API_KEY = "YOUR_RENDER_JOBS_API_KEY"
node scripts\himalayas-jobs\scrape.mjs
```

Use your actual Render service URL and the same secret stored in the backend service's `JOBS_API_KEY` setting.

## Scrape both sources

The combined scraper collects up to 250 Himalayas jobs and Wellfound listings, then writes `himalayas_jobs.json`, `wellfound_jobs.json`, and `all_jobs.json` in the current working directory:

```bash
node scripts/scrapper.js
```

Run it from the project root so the JSON files are created there. This script scrapes and saves files; it does not import them into the backend database.

## Import jobs into the backend database

The backend importer reads a JSON array whose records use normalized fields such as `source`, `jobId`, `title`, and `jobUrl`. The combined scraper's Himalayas output is normalized for this importer. From the project root:

```bash
cd backend
npm install
npx prisma generate
npx prisma db push
node scripts/importJobs.js ..\himalayas_jobs.json
```

Set `DATABASE_URL` in `backend/.env` before running the Prisma or importer commands. The importer reports imported, duplicate, skipped, and invalid records. See [`backend/README.md`](backend/README.md) for database setup and API details.

The dedicated `scripts/himalayas-jobs/scrape.mjs` sends its raw Himalayas records to `POST /api/jobs`; use the JSON importer above when you want to import a saved, normalized JSON file instead.

## Wellfound pipeline

`scripts/wellfound-jobs/job-pipeline.js` is a separate Wellfound-to-PostgreSQL pipeline. It loads its environment from `scripts/wellfound-jobs/.env`, writes JSON under `output/`, and starts an hourly schedule when run normally. Configure PostgreSQL variables (`DATABASE_URL` or `PGHOST`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE`) before using it:

```bash
node scripts/wellfound-jobs/job-pipeline.js
```

To sync the previously saved filtered JSON without scraping, use:

```bash
node scripts/wellfound-jobs/job-pipeline.js --sync-output
```

Stop a scheduled run with `Ctrl+C`. Do not commit `.env` files or database credentials.

## Generated data and Git

Scraped JSON can be large and changes frequently. Keep generated files in `output/` (or another local data location) and exclude them from Git, along with `node_modules/` and `.env` files. Commit the scraper source, package files, and documentation instead.
