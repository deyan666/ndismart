// Generates sitemap.xml from providers_data.json
// Run: node scripts/generate-sitemap.js
const fs = require('fs');
const path = require('path');

const SITE = 'https://ndismart.netlify.app';
const DATA = path.join(__dirname, '..', 'providers_data.json');
const OUT  = path.join(__dirname, '..', 'sitemap.xml');

function slugify(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
function makeSlug(p) {
  const s = slugify(p.suburb || 'au');
  const v = slugify((p.services && p.services[0] ? p.services[0] : 'ndis').substring(0, 40));
  const n = slugify(p.name);
  return `${s}-${v}-${n}`.replace(/-{2,}/g, '-').substring(0, 100);
}

const today = new Date().toISOString().split('T')[0];

console.log('Loading providers…');
const providers = JSON.parse(fs.readFileSync(DATA, 'utf8'));
console.log(`${providers.length} providers`);

const staticUrls = [
  { loc: `${SITE}/`,              priority: '1.0', changefreq: 'daily'   },
  { loc: `${SITE}/ndis-prices.html`, priority: '0.8', changefreq: 'weekly'  },
  { loc: `${SITE}/provider.html`, priority: '0.7', changefreq: 'monthly' },
];

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...staticUrls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`),
  ...providers.map(p => {
    const slug = p.slug || makeSlug(p);
    return `  <url>
    <loc>${SITE}/providers/${slug}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`;
  }),
  '</urlset>',
].join('\n');

fs.writeFileSync(OUT, xml);
const mb = (Buffer.byteLength(xml) / 1024 / 1024).toFixed(1);
console.log(`Written sitemap.xml — ${mb} MB, ${providers.length + staticUrls.length} URLs`);
