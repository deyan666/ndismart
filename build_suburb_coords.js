#!/usr/bin/env node
// Run once: node build_suburb_coords.js
// Geocodes all unique suburbs from providers_data.json via Nominatim (free).
// Saves results incrementally to suburb_coords.json.
// Can be safely re-run — already-geocoded suburbs are skipped.

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(__dirname, 'suburb_coords.json');
const DATA_FILE  = path.join(__dirname, 'providers_data.json');
const DELAY_MS   = 1100; // Nominatim hard limit: 1 req/sec

// Load existing cache
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
}

// Extract unique suburb+state pairs, filtering out values that look like addresses
const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

const ADDRESS_RE = /^\d|avenue|street|road|drive|way|lane|place|court|circuit|grove|terrace|close|crescent|boulevard|highway|parade|\//i;

const suburbSet = new Map(); // key -> { suburb, state }
data.forEach(p => {
  const suburb = (p.suburb || '').trim();
  const state  = (p.state  || '').trim();
  if (!suburb || suburb.length < 3) return;
  if (ADDRESS_RE.test(suburb)) return;
  const key = suburb.toLowerCase();
  if (!suburbSet.has(key)) suburbSet.set(key, { suburb, state });
});

const todo = [...suburbSet.entries()].filter(([key]) => !cache[key]);
console.log(`Total unique suburbs: ${suburbSet.size}`);
console.log(`Already cached: ${suburbSet.size - todo.length}`);
console.log(`To geocode: ${todo.length}`);
if (todo.length === 0) { console.log('Nothing to do.'); process.exit(0); }

const eta = Math.round(todo.length * DELAY_MS / 60000);
console.log(`Estimated time: ~${eta} minutes\n`);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = https.get({
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: { 'User-Agent': 'NDISmart suburb geocoder (ndismart.com.au)' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function geocode(suburb, state) {
  const query = state ? `${suburb}, ${state}, Australia` : `${suburb}, Australia`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=au`;
  try {
    const results = await fetchJson(url);
    if (results && results.length > 0) {
      return [parseFloat(results[0].lat), parseFloat(results[0].lon)];
    }
  } catch(e) {
    // silently skip
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  let done = 0;
  let found = 0;

  for (const [key, { suburb, state }] of todo) {
    const coords = await geocode(suburb, state);
    cache[key] = coords; // null means not found — still cache to avoid re-querying
    done++;

    if (coords) {
      found++;
      if (done % 10 === 0 || done <= 5) {
        console.log(`[${done}/${todo.length}] ${suburb}, ${state} → ${coords}`);
      }
    }

    // Save every 50 entries
    if (done % 50 === 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      const pct = ((done / todo.length) * 100).toFixed(1);
      console.log(`Saved (${pct}% done, ${found} found so far)`);
    }

    await sleep(DELAY_MS);
  }

  // Final save (only coords, strip nulls)
  const final = {};
  for (const [k, v] of Object.entries(cache)) {
    if (v) final[k] = v;
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(final));
  console.log(`\nDone. ${Object.keys(final).length} suburbs with coordinates saved to suburb_coords.json`);
})();
