# Job Aggregation Backend

Express and Prisma REST API for the existing job scraper data. The API reads from the new `job_scrape` table. The existing `remote_jobs` table and scraping scripts remain unchanged.

## Data inspected

`../output/wellfound_jobs.json` contains 6,239 Wellfound job records and is the import source. `../output/filtered_jobs.json` has 2,210 records and is a filtered subset, so it is not imported separately. All records have a title, source ID, source URL, and location. The current data has no separate skills, country, state, or city fields; those schema fields remain nullable, and the complete source record is retained in `rawData` for future remapping.

The importer builds a stable SHA-256 key from `source + jobId` (falling back to URL, then normalized source/company/title/location). PostgreSQL's unique constraint and Prisma `skipDuplicates` make repeated runs safe. Source IDs are not modified.

## Setup

From this directory:

```bash
npm install
```

Copy `.env.example` to `.env` if you have not already configured the backend, then set `DATABASE_URL` to your PostgreSQL connection string and `FRONTEND_URL` to the Next.js origin. Multiple comma-separated frontend origins are accepted. The backend `.env` in this workspace uses the latest `DATABASE_URL` from `../scripts/.env`.

```bash
npm run prisma:generate
npm run prisma:push
npm run import:jobs
npm run dev
```

`prisma:push` creates or synchronizes the Prisma tables, including `job_scrape`; it does not reset the database. The importer reads `../output/wellfound_jobs.json` by default. To import another JSON array, pass its path:

```bash
npm run import:jobs -- "D:\\path\\to\\jobs.json"
```

Use `npm start` in production after setting `NODE_ENV=production`. Do not commit `.env`.

## API

Base URL: `http://localhost:5000`

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/health` | Checks API and PostgreSQL connectivity |
| GET | `/api/jobs` | Paginated jobs; defaults to page 1 and 20 results |
| GET | `/api/jobs/:id` | Full details for one database job ID |

`GET /api/jobs` supports `page`, `limit` (1–100), `search`, `location`, `country`, `city`, `jobType`, `employmentType`, `experience`, `company`, `source`, and `sort`. Text filters are case-insensitive partial matches. `search` checks title, company, skills, location, and description. `sort=newest` is the default; `sort=oldest` reverses posted-date order. `sort=relevance` is accepted and currently uses newest-first ordering because the available Prisma setup does not provide full-text relevance ranking.

Examples:

```text
http://localhost:5000/api/health
http://localhost:5000/api/jobs
http://localhost:5000/api/jobs?page=2&limit=20
http://localhost:5000/api/jobs?search=react
http://localhost:5000/api/jobs?location=Delhi
http://localhost:5000/api/jobs?search=react&location=Delhi&experience=1-3
http://localhost:5000/api/jobs?sort=oldest&country=India
http://localhost:5000/api/jobs/<job-id>
```

List response:

```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalJobs": 6239,
    "totalPages": 312
  }
}
```

The counts shown above describe the source file before database import; API counts reflect successfully imported database records. Detail response is `{ "success": true, "data": { ...job } }`. Errors use `{ "success": false, "message": "..." }`; production responses do not expose stack traces. Health returns `{ "success": true, "message": "Job API is running", "database": "connected" }` when the database check succeeds.
