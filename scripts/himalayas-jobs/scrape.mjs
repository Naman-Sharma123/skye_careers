import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Target output path: job-scrapper/output/himalayas_jobs.json
const OUTPUT_DIR = path.resolve(__dirname, '../../output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'himalayas_jobs.json');

const TARGET_JOBS_COUNT = 10000;
const BASE_URL = 'https://himalayas.app/jobs/api';
const DELAY_MS = 250;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ==========================================
// 1. MASTER THREAD LOGIC
// ==========================================
if (isMainThread) {
    const jobsMap = new Map();

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    console.log(`🚀 Master Process Started | Objective: Fetch ${TARGET_JOBS_COUNT} unique jobs in batches...`);

    // Spawns worker thread pointing to this exact same file
    const worker = new Worker(__filename, {
        workerData: { targetCount: TARGET_JOBS_COUNT }
    });

    let batchCounter = 0;

    worker.on('message', (msg) => {
        if (msg.type === 'BATCH') {
            let addedCount = 0;
            for (const job of msg.jobs) {
                const key = job.id || job.url || `${job.title}-${job.company}`;
                if (!jobsMap.has(key)) {
                    jobsMap.set(key, job);
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
                console.log(`🎯 Reached batch cap of ${TARGET_JOBS_COUNT} unique jobs.`);
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
        console.log(`💾 Progress auto-saved: ${dataArray.length} unique jobs stored in output/himalayas_jobs.json`);
    }

    function finishScraping() {
        saveToDisk();
        console.log(`\n🎉 Process Finished! Total unique jobs saved: ${jobsMap.size}`);
        console.log(`👉 File location: ${OUTPUT_FILE}`);
        process.exit(0);
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
                url.searchParams.set('limit', '20'); // Max limit supported per endpoint call
                if (cursor) {
                    url.searchParams.set('cursor', cursor);
                }

                // Standard generalized HTTP headers to mask environment origin
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

                // Pass batch to master thread
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