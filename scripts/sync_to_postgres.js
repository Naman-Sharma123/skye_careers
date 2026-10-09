/**
 * Helper to safely convert relative string dates ("3 days ago") to real Date strings
 */
function parseToDate(dateStr) {
    if (!dateStr) return null;
    
    // ISO or YYYY-MM-DD already
    if (!isNaN(Date.parse(dateStr))) {
        return new Date(dateStr).toISOString().split('T')[0];
    }

    const lower = dateStr.toLowerCase();
    const now = new Date();

    if (lower.includes('today')) return now.toISOString().split('T')[0];
    if (lower.includes('yesterday')) {
        now.setDate(now.getDate() - 1);
        return now.toISOString().split('T')[0];
    }

    const match = lower.match(/(\d+)\s+(day|week|month)s?\s+ago/);
    if (match) {
        const num = parseInt(match[1], 10);
        const unit = match[2];
        if (unit === 'day') now.setDate(now.getDate() - num);
        if (unit === 'week') now.setDate(now.getDate() - (num * 7));
        if (unit === 'month') now.setMonth(now.getMonth() - num);
        return now.toISOString().split('T')[0];
    }

    return null; // Fallback if non-parsable
}

// Updated Upsert Query against 'remote_jobs'
const upsertQuery = `
    INSERT INTO remote_jobs 
        (source, job_id, title, company, salary, location, job_url, posted_at, description, updated_at)
    VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
    ON CONFLICT (source, job_id) 
    DO UPDATE SET
        title = EXCLUDED.title,
        company = EXCLUDED.company,
        salary = EXCLUDED.salary,
        location = EXCLUDED.location,
        job_url = EXCLUDED.job_url,
        posted_at = EXCLUDED.posted_at,
        description = EXCLUDED.description,
        updated_at = CURRENT_TIMESTAMP;
`;

// Execution inside your batch loop
await client.query(upsertQuery, [
    job.source || 'Unknown',
    String(job.jobId || job.jobUrl),
    job.title || 'Position',
    job.company || null,
    job.salary || null,
    job.location || null,
    job.jobUrl,
    parseToDate(job.postedAt), // Safe conversion to DATE
    job.description || null
]);