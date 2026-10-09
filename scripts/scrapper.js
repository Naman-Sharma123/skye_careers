const fs = require("fs");
const axios = require("axios");

// ======================================================
// CONFIGURATION
// ======================================================

const CONFIG = {
    // Himalayas
    HIMALAYAS_LIMIT: 250,

    // Wellfound
    // NO JOB LIMIT - scrape all available pages
    WELLFOUND_BATCH_SIZE: 15,
    WELLFOUND_BATCH_DELAY_MS: 8000,
    WELLFOUND_PAGE_DELAY_MS: 2000,

    // Output files
    HIMALAYAS_JSON: "himalayas_jobs.json",
    WELLFOUND_JSON: "wellfound_jobs.json",
    COMBINED_JSON: "all_jobs.json"
};


// ======================================================
// SLEEP
// ======================================================

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));


// ======================================================
// 1. HIMALAYAS API SCRAPER
// ======================================================

async function scrapeHimalayas(targetLimit = 250) {

    console.log(`
==================================================
[1/2] FETCHING HIMALAYAS JOBS
Target: ${targetLimit}
==================================================
`);

    const allRawJobs = [];

    let offset = 0;

    const PAGE_SIZE = 20;

    try {

        while (allRawJobs.length < targetLimit) {

            const url =
                `https://himalayas.app/jobs/api?limit=${PAGE_SIZE}&offset=${offset}`;

            console.log(`🌐 GET ${url}`);

            const response = await fetch(url, {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                        "AppleWebKit/537.36 " +
                        "(KHTML, like Gecko) " +
                        "Chrome/124.0.0.0 Safari/537.36",

                    "Accept": "application/json"
                }
            });

            if (!response.ok) {

                console.log(
                    `❌ Himalayas HTTP ${response.status}`
                );

                break;
            }

            const data = await response.json();

            const rawJobs =
                data.jobs ||
                data.data ||
                [];

            if (rawJobs.length === 0) {

                console.log(
                    "⚠️ No more Himalayas jobs."
                );

                break;
            }

            allRawJobs.push(...rawJobs);

            console.log(
                `✅ Himalayas Progress: ` +
                `${allRawJobs.length}/${targetLimit}`
            );

            offset += PAGE_SIZE;

            await sleep(500);
        }


        // ==================================================
        // FORMAT HIMALAYAS JOBS
        // ==================================================

        const formattedJobs =
            allRawJobs
                .slice(0, targetLimit)
                .map((job) => ({

                    source: "Himalayas",

                    jobId:
                        String(
                            job.guid ||
                            job.id ||
                            ""
                        ),

                    title:
                        job.title ||
                        "",

                    company:
                        job.companyName ||
                        "",

                    salary:
                        job.minSalary &&
                        job.maxSalary

                            ? `${job.currency || "USD"} ` +
                              `${job.minSalary} - ${job.maxSalary}`

                            : "Not Disclosed",

                    location:
                        Array.isArray(
                            job.locationRestrictions
                        )

                            ? job.locationRestrictions
                                .map((x) =>
                                    typeof x === "object"
                                        ? x.name
                                        : x
                                )
                                .join("; ")

                            : "Remote",

                    jobUrl:
                        job.applicationLink ||
                        job.sourceUrl ||
                        "",

                    postedAt:
                        job.pubDate

                            ? new Date(
                                job.pubDate * 1000
                            )
                                .toISOString()
                                .split("T")[0]

                            : "",

                    description:
                        job.description ||
                        ""
                }));


        // ==================================================
        // SAVE HIMALAYAS
        // ==================================================

        fs.writeFileSync(
            CONFIG.HIMALAYAS_JSON,
            JSON.stringify(
                formattedJobs,
                null,
                2
            )
        );


        console.log(`
==================================================
✅ HIMALAYAS COMPLETE
Jobs: ${formattedJobs.length}
File: ${CONFIG.HIMALAYAS_JSON}
==================================================
`);


        return formattedJobs;

    } catch (error) {

        console.error(
            "❌ Himalayas Error:",
            error.message
        );

        return [];
    }
}


// ======================================================
// 2. WELLFOUND GET REQUEST SCRAPER
// ======================================================

async function scrapeWellfound() {

    console.log(`
==================================================
[2/2] SCRAPING ALL WELLFOUND JOBS
==================================================
`);


    const extractedJobs = [];

    const seenJobIds = new Set();


    // ==================================================
    // AXIOS HEADERS
    // ==================================================

    const headers = {

        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 " +
            "(KHTML, like Gecko) " +
            "Chrome/124.0.0.0 Safari/537.36",

        "Accept":
            "text/html,application/xhtml+xml," +
            "application/xml;q=0.9," +
            "image/avif,image/webp," +
            "*/*;q=0.8",

        "Accept-Language":
            "en-US,en;q=0.9",

        "Cache-Control":
            "no-cache",

        "Pragma":
            "no-cache"
    };


    // ==================================================
    // SCRAPE ONE WELLFOUND PAGE
    // ==================================================

    async function scrapePage(pageNumber) {

        const url =
            pageNumber === 1
                ? "https://wellfound.com/remote"
                : `https://wellfound.com/remote?page=${pageNumber}`;


        console.log(
            `\n🌐 GET Wellfound Page ${pageNumber}`
        );

        console.log(url);


        try {

            const response =
                await axios.get(url, {

                    headers,

                    timeout: 60000,

                    // Don't automatically throw for HTTP errors
                    validateStatus: () => true
                });


            console.log(
                `📥 HTTP Status: ${response.status}`
            );


            // ==================================================
            // HTTP ERROR
            // ==================================================

            if (response.status !== 200) {

                console.log(
                    `❌ Wellfound returned HTTP ${response.status}`
                );

                return {
                    jobs: [],
                    pageCount: null
                };
            }


            const html =
                response.data;


            console.log(
                `📦 HTML size: ${html.length} characters`
            );


            // ==================================================
            // CHECK CLOUDFLARE
            // ==================================================

            const cloudflareDetected =
                html.includes("cf-turnstile") ||
                html.includes("Just a moment...") ||
                html.includes("Cloudflare");


            if (cloudflareDetected) {

                console.log(
                    "⚠️ Cloudflare/Turnstile page detected."
                );

                return {
                    jobs: [],
                    pageCount: null
                };
            }


            // ==================================================
            // EXTRACT __NEXT_DATA__
            // ==================================================

            const nextDataMatch =
                html.match(
                    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
                );


            if (!nextDataMatch) {

                console.log(
                    `❌ __NEXT_DATA__ not found on page ${pageNumber}`
                );

                return {
                    jobs: [],
                    pageCount: null
                };
            }


            let nextData;


            try {

                nextData =
                    JSON.parse(
                        nextDataMatch[1]
                    );

            } catch (parseError) {

                console.log(
                    "❌ Failed to parse __NEXT_DATA__"
                );

                return {
                    jobs: [],
                    pageCount: null
                };
            }


            // ==================================================
            // GET APOLLO STATE
            // ==================================================

            const apolloState =
                nextData
                    ?.props
                    ?.pageProps
                    ?.apolloState
                    ?.data;


            if (!apolloState) {

                console.log(
                    `❌ Apollo state not found on page ${pageNumber}`
                );

                return {
                    jobs: [],
                    pageCount: null
                };
            }


            // ==================================================
            // ROOT QUERY
            // ==================================================

            const rootQuery =
                apolloState.ROOT_QUERY;


            if (!rootQuery) {

                console.log(
                    "❌ ROOT_QUERY not found"
                );

                return {
                    jobs: [],
                    pageCount: null
                };
            }


            // ==================================================
            // FIND PAGINATION RESULT
            // ==================================================

            const searchResultKey =
                Object.keys(rootQuery).find(
                    (key) => {

                        return (
                            key.startsWith(
                                "seoLandingPageJobSearchResults("
                            ) &&
                            key.includes(
                                `"page":${pageNumber}`
                            )
                        );
                    }
                );


            if (!searchResultKey) {

                console.log(
                    `❌ Search result not found for page ${pageNumber}`
                );

                return {
                    jobs: [],
                    pageCount: null
                };
            }


            const results =
                rootQuery[
                    searchResultKey
                ];


            // ==================================================
            // PAGINATION INFORMATION
            // ==================================================

            const pageCount =
                results?.pageCount ||
                null;


            const totalJobCount =
                results?.totalJobCount ||
                null;


            const perPage =
                results?.perPage ||
                null;


            console.log(
                `📊 Total jobs: ${totalJobCount}`
            );

            console.log(
                `📄 Jobs per page: ${perPage}`
            );

            console.log(
                `📑 Total pages: ${pageCount}`
            );


            // ==================================================
            // FIND JOB RECORDS
            // ==================================================

            const jobs = [];


            for (
                const [key, value]
                of Object.entries(apolloState)
            ) {

                if (
                    !key.startsWith(
                        "JobListingSearchResult:"
                    )
                ) {
                    continue;
                }


                if (
                    value &&
                    value.__typename ===
                        "JobListingSearchResult"
                ) {

                    jobs.push(value);
                }
            }


            console.log(
                `🔎 Apollo job records: ${jobs.length}`
            );


            return {
                jobs,
                pageCount
            };


        } catch (error) {

            console.error(
                `❌ Page ${pageNumber} request error:`,
                error.message
            );


            return {
                jobs: [],
                pageCount: null
            };
        }
    }


    // ==================================================
    // PAGINATION
    // ==================================================

    let currentPage = 1;

    let totalPages = null;


    while (
        totalPages === null ||
        currentPage <= totalPages
    ) {

        console.log(`
--------------------------------------------------
📄 WELLFOUND PAGE ${currentPage}
--------------------------------------------------
`);


        const result =
            await scrapePage(
                currentPage
            );


        // ==================================================
        // GET TOTAL PAGE COUNT
        // ==================================================

        if (
            result.pageCount &&
            !totalPages
        ) {

            totalPages =
                result.pageCount;

        }


        // ==================================================
        // NO JOBS
        // ==================================================

        if (
            result.jobs.length === 0
        ) {

            console.log(
                `⚠️ No jobs found on page ${currentPage}.`
            );

            console.log(
                "🛑 Stopping pagination."
            );

            break;
        }


        // ==================================================
        // PROCESS JOBS
        // ==================================================

        let newJobs = 0;


        for (
            const job
            of result.jobs
        ) {

            const jobId =
                String(
                    job.id ||
                    job.jobId ||
                    job.slug ||
                    ""
                );


            if (!jobId) {
                continue;
            }


            // ==================================================
            // DUPLICATE CHECK
            // ==================================================

            if (
                seenJobIds.has(jobId)
            ) {

                continue;
            }


            seenJobIds.add(
                jobId
            );


            // ==================================================
            // JOB URL
            // ==================================================

            let jobUrl = "";


            if (job.slug) {

                jobUrl =
                    `https://wellfound.com/jobs/${job.slug}`;

            } else if (job.id) {

                jobUrl =
                    `https://wellfound.com/jobs/${job.id}`;
            }


            // ==================================================
            // COMPANY
            // ==================================================

            let company =
                "Startup";


            if (
                job.companyName
            ) {

                company =
                    job.companyName;

            } else if (
                job.company?.name
            ) {

                company =
                    job.company.name;

            }


            // ==================================================
            // LOCATION
            // ==================================================

            let location =
                "Remote";


            if (
                Array.isArray(
                    job.locationNames
                ) &&
                job.locationNames.length
            ) {

                location =
                    job.locationNames.join(
                        ", "
                    );
            }


            // ==================================================
            // POSTED DATE
            // ==================================================

            let postedAt =
                new Date()
                    .toISOString()
                    .split("T")[0];


            if (
                job.liveStartAt
            ) {

                try {

                    postedAt =
                        new Date(
                            job.liveStartAt * 1000
                        )
                            .toISOString()
                            .split("T")[0];

                } catch (_) {
                    // Keep today's date
                }
            }


            // ==================================================
            // SAVE JOB
            // ==================================================

            extractedJobs.push({

                source:
                    "Wellfound",

                jobId:
                    jobId,

                title:
                    job.title?.trim() ||
                    "Position",

                company:
                    String(company).trim(),

                salary:
                    job.compensation?.trim() ||
                    "Not Disclosed",

                location:
                    location,

                jobUrl:
                    jobUrl,

                postedAt:
                    postedAt,

                description:
                    job.description ||
                    "",

                jobType:
                    job.jobType ||
                    "",

                role:
                    job.primaryRoleTitle ||
                    "",

                remote:
                    job.remote ||
                    false,

                acceptedRemoteLocations:
                    job.acceptedRemoteLocationNames ||
                    []
            });


            newJobs++;
        }


        // ==================================================
        // PROGRESS
        // ==================================================

        console.log(
            `✅ Page ${currentPage}: ` +
            `${newJobs} new jobs`
        );


        console.log(
            `📊 Total unique jobs: ` +
            `${extractedJobs.length}`
        );


        // ==================================================
        // SAVE PROGRESS AFTER EVERY PAGE
        // ==================================================

        fs.writeFileSync(
            CONFIG.WELLFOUND_JSON,
            JSON.stringify(
                extractedJobs,
                null,
                2
            )
        );


        console.log(
            `💾 Progress saved to ${CONFIG.WELLFOUND_JSON}`
        );


        // ==================================================
        // BATCH DELAY
        // ==================================================

        if (
            currentPage %
            CONFIG.WELLFOUND_BATCH_SIZE === 0
        ) {

            console.log(
                `\n⏳ Completed ${CONFIG.WELLFOUND_BATCH_SIZE} pages.`
            );

            console.log(
                `⏸️ Waiting ${
                    CONFIG.WELLFOUND_BATCH_DELAY_MS / 1000
                } seconds...`
            );


            await sleep(
                CONFIG.WELLFOUND_BATCH_DELAY_MS
            );

        } else {

            await sleep(
                CONFIG.WELLFOUND_PAGE_DELAY_MS
            );
        }


        // ==================================================
        // NEXT PAGE
        // ==================================================

        currentPage++;


        if (
            totalPages &&
            currentPage <= totalPages
        ) {

            console.log(
                `➡️ Moving to Page ${currentPage}/${totalPages}`
            );

        }
    }


    // ==================================================
    // FINAL SAVE
    // ==================================================

    fs.writeFileSync(
        CONFIG.WELLFOUND_JSON,
        JSON.stringify(
            extractedJobs,
            null,
            2
        )
    );


    console.log(`
==================================================
🎉 WELLFOUND SCRAPING COMPLETE
==================================================
📊 Total unique jobs: ${extractedJobs.length}
📄 Pages scraped: ${currentPage - 1}
📁 File: ${CONFIG.WELLFOUND_JSON}
==================================================
`);


    return extractedJobs;
}


// ======================================================
// 3. RUN COMPLETE SCRAPER
// ======================================================

async function runStandaloneTest() {

    console.log(`
==================================================
🚀 STARTING JOB SCRAPER
${new Date().toISOString()}
==================================================
`);


    // ==================================================
    // HIMALAYAS
    // ==================================================

    const himalayasData =
        await scrapeHimalayas(
            CONFIG.HIMALAYAS_LIMIT
        );


    // ==================================================
    // WELLFOUND
    // ==================================================

    const wellfoundData =
        await scrapeWellfound();


    // ==================================================
    // COMBINE
    // ==================================================

    const mergedData = [
        ...himalayasData,
        ...wellfoundData
    ];


    // ==================================================
    // SAVE COMBINED
    // ==================================================

    fs.writeFileSync(
        CONFIG.COMBINED_JSON,
        JSON.stringify(
            mergedData,
            null,
            2
        )
    );


    // ==================================================
    // FINAL SUMMARY
    // ==================================================

    console.log(`
==================================================
🎉 SCRAPING FINISHED SUCCESSFULLY
==================================================
Himalayas Jobs : ${himalayasData.length}
Wellfound Jobs : ${wellfoundData.length}
Total Combined : ${mergedData.length}

Saved:
${CONFIG.HIMALAYAS_JSON}
${CONFIG.WELLFOUND_JSON}
${CONFIG.COMBINED_JSON}
==================================================
`);
}


// ======================================================
// START
// ======================================================

runStandaloneTest();