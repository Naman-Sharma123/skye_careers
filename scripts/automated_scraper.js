const { chromium } = require("playwright");
const fs = require("fs");
const cron = require("node-cron");
const { execSync } = require("child_process");

const CONFIG = {
    HIMALAYAS_LIMIT: 250,
    WELLFOUND_LIMIT: 250,
    BATCH_SIZE: 15,
    BATCH_DELAY_MS: 3000,
    HIMALAYAS_JSON: "himalayas_jobs.json",
    WELLFOUND_JSON: "wellfound_jobs.json",
    COMBINED_JSON: "all_jobs.json",
    SYNC_SCRIPT: "sync_to_postgres.js" // Name of your Script 2
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 1. HIMALAYAS API SCRAPER
 */
async function scrapeHimalayas(targetLimit = 250) {
    console.log(`\n==================================================`);
    console.log(`[1/2] FETCHING HIMALAYAS JOBS (Target: ${targetLimit})`);
    console.log(`==================================================`);

    const allRawJobs = [];
    let offset = 0;
    const PAGE_SIZE = 20;

    try {
        while (allRawJobs.length < targetLimit) {
            const url = `https://himalayas.app/jobs/api?limit=${PAGE_SIZE}&offset=${offset}`;
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "application/json"
                }
            });

            if (!response.ok) break;

            const data = await response.json();
            const rawJobs = data.jobs || data.data || [];
            if (rawJobs.length === 0) break;

            allRawJobs.push(...rawJobs);
            console.log(`Himalayas Progress: ${allRawJobs.length}/${targetLimit}`);
            offset += PAGE_SIZE;
            await sleep(500);
        }

        const formattedJobs = allRawJobs.slice(0, targetLimit).map((job) => ({
            source: "Himalayas",
            jobId: String(job.guid || job.id || ""),
            title: job.title || "",
            company: job.companyName || "",
            salary: job.minSalary && job.maxSalary ? `${job.currency || "USD"} ${job.minSalary} - ${job.maxSalary}` : "Not Disclosed",
            location: Array.isArray(job.locationRestrictions) ? job.locationRestrictions.map(x => typeof x === "object" ? x.name : x).join("; ") : "Remote",
            jobUrl: job.applicationLink || job.sourceUrl || "",
            postedAt: job.pubDate ? new Date(job.pubDate * 1000).toISOString().split("T")[0] : "",
            description: job.description || ""
        }));

        fs.writeFileSync(CONFIG.HIMALAYAS_JSON, JSON.stringify(formattedJobs, null, 2));
        return formattedJobs;
    } catch (error) {
        console.error("❌ Himalayas Error:", error.message);
        return [];
    }
}

/**
 * 2. WELLFOUND INTERCEPTOR SCRAPER
 */
async function scrapeWellfound(limit = 250, batchSize = 15, delayMs = 3000) {
    console.log(`\n==================================================`);
    console.log(`[2/2] SCRAPING WELLFOUND JOBS (Target: ${limit})`);
    console.log(`==================================================`);

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();
    const extractedJobs = [];
    const seenJobIds = new Set();

    page.on("response", async (response) => {
        if (response.url().includes("/graphql") && response.status() === 200) {
            try {
                const json = await response.json();
                const jobListings = json?.data?.jobListings?.edges || json?.data?.talentModule?.jobs || [];
                
                for (const edge of jobListings) {
                    const node = edge.node || edge;
                    if (!node || seenJobIds.has(node.id)) continue;

                    seenJobIds.add(node.id);
                    extractedJobs.push({
                        source: "Wellfound",
                        jobId: String(node.id || ""),
                        title: node.title || node.jobTitle || "Position",
                        company: node.company?.name || "Startup",
                        salary: node.compensation || "Not Disclosed",
                        location: "Remote",
                        jobUrl: node.slug ? `https://wellfound.com/jobs/${node.slug}` : "https://wellfound.com/jobs",
                        postedAt: node.postedAt || new Date().toISOString().split("T")[0],
                        description: node.description || ""
                    });
                }
            } catch (e) {
                // Ignore non-JSON/unrelated GraphQL hits
            }
        }
    });

    try {
        console.log("Navigating to Wellfound Remote Jobs...");
        await page.goto("https://wellfound.com/location/remote", { waitUntil: "networkidle" });

        while (extractedJobs.length < limit) {
            const currentCount = extractedJobs.length;
            
            await page.evaluate(() => window.scrollBy(0, 1000));
            await page.waitForTimeout(1500);

            if (extractedJobs.length > 0 && extractedJobs.length % batchSize === 0) {
                console.log(`[Batch Throttler] Reached ${extractedJobs.length} jobs. Pausing for ${delayMs / 1000}s...`);
                await page.waitForTimeout(delayMs);
            }

            if (extractedJobs.length === currentCount) {
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(3000);
                if (extractedJobs.length === currentCount) break;
            }
        }

        const finalJobs = extractedJobs.slice(0, limit);
        fs.writeFileSync(CONFIG.WELLFOUND_JSON, JSON.stringify(finalJobs, null, 2));
        return finalJobs;

    } catch (err) {
        console.error("❌ Wellfound Error:", err.message);
        return [];
    } finally {
        await browser.close();
    }
}

/**
 * MASTER SCRAPE & DB SYNC PIPELINE
 */
async function runPipeline() {
    console.log(`\n==================================================`);
    console.log(`RUNNING JOB SCRAPER PIPELINE AT ${new Date().toISOString()}`);
    console.log(`==================================================`);

    const himalayasData = await scrapeHimalayas(CONFIG.HIMALAYAS_LIMIT);
    const wellfoundData = await scrapeWellfound(CONFIG.WELLFOUND_LIMIT, CONFIG.BATCH_SIZE, CONFIG.BATCH_DELAY_MS);

    const mergedData = [...himalayasData, ...wellfoundData];
    fs.writeFileSync(CONFIG.COMBINED_JSON, JSON.stringify(mergedData, null, 2));

    console.log(`\nScraping complete! Total Saved Jobs: ${mergedData.length}`);

    // Trigger Postgres DB Sync (Script 2)
    if (fs.existsSync(CONFIG.SYNC_SCRIPT)) {
        console.log(`\nExecuting Database Sync via ${CONFIG.SYNC_SCRIPT}...`);
        try {
            const syncOutput = execSync(`node ${CONFIG.SYNC_SCRIPT}`, { encoding: "utf-8" });
            console.log(syncOutput);
        } catch (error) {
            console.error("❌ Error executing database sync script:", error.message);
        }
    } else {
        console.warn(`⚠️ Warning: ${CONFIG.SYNC_SCRIPT} not found in root directory.`);
    }
}

// Execute immediately on startup
runPipeline();

// Schedule to run automatically every hour (at minute 0)
cron.schedule("0 * * * *", () => {
    runPipeline();
});

console.log("\n⏰ Scraper daemon initialized. Running hourly schedule...");