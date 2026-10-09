/**
 * ONE-FILE JOB PIPELINE
 * Wellfound (axios + worker-pool HTML scraper)
 * -> Filter/Clean/Date Normalization -> Upsert latest data into Postgres
 *
 * Install deps:
 *   npm install axios node-cron pg dotenv
 *
 * Env vars (Postgres connection):
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname
 *   (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT — pg reads these automatically)
 *
 * Run:
 *   node scripts/job-pipeline.js
 *   node scripts/job-pipeline.js --sync-output (sync filtered JSON without scraping)
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");
const { Pool } = require("pg");

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const OUTPUT_DIR = path.resolve(__dirname, "../output");

const CONFIG = {
    // Wellfound
    WELLFOUND_BASE_URL: "https://wellfound.com/remote",
    WELLFOUND_TOTAL_PAGES: 203,
    WELLFOUND_WORKERS: 12,
    WELLFOUND_JSON: path.join(OUTPUT_DIR, "wellfound_jobs.json"),

    // Output files
    FILTERED_JSON: path.join(OUTPUT_DIR, "filtered_jobs.json"),

    // Filtering rules
    MAX_JOB_AGE_DAYS: 30,      // drop postings older than this (null = keep all)
    REQUIRE_TITLE: true,
    REQUIRE_URL: true,

    CRON_SCHEDULE: "0 * * * *" // every hour on the hour
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HTTP_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
};

// Ensure output directory exists on load
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// POSTGRES POOL SETUP
// ---------------------------------------------------------------------------
function buildPoolConfig() {
    if (process.env.DATABASE_URL) {
        return {
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
        };
    }

    const required = ["PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(
            `Missing Postgres connection env vars: ${missing.join(", ")}. ` +
            `Set DATABASE_URL, or all of PGHOST/PGUSER/PGPASSWORD/PGDATABASE ` +
            `(PGPASSWORD must be a real string, e.g. in a .env file loaded via dotenv).`
        );
    }

    return {
        host: process.env.PGHOST,
        user: process.env.PGUSER,
        password: String(process.env.PGPASSWORD),
        database: process.env.PGDATABASE,
        port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432
    };
}

const pool = new Pool(buildPoolConfig());

// ---------------------------------------------------------------------------
// 1. WELLFOUND SCRAPER (Axios + Paginated Worker Pool + Embedded JSON Parser)
// ---------------------------------------------------------------------------
async function getWellfoundPage(page) {
    const url = page === 1 ? CONFIG.WELLFOUND_BASE_URL : `${CONFIG.WELLFOUND_BASE_URL}?page=${page}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios.get(url, { headers: HTTP_HEADERS, timeout: 30000 });
            if (response.status === 200) {
                console.log(`[WELLFOUND PAGE ${page}] downloaded`);
                return response.data;
            }
        } catch (error) {
            console.log(`[WELLFOUND PAGE ${page}] failed attempt ${attempt}: ${error.message}`);
            if (attempt < 3) await sleep(attempt * 2000);
        }
    }
    return null;
}

function findMatchingBrace(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }

        if (char === '"') inString = true;
        else if (char === "{") depth++;
        else if (char === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function extractWellfoundJobs(html, page) {
    const jobs = [];
    const marker = "JobListingSearchResult:";
    let position = 0;

    while (true) {
        const start = html.indexOf(marker, position);
        if (start === -1) break;

        const colon = html.indexOf(":", start + marker.length);
        if (colon === -1) break;

        const objectStart = html.indexOf("{", colon);
        if (objectStart === -1) break;

        const objectEnd = findMatchingBrace(html, objectStart);
        if (objectEnd === -1) break;

        const jsonText = html.substring(objectStart, objectEnd + 1);

        try {
            const job = JSON.parse(jsonText);
            if (job && (job.__typename === "JobListingSearchResult" || job.__typename === "JobListing")) {
                jobs.push({ ...job, page });
            }
        } catch (error) {
            // Ignore malformed JSON objects
        }

        position = objectEnd + 1;
    }

    return jobs;
}

function calculateDaysAgo(dateString) {
    if (!dateString) return null;
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return null;

    const diffTime = Math.abs(Date.now() - date.getTime());
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

function normalizeWellfoundJob(job) {
    const postedDate = job.postedAt || job.liveStartAt || job.userPostedAt || job.createdAt || null;

    return {
        source: "Wellfound",
        jobId: String(job.id || ""),
        title: job.title || "Position",
        company: job.company?.name || job.companyName || job.startup?.name || "Startup",
        salary: job.compensation || "Not Disclosed",
        location: Array.isArray(job.locationNames) && job.locationNames.length
            ? job.locationNames.join("; ")
            : "Remote",
        acceptedRemoteLocations: Array.isArray(job.acceptedRemoteLocationNames)
            ? job.acceptedRemoteLocationNames.join("; ")
            : "",
        jobUrl: job.slug ? `https://wellfound.com/jobs/${job.slug}` : "",
        description: job.description || "",
        
        // Comprehensive Date Fields
        postedAt: postedDate,
        liveStartAt: job.liveStartAt || null,
        userPostedAt: job.userPostedAt || null,
        updatedAt: job.updatedAt || null,
        applicationDeadline: job.applicationDeadline || job.expiresAt || "Open until filled",
        daysPostedAgo: calculateDaysAgo(postedDate),

        // Metadata
        jobType: job.jobType || null,
        primaryRole: job.primaryRoleTitle || null,
        remoteConfig: job.remoteConfig || null,
        experienceMin: job.yearsExperienceMin ?? null,
        experienceMax: job.yearsExperienceMax ?? null,
        atsSource: job.atsSource || null,
        autoPosted: job.autoPosted ?? null,
        page: job.page
    };
}

async function scrapeWellfoundPage(page) {
    const html = await getWellfoundPage(page);
    if (!html) return { page, jobs: [] };

    const rawJobs = extractWellfoundJobs(html, page);
    const normalized = rawJobs.map(normalizeWellfoundJob);

    console.log(`[WELLFOUND PAGE ${page}] ${normalized.length} jobs`);
    return { page, jobs: normalized };
}

async function runWellfoundWorkers(totalPages, workerCount) {
    const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    const results = [];
    let currentIndex = 0;

    async function worker(workerId) {
        while (true) {
            const index = currentIndex++;
            if (index >= pages.length) break;

            const page = pages[index];
            console.log(`[WF WORKER ${workerId}] page ${page}`);

            try {
                const result = await scrapeWellfoundPage(page);
                results.push(result);
            } catch (error) {
                console.error(`[WF WORKER ${workerId}] ERROR page ${page}`, error.message);
            }
        }
    }

    const workers = [];
    for (let i = 1; i <= workerCount; i++) workers.push(worker(i));
    await Promise.all(workers);

    return results;
}

function dedupeWellfoundJobs(jobs) {
    const map = new Map();
    for (const job of jobs) {
        if (!job.jobId) continue;
        map.set(job.jobId, job);
    }
    return [...map.values()];
}

async function scrapeWellfound(totalPages = CONFIG.WELLFOUND_TOTAL_PAGES, workerCount = CONFIG.WELLFOUND_WORKERS) {
    console.log(`\n==================================================`);
    console.log(`SCRAPING WELLFOUND JOBS (Pages: ${totalPages}, Workers: ${workerCount})`);
    console.log(`==================================================`);

    try {
        const results = await runWellfoundWorkers(totalPages, workerCount);
        let jobs = results.flatMap((r) => r.jobs);
        console.log(`Wellfound raw jobs: ${jobs.length}`);

        jobs = dedupeWellfoundJobs(jobs);
        console.log(`Wellfound unique jobs: ${jobs.length}`);

        fs.writeFileSync(CONFIG.WELLFOUND_JSON, JSON.stringify(jobs, null, 2));
        return jobs;
    } catch (error) {
        console.error("❌ Wellfound Error:", error.message);
        return [];
    }
}

// ---------------------------------------------------------------------------
// 2. DATE NORMALIZATION HELPER
// ---------------------------------------------------------------------------
function parseToDate(dateStr) {
    if (dateStr === null || dateStr === undefined || dateStr === "") return null;

    if (typeof dateStr === "number" || /^\d+$/.test(String(dateStr))) {
        const num = Number(dateStr);
        const ms = num > 1e12 ? num : num * 1000;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
    }

    if (!isNaN(Date.parse(dateStr))) {
        return new Date(dateStr).toISOString().split("T")[0];
    }

    const lower = String(dateStr).toLowerCase();
    const now = new Date();

    if (lower.includes("today")) return now.toISOString().split("T")[0];
    if (lower.includes("yesterday")) {
        now.setDate(now.getDate() - 1);
        return now.toISOString().split("T")[0];
    }

    const match = lower.match(/(\d+)\s+(day|week|month)s?\s+ago/);
    if (match) {
        const num = parseInt(match[1], 10);
        const unit = match[2];
        if (unit === "day") now.setDate(now.getDate() - num);
        if (unit === "week") now.setDate(now.getDate() - num * 7);
        if (unit === "month") now.setMonth(now.getMonth() - num);
        return now.toISOString().split("T")[0];
    }

    return null;
}

// ---------------------------------------------------------------------------
// 3. FILTER / CLEAN STEP
// ---------------------------------------------------------------------------
function filterJobs(rawJobs) {
    console.log(`\n==================================================`);
    console.log(`FILTERING ${rawJobs.length} RAW JOBS`);
    console.log(`==================================================`);

    const cutoff = CONFIG.MAX_JOB_AGE_DAYS
        ? new Date(Date.now() - CONFIG.MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000)
        : null;

    const dedupeMap = new Map();

    for (const job of rawJobs) {
        if (CONFIG.REQUIRE_TITLE && !job.title) continue;
        if (CONFIG.REQUIRE_URL && !job.jobUrl) continue;

        const normalizedDate = parseToDate(job.postedAt);
        const cleanJob = { 
            ...job, 
            postedAt: normalizedDate,
            daysPostedAgo: calculateDaysAgo(normalizedDate)
        };

        if (cutoff && normalizedDate) {
            const postedDate = new Date(normalizedDate);
            if (postedDate < cutoff) continue;
        }

        const key = `${cleanJob.source}|${cleanJob.jobId || cleanJob.jobUrl}`;
        const existing = dedupeMap.get(key);

        if (!existing) {
            dedupeMap.set(key, cleanJob);
        } else {
            const existingDate = existing.postedAt ? new Date(existing.postedAt) : null;
            const newDate = cleanJob.postedAt ? new Date(cleanJob.postedAt) : null;
            if (newDate && (!existingDate || newDate > existingDate)) {
                dedupeMap.set(key, cleanJob);
            }
        }
    }

    const filtered = Array.from(dedupeMap.values())
        .sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0));

    console.log(`Kept ${filtered.length} / ${rawJobs.length} jobs after filtering.`);
    fs.writeFileSync(CONFIG.FILTERED_JSON, JSON.stringify(filtered, null, 2));
    return filtered;
}

// ---------------------------------------------------------------------------
// 4. POSTGRES UPSERT
// ---------------------------------------------------------------------------
const UPSERT_QUERY = `
    INSERT INTO remote_jobs
        (source, job_id, title, company, salary, location, accepted_remote_locations, job_url,
         posted_at, live_start_at, user_posted_at, source_updated_at, application_deadline,
         days_posted_ago, description, job_type, primary_role, remote_config, experience_min,
         experience_max, ats_source, auto_posted, page, updated_at)
    VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, CURRENT_TIMESTAMP)
    ON CONFLICT (source, job_id)
    DO UPDATE SET
        title = EXCLUDED.title,
        company = EXCLUDED.company,
        salary = EXCLUDED.salary,
        location = EXCLUDED.location,
        accepted_remote_locations = EXCLUDED.accepted_remote_locations,
        job_url = EXCLUDED.job_url,
        posted_at = EXCLUDED.posted_at,
        live_start_at = EXCLUDED.live_start_at,
        user_posted_at = EXCLUDED.user_posted_at,
        source_updated_at = EXCLUDED.source_updated_at,
        application_deadline = EXCLUDED.application_deadline,
        description = EXCLUDED.description,
        days_posted_ago = EXCLUDED.days_posted_ago,
        job_type = EXCLUDED.job_type,
        primary_role = EXCLUDED.primary_role,
        remote_config = EXCLUDED.remote_config,
        experience_min = EXCLUDED.experience_min,
        experience_max = EXCLUDED.experience_max,
        ats_source = EXCLUDED.ats_source,
        auto_posted = EXCLUDED.auto_posted,
        page = EXCLUDED.page,
        updated_at = CURRENT_TIMESTAMP;
`;

async function ensureTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS remote_jobs (
            id SERIAL PRIMARY KEY,
            source TEXT NOT NULL,
            job_id TEXT NOT NULL,
            title TEXT,
            company TEXT,
            salary TEXT,
            location TEXT,
            accepted_remote_locations TEXT,
            job_url TEXT,
            posted_at DATE,
            live_start_at DATE,
            user_posted_at DATE,
            source_updated_at DATE,
            application_deadline TEXT,
            days_posted_ago INTEGER,
            description TEXT,
            job_type TEXT,
            primary_role TEXT,
            remote_config JSONB,
            experience_min NUMERIC,
            experience_max NUMERIC,
            ats_source TEXT,
            auto_posted BOOLEAN,
            page INTEGER,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (source, job_id)
        );
    `);

    await client.query(`
        ALTER TABLE remote_jobs
            ADD COLUMN IF NOT EXISTS accepted_remote_locations TEXT,
            ADD COLUMN IF NOT EXISTS live_start_at DATE,
            ADD COLUMN IF NOT EXISTS user_posted_at DATE,
            ADD COLUMN IF NOT EXISTS source_updated_at DATE,
            ADD COLUMN IF NOT EXISTS days_posted_ago INTEGER,
            ADD COLUMN IF NOT EXISTS job_type TEXT,
            ADD COLUMN IF NOT EXISTS primary_role TEXT,
            ADD COLUMN IF NOT EXISTS remote_config JSONB,
            ADD COLUMN IF NOT EXISTS experience_min NUMERIC,
            ADD COLUMN IF NOT EXISTS experience_max NUMERIC,
            ADD COLUMN IF NOT EXISTS ats_source TEXT,
            ADD COLUMN IF NOT EXISTS auto_posted BOOLEAN,
            ADD COLUMN IF NOT EXISTS page INTEGER;
    `);
}

async function syncToPostgres(jobs) {
    console.log(`\n==================================================`);
    console.log(`SYNCING ${jobs.length} FILTERED JOBS TO POSTGRES`);
    console.log(`==================================================`);

    const client = await pool.connect();
    let inserted = 0;

    try {
        await ensureTable(client);
        await client.query("BEGIN");

        for (const job of jobs) {
            await client.query(UPSERT_QUERY, [
                job.source || "Wellfound",
                String(job.jobId || job.jobUrl),
                job.title || "Position",
                job.company || null,
                job.salary || null,
                job.location || null,
                job.acceptedRemoteLocations || null,
                job.jobUrl || null,
                parseToDate(job.postedAt),
                parseToDate(job.liveStartAt),
                parseToDate(job.userPostedAt),
                parseToDate(job.updatedAt),
                job.applicationDeadline || "Open until filled",
                job.daysPostedAgo ?? null,
                job.description || null,
                job.jobType || null,
                job.primaryRole || null,
                job.remoteConfig == null ? null : JSON.stringify(job.remoteConfig),
                job.experienceMin ?? null,
                job.experienceMax ?? null,
                job.atsSource || null,
                job.autoPosted ?? null,
                job.page ?? null
            ]);
            inserted++;
        }

        await client.query("COMMIT");
        console.log(`✅ DB sync complete. Upserted: ${inserted}`);
    } catch (err) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error("❌ DB rollback failed:", rollbackError.message);
        }
        console.error("❌ DB sync transaction rolled back:", err.message);
        throw err;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// MASTER PIPELINE: scrape -> filter -> sync
// ---------------------------------------------------------------------------
async function runPipeline() {
    console.log(`\n==================================================`);
    console.log(`RUNNING JOB PIPELINE AT ${new Date().toISOString()}`);
    console.log(`==================================================`);

    const start = Date.now();

    try {
        const wellfoundData = await scrapeWellfound(CONFIG.WELLFOUND_TOTAL_PAGES, CONFIG.WELLFOUND_WORKERS);

        console.log(`\nScraping complete! Total raw jobs: ${wellfoundData.length}`);

        const filteredData = filterJobs(wellfoundData);

        await syncToPostgres(filteredData);

        const seconds = ((Date.now() - start) / 1000).toFixed(2);
        console.log(`\n✅ Pipeline run finished at ${new Date().toISOString()} (${seconds}s)`);
    } catch (err) {
        console.error("❌ Pipeline run failed:", err.message);
    }
}

// ---------------------------------------------------------------------------
// STARTUP & DAEMON SCHEDULER
// ---------------------------------------------------------------------------
if (process.argv.includes("--sync-output")) {
    async function syncSavedOutput() {
        const jobs = JSON.parse(fs.readFileSync(CONFIG.FILTERED_JSON, "utf8"));
        await syncToPostgres(jobs);
    }

    syncSavedOutput()
        .catch((error) => {
            console.error("❌ Saved output sync failed:", error.message);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
} else {
    runPipeline();

    cron.schedule(CONFIG.CRON_SCHEDULE, () => {
        runPipeline();
    });

    console.log(`\n⏰ Job pipeline daemon initialized. Schedule: "${CONFIG.CRON_SCHEDULE}"`);

    process.on("SIGINT", async () => {
        console.log("\nShutting down, closing DB pool...");
        await pool.end();
        process.exit(0);
    });
}