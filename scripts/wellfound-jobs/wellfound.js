const axios = require("axios");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://wellfound.com/remote";

const TOTAL_PAGES = 203;
const WORKERS = 12;

// Output directory resolving to the 'output' folder in the project root
const OUTPUT_DIR = path.resolve(__dirname, "../output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "wellfound_jobs.json");

const headers = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/151.0.0.0 Safari/537.36",

    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

    "Accept-Language":
        "en-US,en;q=0.9"
};


// ======================================================
// REQUEST PAGE
// ======================================================

async function getPage(page) {

    const url =
        page === 1
            ? BASE_URL
            : `${BASE_URL}?page=${page}`;

    for (let attempt = 1; attempt <= 3; attempt++) {

        try {

            const response = await axios.get(url, {
                headers,
                timeout: 30000
            });

            if (response.status === 200) {

                console.log(
                    `[PAGE ${page}] downloaded`
                );

                return response.data;
            }

        } catch (error) {

            console.log(
                `[PAGE ${page}] failed attempt ${attempt}: ${error.message}`
            );

            if (attempt < 3) {
                await sleep(attempt * 2000);
            }
        }
    }

    return null;
}


// ======================================================
// EXTRACT JOB OBJECTS
// ======================================================

function extractJobs(html, page) {

    const jobs = [];

    const regex =
        /JobListingSearchResult:\d+:\s*(\{[\s\S]*?\})(?=,\s*JobListingSearchResult:|[,}]\s*[^"]|$)/g;

    let match;

    while ((match = regex.exec(html)) !== null) {

        try {

            const jsonString = match[1];

            const job =
                JSON.parse(jsonString);

            if (
                job &&
                job.__typename ===
                "JobListingSearchResult"
            ) {

                jobs.push({
                    ...job,
                    page
                });
            }

        } catch (error) {

            // Ignore malformed matches
        }
    }

    return jobs;
}


// ======================================================
// MORE RELIABLE EXTRACTION
// ======================================================

function extractJobsAlternative(html, page) {

    const jobs = [];

    const marker =
        "JobListingSearchResult:";

    let position = 0;

    while (true) {

        const start =
            html.indexOf(
                marker,
                position
            );

        if (start === -1) {
            break;
        }

        const colon =
            html.indexOf(
                ":",
                start + marker.length
            );

        if (colon === -1) {
            break;
        }

        const objectStart =
            html.indexOf(
                "{",
                colon
            );

        if (objectStart === -1) {
            break;
        }

        const objectEnd =
            findMatchingBrace(
                html,
                objectStart
            );

        if (objectEnd === -1) {
            break;
        }

        const jsonText =
            html.substring(
                objectStart,
                objectEnd + 1
            );

        try {

            const job =
                JSON.parse(jsonText);

            if (
                job &&
                job.__typename ===
                "JobListingSearchResult"
            ) {

                jobs.push({
                    ...job,
                    page
                });
            }

        } catch (error) {

            // Some embedded objects may not be valid standalone JSON.
        }

        position =
            objectEnd + 1;
    }

    return jobs;
}


// ======================================================
// FIND MATCHING JSON BRACE
// ======================================================

function findMatchingBrace(
    text,
    start
) {

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (
        let i = start;
        i < text.length;
        i++
    ) {

        const char = text[i];

        if (inString) {

            if (escaped) {

                escaped = false;

            } else if (char === "\\") {

                escaped = true;

            } else if (char === '"') {

                inString = false;
            }

            continue;
        }

        if (char === '"') {

            inString = true;

        } else if (char === "{") {

            depth++;

        } else if (char === "}") {

            depth--;

            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
}


// ======================================================
// FILTER / NORMALIZE
// ======================================================

function normalizeJob(job) {

    return {

        // Basic
        id:
            job.id || null,

        title:
            job.title || null,

        slug:
            job.slug || null,

        job_url:
            job.slug
                ? `https://wellfound.com/jobs/${job.slug}`
                : null,


        // Job
        job_type:
            job.jobType || null,

        primary_role:
            job.primaryRoleTitle || null,

        remote:
            job.remote ?? null,

        remote_config:
            job.remoteConfig || null,

        locations:
            job.locationNames || [],

        accepted_remote_locations:
            job.acceptedRemoteLocationNames || [],


        // Compensation
        compensation:
            job.compensation || null,


        // Experience
        experience_min:
            job.yearsExperienceMin ?? null,

        experience_max:
            job.yearsExperienceMax ?? null,


        // Description
        description:
            job.description || null,


        // ATS
        ats_source:
            job.atsSource || null,

        auto_posted:
            job.autoPosted ?? null,


        // Dates
        live_start_at:
            job.liveStartAt || null,


        // Metadata
        is_bookmarked:
            job.isBookmarked ?? false,


        // Scraper
        source:
            "wellfound",

        page:
            job.page
    };
}


// ======================================================
// SCRAPE ONE PAGE
// ======================================================

async function scrapePage(page) {

    const html =
        await getPage(page);

    if (!html) {

        return {
            page,
            jobs: []
        };
    }

    const jobs =
        extractJobsAlternative(
            html,
            page
        );


    const normalized =
        jobs.map(normalizeJob);


    console.log(
        `[PAGE ${page}] ${normalized.length} jobs`
    );


    return {
        page,
        jobs: normalized
    };
}


// ======================================================
// WORKER POOL
// ======================================================

async function runWorkers() {

    const pages =
        Array.from(
            { length: TOTAL_PAGES },
            (_, i) => i + 1
        );


    const results = [];

    let currentIndex = 0;


    async function worker(workerId) {

        while (true) {

            const index =
                currentIndex++;


            if (
                index >=
                pages.length
            ) {
                break;
            }


            const page =
                pages[index];


            console.log(
                `[WORKER ${workerId}] page ${page}`
            );


            try {

                const result =
                    await scrapePage(page);

                results.push(result);

            } catch (error) {

                console.error(
                    `[WORKER ${workerId}] ERROR page ${page}`,
                    error.message
                );
            }
        }
    }


    const workers = [];


    for (
        let i = 1;
        i <= WORKERS;
        i++
    ) {

        workers.push(
            worker(i)
        );
    }


    await Promise.all(
        workers
    );


    return results;
}


// ======================================================
// REMOVE DUPLICATES
// ======================================================

function removeDuplicates(jobs) {

    const map =
        new Map();


    for (const job of jobs) {

        if (!job.id) {
            continue;
        }

        map.set(
            job.id,
            job
        );
    }


    return [
        ...map.values()
    ];
}


// ======================================================
// MAIN
// ======================================================

async function main() {

    console.log(
        "===================================="
    );

    console.log(
        "WELLFOUND SCRAPER"
    );

    console.log(
        "===================================="
    );

    console.log(
        `Pages: ${TOTAL_PAGES}`
    );

    console.log(
        `Workers: ${WORKERS}`
    );


    const start =
        Date.now();


    const results =
        await runWorkers();


    let jobs =
        results.flatMap(
            result => result.jobs
        );


    console.log(
        `Raw jobs: ${jobs.length}`
    );


    jobs =
        removeDuplicates(
            jobs
        );


    console.log(
        `Unique jobs: ${jobs.length}`
    );


    // Ensure the '../output' directory exists before writing
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Save output file inside project_root/output/wellfound_jobs.json
    fs.writeFileSync(
        OUTPUT_FILE,
        JSON.stringify(
            jobs,
            null,
            2
        ),
        "utf8"
    );


    const seconds =
        (
            (Date.now() - start) /
            1000
        ).toFixed(2);


    console.log(
        "===================================="
    );

    console.log(
        "DONE"
    );

    console.log(
        `Jobs: ${jobs.length}`
    );

    console.log(
        `Time: ${seconds}s`
    );

    console.log(
        `File saved to: ${OUTPUT_FILE}`
    );

    console.log(
        "===================================="
    );
}


// ======================================================
// SLEEP
// ======================================================

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}


main();