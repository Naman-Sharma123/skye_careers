import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Output JSON location
const OUTPUT_DIR = path.resolve(__dirname, '../../output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'himalayas_jobs.json');

const TARGET_JOBS_COUNT = 10000;
const BASE_URL = 'https://himalayas.app/jobs/api';
const DELAY_MS = 250;
const JOBS_API_URL = process.env.JOBS_API_URL || 'http://localhost:5000/api/jobs';
const API_BATCH_MAX_BYTES = 700 * 1024;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Utility to convert HTML string into clean formatted plain text
 */
function cleanDescription(html) {
    if (!html) return '';

    return html
        // 1. Convert headers into clean sections
        .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n=== $1 ===\n')
        // 2. Convert bullet list items into clean text bullets
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '• $1\n')
        // 3. Convert paragraphs & line breaks into newlines
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        // 4. Strip all remaining HTML tags
        .replace(/<[^>]+>/g, '')
        // 5. Decode common HTML entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        // 6. Clean up trailing/excessive whitespace
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim();
}

// ==========================================
// 1. MASTER THREAD LOGIC
// ==========================================
if (isMainThread) {
    const jobsMap = new Map();

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    console.log(`🚀 Master Process Started | Objective: Fetch ${TARGET_JOBS_COUNT} unique jobs...`);

    const worker = new Worker(__filename, {
        workerData: { targetCount: TARGET_JOBS_COUNT }
    });

    let batchCounter = 0;
    let isFinishing = false;

    worker.on('message', (msg) => {
        if (msg.type === 'BATCH') {
            let addedCount = 0;
            
            for (const rawJob of msg.jobs) {
                // Process and clean description text
                const formattedJob = {
                    ...rawJob,
                    description: cleanDescription(rawJob.description),
                    excerpt: cleanDescription(rawJob.excerpt)
                };

                const key = formattedJob.id || formattedJob.url || `${formattedJob.title}-${formattedJob.company}`;
                if (!jobsMap.has(key)) {
                    jobsMap.set(key, formattedJob);
                    addedCount++;
                }
            }

            batchCounter++;
            console.log(`[Batch ${batchCounter}] Received ${msg.jobs.length} jobs (${addedCount} new) | Unique Total: ${jobsMap.size}/${TARGET_JOBS_COUNT}`);

            // Flush to disk every 5 batches (~100 items)
            if (batchCounter % 5 === 0) {
                saveToDisk();
            }

            if (jobsMap.size >= TARGET_JOBS_COUNT) {
                console.log(`🎯 Reached target limit of ${TARGET_JOBS_COUNT} unique jobs.`);
                worker.terminate();
                finishScraping();
            }
        } else if (msg.type === 'WARN') {
            console.warn(`⚠️ ${msg.message}`);
        } else if (msg.type === 'ERROR') {
            console.error(`❌ Worker Error: ${msg.error}`);
        } else if (msg.type === 'DONE') {
            console.log(`✅ Extraction complete. Reason: ${msg.reason}`);
            saveToDisk();
            finishScraping();
        }
    });

    worker.on('error', (err) => {
        console.error('❌ Critical Worker Thread Error:', err);
        saveToDisk();
    });

    worker.on('exit', (code) => {
        if (code !== 0 && jobsMap.size < TARGET_JOBS_COUNT) {
            console.warn(`⚠️ Worker process exited unexpectedly with code ${code}`);
        }
    });

    function saveToDisk() {
        const dataArray = Array.from(jobsMap.values());
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(dataArray, null, 2), 'utf-8');
        console.log(`💾 Progress auto-saved: ${dataArray.length} formatted jobs saved to output/himalayas_jobs.json`);
    }

    async function finishScraping() {
        if (isFinishing) return;
        isFinishing = true;
        saveToDisk();
        console.log(`\n🎉 Process Finished! Total unique jobs saved: ${jobsMap.size}`);
        console.log(`👉 File location: ${OUTPUT_FILE}`);
        try {
            const result = await uploadJobs(Array.from(jobsMap.values()));
            console.log(`Database sync complete: ${result.created} created, ${result.duplicates} duplicates, ${result.skipped} skipped.`);
        } catch (error) {
            console.error(`Database sync failed: ${error.message}`);
            console.error(`The scraped JSON is still saved at ${OUTPUT_FILE}. Start the backend and rerun the scraper to try again.`);
            process.exitCode = 1;
        }
    }

    async function uploadJobs(jobs) {
        let batch = [];
        let batchBytes = 0;
        let created = 0;
        let duplicates = 0;
        let skipped = 0;
        let uploaded = 0;

        async function sendBatch() {
            if (batch.length === 0) return;
            const response = await fetch(JOBS_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobs: batch })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.message || `API returned HTTP ${response.status}`);
            created += result.created || 0;
            duplicates += result.duplicates || 0;
            skipped += result.skipped || 0;
            uploaded += batch.length;
            console.log(`Database upload: ${uploaded}/${jobs.length} jobs submitted`);
            batch = [];
            batchBytes = 0;
        }

        for (const job of jobs) {
            const jobBytes = Buffer.byteLength(JSON.stringify(job), 'utf8') + 1;
            if (batch.length && (batch.length >= 500 || batchBytes + jobBytes > API_BATCH_MAX_BYTES)) {
                await sendBatch();
            }
            if (jobBytes > API_BATCH_MAX_BYTES) {
                throw new Error(`Job record exceeds the API request size limit (${jobBytes} bytes)`);
            }
            batch.push(job);
            batchBytes += jobBytes;
        }
        await sendBatch();
        return { created, duplicates, skipped };
    }

// ==========================================
// 2. WORKER THREAD LOGIC
// ==========================================
} else {
    async function runWorker() {
        let cursor = null;
        const maxJobs = workerData?.targetCount || 10000;
        let fetchedCount = 0;

        while (fetchedCount < maxJobs) {
            try {
                const url = new URL(BASE_URL);
                url.searchParams.set('limit', '20');
                if (cursor) {
                    url.searchParams.set('cursor', cursor);
                }

                const response = await fetch(url.toString(), {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'application/json',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Cache-Control': 'no-cache'
                    }
                });

                if (response.status === 429) {
                    parentPort.postMessage({ type: 'WARN', message: 'Rate limited (429). Retrying in 5 seconds...' });
                    await sleep(5000);
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();
                const jobs = data.jobs || [];

                if (jobs.length === 0) {
                    parentPort.postMessage({ type: 'DONE', reason: 'EMPTY_FEED' });
                    break;
                }

                fetchedCount += jobs.length;
                cursor = data.nextCursor;

                parentPort.postMessage({
                    type: 'BATCH',
                    jobs,
                    nextCursor: cursor
                });

                if (!cursor) {
                    parentPort.postMessage({ type: 'DONE', reason: 'END_OF_CURSORS' });
                    break;
                }

                await sleep(DELAY_MS);

            } catch (err) {
                parentPort.postMessage({ type: 'ERROR', error: err.message });
                await sleep(2000);
            }
        }

        parentPort.postMessage({ type: 'DONE', reason: 'TARGET_BATCH_REACHED' });
    }

    runWorker();
}
