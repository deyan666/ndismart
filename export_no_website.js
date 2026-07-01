#!/usr/bin/env node
// Run: node export_no_website.js
// Outputs: no_website_providers.csv with preview links

const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers_data.json'), 'utf8'));

const rows = ['Name,Suburb,State,Phone,Email,Preview URL'];

data.forEach((p, i) => {
  if (p.website && p.website.trim()) return;
  const name    = (p.outlet || p.name || '').replace(/"/g, '""');
  const suburb  = (p.suburb  || '').replace(/"/g, '""');
  const state   = (p.state   || '');
  const phone   = (p.phone   || '');
  const email   = (p.email   || '');
  const url     = `https://ndismart.com.au/preview/${i}`;
  rows.push(`"${name}","${suburb}","${state}","${phone}","${email}","${url}"`);
});

fs.writeFileSync(path.join(__dirname, 'no_website_providers.csv'), rows.join('\n'), 'utf8');
console.log(`Exported ${rows.length - 1} providers to no_website_providers.csv`);
