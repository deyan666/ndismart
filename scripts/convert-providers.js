// One-time script: converts Active_Providers_Australia.csv → providers_data.json
// Run: node scripts/convert-providers.js
const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', '..', '..', '..', 'Downloads', 'Active_Providers_Australia.csv');
const OUT_PATH = path.join(__dirname, '..', 'providers_data.json');

function parseCSV(text) {
  const records = [];
  let i = 0;
  // skip BOM
  if (text.charCodeAt(0) === 0xFEFF) i = 1;

  const len = text.length;

  while (i < len) {
    const row = [];
    // parse one row
    while (i < len) {
      let field = '';
      if (text[i] === '"') {
        i++; // opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else { i++; break; } // closing quote
          } else {
            field += text[i++];
          }
        }
      } else {
        while (i < len && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
          field += text[i++];
        }
      }
      row.push(field.trim());
      if (i < len && text[i] === ',') { i++; continue; }
      break;
    }
    // consume line ending
    if (i < len && text[i] === '\r') i++;
    if (i < len && text[i] === '\n') i++;

    if (row.length >= 2 && row[0]) records.push(row);
  }
  return records;
}

function extractLocation(address) {
  if (!address || address === 'CONFIDENTIAL' || address.trim() === '') {
    return { suburb: '', state: '', postcode: '' };
  }
  // e.g. "12 Kropp Street, Kilcoy, QLD 4515" or "Abbey, Abbey, WA 6280"
  const m = address.match(/,\s*([^,]+),\s*(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\s+(\d{4})\s*$/i);
  if (m) return { suburb: m[1].trim(), state: m[2].toUpperCase(), postcode: m[3] };
  // "Suburb, STATE XXXX" (no street)
  const m2 = address.match(/^([^,]+),\s*(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\s+(\d{4})\s*$/i);
  if (m2) return { suburb: m2[1].trim(), state: m2[2].toUpperCase(), postcode: m2[3] };
  // "STATE XXXX" only
  const m3 = address.match(/\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\s+(\d{4})\s*$/i);
  if (m3) return { suburb: '', state: m3[1].toUpperCase(), postcode: m3[2] };
  return { suburb: '', state: '', postcode: '' };
}

function slugify(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function makeSlug(name, suburb, service) {
  const s = slugify(suburb || 'au');
  const v = slugify((service || 'ndis').substring(0, 40));
  const n = slugify(name);
  return `${s}-${v}-${n}`.replace(/-{2,}/g, '-').substring(0, 100);
}

console.log('Reading CSV…');
const text = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parseCSV(text);
console.log(`Parsed ${rows.length} rows (including header)`);

// Skip header row
const slugSeen = new Map();
const providers = [];

for (let idx = 1; idx < rows.length; idx++) {
  const r = rows[idx];
  const name       = (r[0] || '').trim();
  const address    = (r[1] || '').trim();
  const phone      = (r[2] || '').trim();
  const email      = (r[3] || '').trim();
  const website    = (r[4] || '').trim();
  const abn        = (r[5] || '').trim();
  const hours      = (r[6] || '').trim();
  const profession = (r[7] || '').trim();
  const regGroup   = (r[8] || '').trim();

  if (!name) continue;

  const { suburb, state, postcode } = extractLocation(address);
  const services = regGroup
    ? regGroup.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const baseSlug = makeSlug(name, suburb, services[0]);
  let slug = baseSlug;
  if (slugSeen.has(slug)) {
    const n = slugSeen.get(slug) + 1;
    slugSeen.set(slug, n);
    slug = `${baseSlug}-${n}`;
  } else {
    slugSeen.set(slug, 1);
  }

  const p = { name, suburb, state, postcode, phone, email, website, abn, profession, services, slug, featured: false };
  if (address && address !== 'CONFIDENTIAL') p.address = address;
  if (hours) p.hours = hours;

  providers.push(p);
}

console.log(`Built ${providers.length} providers`);

const json = JSON.stringify(providers);
fs.writeFileSync(OUT_PATH, json);
const mb = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
console.log(`Written providers_data.json — ${mb} MB`);
