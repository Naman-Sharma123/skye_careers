const axios = require('axios');

(async () => {
  try {
    console.log('Sending request to Himalayas API...');

    // Call API with limit parameter and full headers
    const response = await axios.get('https://himalayas.app/api/user-jobs?limit=50', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://himalayas.app/jobs',
        'Origin': 'https://himalayas.app'
      }
    });

    const data = response.data;

    console.log('\n--- DATA ROOT TYPE ---');
    console.log('Is Array?:', Array.isArray(data));
    console.log('Root Object Keys:', Object.keys(data || {}));

    // Find array inside payload
    const rawJobs = Array.isArray(data) ? data : (data.jobs || data.data || data.items || []);

    console.log(`\nFound ${rawJobs.length} job items in array.`);

    if (rawJobs.length > 0) {
      console.log('\n--- KEYS IN FIRST JOB OBJECT ---');
      console.log(Object.keys(rawJobs[0]));

      console.log('\n--- RAW SAMPLE JOB OBJECT ---');
      console.dir(rawJobs[0], { depth: null, colors: true });
    } else {
      console.log('\nRaw response payload snippet:');
      console.log(JSON.stringify(data).slice(0, 500));
    }

  } catch (error) {
    console.error('API Error:', error.response ? `${error.response.status} - ${error.response.statusText}` : error.message);
  }
})();