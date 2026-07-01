const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Load providers once at startup and cache in memory
let cachedProviders = null;
let suburbCoords = {};

function loadSuburbCoords() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'suburb_coords.json'), 'utf8');
    suburbCoords = JSON.parse(raw);
    console.log(`Loaded ${Object.keys(suburbCoords).length} suburb coordinates`);
  } catch (e) {
    console.log('suburb_coords.json not found — run build_suburb_coords.js to generate it');
  }
}

// Featured provider overrides — matched by name (case-insensitive) + suburb
const FEATURED_OVERRIDES = [
  { name: 'We Love With Care Disability Services', suburb: 'Regents Park' },
];

function isFeaturedOverride(p) {
  return FEATURED_OVERRIDES.some(f =>
    (p.name || '').toLowerCase() === f.name.toLowerCase() &&
    (p.suburb || '').toLowerCase() === f.suburb.toLowerCase()
  );
}

function getProviders() {
  if (cachedProviders) return cachedProviders;
  loadSuburbCoords();
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'providers_data.json'), 'utf8');
    const providers = JSON.parse(raw);
    providers.forEach(p => {
      const key = (p.suburb || '').toLowerCase().trim();
      if (key && suburbCoords[key]) {
        p._coords = suburbCoords[key];
      }
      if (isFeaturedOverride(p)) {
        p.featured = true;
      }
    });
    cachedProviders = providers;
    console.log(`Loaded ${cachedProviders.length} providers`);
  } catch (e) {
    console.error('Failed to load providers_data.json:', e.message);
    cachedProviders = [];
  }
  return cachedProviders;
}
getProviders();

app.use(compression());

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ndis_directory.html'));
});

// Suburb autocomplete — builds one entry per unique (name, state, postcode) combination
let suburbIndex = null;
function getSuburbIndex() {
  if (suburbIndex) return suburbIndex;
  // Collect all (suburb, state, postcode) combos from providers
  const variantMap = {}; // name -> Map of "state|postcode" -> {state, postcode}
  getProviders().forEach(p => {
    const name = (p.suburb || '').toLowerCase().trim();
    if (!name || !suburbCoords[name]) return;
    const state    = (p.state    || '').toUpperCase();
    const postcode = (p.postcode || '');
    const key = `${state}|${postcode}`;
    if (!variantMap[name]) variantMap[name] = new Map();
    if (!variantMap[name].has(key)) variantMap[name].set(key, { state, postcode });
  });
  const entries = [];
  Object.keys(suburbCoords).sort().forEach(name => {
    const variants = variantMap[name];
    if (variants && variants.size > 0) {
      variants.forEach(({ state, postcode }) => entries.push({ name, state, postcode }));
    } else {
      entries.push({ name, state: '', postcode: '' });
    }
  });
  suburbIndex = entries;
  return suburbIndex;
}

app.get('/api/suburbs', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q || q.length < 2) return res.json([]);
  const index = getSuburbIndex();
  const isPostcode = /^\d+$/.test(q);
  if (isPostcode) {
    // postcode search — match by postcode prefix
    const matches = index.filter(s => s.postcode && s.postcode.startsWith(q));
    return res.json(matches.slice(0, 10));
  }
  const prefix   = index.filter(s => s.name.startsWith(q));
  const contains = index.filter(s => !s.name.startsWith(q) && s.name.includes(q));
  res.json([...prefix, ...contains].slice(0, 10));
});

// Build a postcode → coords lookup (first suburb with coords for that postcode)
let postcodeToCoords = null;
function getPostcodeToCoords() {
  if (postcodeToCoords) return postcodeToCoords;
  postcodeToCoords = {};
  getProviders().forEach(p => {
    const pc = (p.postcode || '');
    if (pc && !postcodeToCoords[pc] && p._coords) {
      postcodeToCoords[pc] = p._coords;
    }
  });
  return postcodeToCoords;
}

// Geocode a suburb or postcode using the local suburb_coords cache
app.get('/api/geocode', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json(null);

  // Exact suburb name match
  if (suburbCoords[q]) return res.json(suburbCoords[q]);

  // Postcode match
  if (/^\d+$/.test(q)) {
    const pc = getPostcodeToCoords();
    if (pc[q]) return res.json(pc[q]);
    // Also scan providers
    const byPostcode = getProviders().find(p => (p.postcode || '') === q && p._coords);
    if (byPostcode) return res.json(byPostcode._coords);
    return res.json(null);
  }

  // Prefix / contains match
  for (const [k, v] of Object.entries(suburbCoords)) {
    if (k.startsWith(q)) return res.json(v);
  }
  for (const [k, v] of Object.entries(suburbCoords)) {
    if (k.includes(q)) return res.json(v);
  }

  res.json(null);
});

// Lightweight map pins — all providers that have coordinates, slim fields only
let mapPinsCache = null;
app.get('/api/map-pins', (req, res) => {
  if (!mapPinsCache) {
    const providers = getProviders();
    mapPinsCache = providers
      .filter(p => p._coords)
      .map(p => ({
        name:     (p.outlet || p.name || '').replace(/^\([^)]+\)\s*/i, ''),
        suburb:   p.suburb   || '',
        state:    p.state    || '',
        _coords:  p._coords,
        featured: p.featured || false,
        services: p.services || [],
        phone:    p.phone    || null,
        slug:     p.slug     || null,
      }));
    console.log(`Map pins cached: ${mapPinsCache.length} providers with coords`);
  }
  res.json(mapPinsCache);
});

// Provider preview page — personalised demo website for a specific provider
app.get('/preview/:id', (req, res) => {
  const providers = getProviders();
  const id = parseInt(req.params.id, 10);
  const p = providers[id];
  if (!p) return res.status(404).send('Provider not found');

  const name     = (p.outlet || p.name || '').replace(/^\([^)]+\)\s*/i, '');
  const suburb   = p.suburb   || '';
  const state    = p.state    || '';
  const postcode = p.postcode || '';
  const phone    = p.phone    || '';
  const email    = p.email    || '';
  const services = (p.services || []);
  const location = [suburb, state, postcode].filter(Boolean).join(', ');
  const shortLoc = [suburb, state].filter(Boolean).join(', ') || 'Australia';
  const initials = name.replace(/[^a-zA-Z\s]/g,'').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase() || '?';
  const shortName = name.split(' ').slice(0,3).join(' ');

  const PALETTES = [
    { primary:'#7C3AED', dark:'#5B21B6', light:'#EDE9FE', text:'#5B21B6' },
    { primary:'#0891B2', dark:'#0E7490', light:'#CFFAFE', text:'#0E7490' },
    { primary:'#059669', dark:'#047857', light:'#D1FAE5', text:'#047857' },
    { primary:'#DC2626', dark:'#B91C1C', light:'#FEE2E2', text:'#B91C1C' },
    { primary:'#D97706', dark:'#B45309', light:'#FEF3C7', text:'#B45309' },
    { primary:'#2563EB', dark:'#1D4ED8', light:'#DBEAFE', text:'#1D4ED8' },
    { primary:'#DB2777', dark:'#BE185D', light:'#FCE7F3', text:'#BE185D' },
    { primary:'#0D9488', dark:'#0F766E', light:'#CCFBF1', text:'#0F766E' },
  ];
  const pal = PALETTES[id % PALETTES.length];

  const SVC_MAP = {
    'plan management':         { icon:'📋', desc:'Budget tracking & invoice management' },
    'support coordination':    { icon:'🤝', desc:'Connecting you with the right supports' },
    'therapeutic':             { icon:'🧠', desc:'OT, speech, psychology & physio' },
    'daily personal':          { icon:'🏃', desc:'Personal care & daily living support' },
    'high intensity':          { icon:'💪', desc:'Complex & high-needs personal care' },
    'behaviour':               { icon:'💬', desc:'Positive behaviour strategies & support' },
    'accommodation':           { icon:'🏠', desc:'Specialist disability accommodation' },
    'group':                   { icon:'👥', desc:'Social & community group programs' },
    'early intervention':      { icon:'👶', desc:'Early childhood development support' },
    'community nursing':       { icon:'💊', desc:'In-home clinical nursing care' },
    'mobility':                { icon:'♿', desc:'Wheelchairs, aids & mobility equipment' },
    'home modification':       { icon:'🔨', desc:'Accessible home design & modifications' },
    'travel':                  { icon:'🚗', desc:'Getting to & from your supports' },
    'transport':               { icon:'🚗', desc:'Safe transport to appointments' },
    'assistive':               { icon:'🦾', desc:'Technology & assistive devices' },
    'community participation': { icon:'🌍', desc:'Social & civic community involvement' },
    'employment':              { icon:'💼', desc:'Job skills & workplace support' },
    'household':               { icon:'🏡', desc:'Domestic tasks & home help' },
  };
  function getSvcMeta(svc) {
    const s = svc.toLowerCase();
    for (const [k, v] of Object.entries(SVC_MAP)) { if (s.includes(k)) return v; }
    return { icon: '✅', desc: 'Personalised support for your needs' };
  }

  const svcCards = services.map(s => {
    const m = getSvcMeta(s);
    return `<div class="svc-card">
      <div class="svc-card-icon" style="background:${pal.light};color:${pal.text}">${m.icon}</div>
      <div class="svc-card-body">
        <h4>${s}</h4>
        <p>${m.desc}</p>
      </div>
    </div>`;
  }).join('');

  const statCount = services.length || '—';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — NDIS Support Provider${suburb ? ' | ' + suburb : ''}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;color:#111827;background:#fff;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
img{max-width:100%}

/* ── BANNER ── */
.preview-banner{background:linear-gradient(90deg,#1E1B4B,#4C1D95);color:#fff;padding:11px 24px;text-align:center;font-size:13.5px;font-weight:500;position:relative;z-index:200}
.preview-banner a{color:#FCD34D;font-weight:700;margin-left:6px;border-bottom:1px solid #FCD34D40}
.preview-banner a:hover{border-bottom-color:#FCD34D}

/* ── NAV ── */
.nav{background:rgba(255,255,255,.95);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid #F3F4F6;position:sticky;top:0;z-index:100;padding:0 5vw}
.nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:70px}
.nav-logo{font-family:'Poppins',sans-serif;font-size:18px;font-weight:800;color:#111827;letter-spacing:-.02em}
.nav-logo em{font-style:normal;color:${pal.primary}}
.nav-links{display:flex;gap:32px;font-size:14px;font-weight:500;color:#4B5563}
.nav-links a:hover{color:${pal.primary}}
.nav-cta{background:${pal.primary};color:#fff;padding:10px 22px;border-radius:100px;font-size:13.5px;font-weight:600;letter-spacing:.01em;transition:opacity .2s}
.nav-cta:hover{opacity:.88}

/* ── HERO ── */
.hero{background:linear-gradient(140deg,#0F0C29 0%,#302B63 45%,#24243E 100%);position:relative;overflow:hidden;padding:90px 5vw 80px}
.hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 80% 60% at 70% 40%,${pal.primary}55,transparent 60%),radial-gradient(ellipse 50% 40% at 20% 80%,${pal.dark}33,transparent 55%)}
.hero-inner{max-width:1200px;margin:0 auto;position:relative;z-index:2;display:grid;grid-template-columns:1fr 420px;gap:64px;align-items:center}
.hero-badge{display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#fff;padding:7px 16px;border-radius:100px;font-size:12.5px;font-weight:600;margin-bottom:22px;letter-spacing:.01em;backdrop-filter:blur(6px)}
.hero-badge span{width:7px;height:7px;background:#4ADE80;border-radius:50%;flex-shrink:0;box-shadow:0 0 8px #4ADE80}
.hero h1{font-family:'Poppins',sans-serif;font-size:clamp(34px,4.5vw,62px);font-weight:900;color:#fff;line-height:1.06;letter-spacing:-.03em;margin-bottom:20px}
.hero h1 em{font-style:italic;color:${pal.primary === '#7C3AED' ? '#A78BFA' : pal.primary};background:linear-gradient(90deg,${pal.primary === '#7C3AED' ? '#A78BFA' : pal.primary},${pal.primary === '#7C3AED' ? '#C4B5FD' : pal.light});-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-sub{font-size:17px;color:rgba(255,255,255,.72);line-height:1.65;max-width:50ch;margin-bottom:36px}
.hero-btns{display:flex;gap:14px;flex-wrap:wrap}
.btn-hero-primary{background:${pal.primary};color:#fff;padding:15px 30px;border-radius:12px;font-size:15px;font-weight:700;display:inline-flex;align-items:center;gap:8px;box-shadow:0 4px 20px ${pal.primary}66;transition:transform .2s,box-shadow .2s}
.btn-hero-primary:hover{transform:translateY(-2px);box-shadow:0 8px 28px ${pal.primary}88}
.btn-hero-secondary{background:rgba(255,255,255,.1);color:#fff;padding:15px 30px;border-radius:12px;font-size:15px;font-weight:600;border:1.5px solid rgba(255,255,255,.25);display:inline-flex;align-items:center;gap:8px;backdrop-filter:blur(8px);transition:background .2s}
.btn-hero-secondary:hover{background:rgba(255,255,255,.18)}
.hero-card{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:24px;padding:28px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.hero-card-avatar{width:60px;height:60px;border-radius:16px;background:linear-gradient(135deg,${pal.primary},${pal.dark});display:flex;align-items:center;justify-content:center;font-family:'Poppins',sans-serif;font-size:22px;font-weight:800;color:#fff;margin-bottom:16px;box-shadow:0 4px 16px ${pal.primary}55}
.hero-card h3{font-family:'Poppins',sans-serif;font-size:17px;font-weight:800;color:#fff;margin-bottom:4px}
.hero-card-loc{font-size:13px;color:rgba(255,255,255,.6);margin-bottom:18px;display:flex;align-items:center;gap:5px}
.hero-card-stat{display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,.08);border-radius:10px;padding:10px 14px;margin-bottom:8px}
.hero-card-stat span{font-size:13px;color:rgba(255,255,255,.7)}
.hero-card-stat strong{font-size:13px;font-weight:700;color:#fff}
.hero-card-ndis{display:flex;align-items:center;gap:8px;background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.3);border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600;color:#4ADE80;margin-top:4px}

/* ── STATS BAR ── */
.stats-bar{background:#fff;border-bottom:1px solid #F3F4F6;padding:0 5vw}
.stats-bar-inner{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);divide-x:1px solid #F3F4F6}
.stat-item{padding:28px 32px;border-right:1px solid #F3F4F6;text-align:center}
.stat-item:last-child{border-right:none}
.stat-num{font-family:'Poppins',sans-serif;font-size:36px;font-weight:900;color:${pal.primary};letter-spacing:-.03em;line-height:1}
.stat-label{font-size:13px;color:#6B7280;margin-top:5px;font-weight:500}

/* ── SECTION WRAPPER ── */
.section-wrap{max-width:1200px;margin:0 auto;padding:80px 5vw}
.full-wrap{padding:80px 5vw}
.section-eyebrow{font-size:12px;font-weight:700;color:${pal.primary};text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px}
.section-h2{font-family:'Poppins',sans-serif;font-size:clamp(26px,3.5vw,42px);font-weight:800;color:#111827;line-height:1.1;letter-spacing:-.025em;margin-bottom:14px}
.section-h2 em{font-style:italic;color:${pal.primary}}
.section-sub{font-size:16px;color:#6B7280;line-height:1.65;max-width:54ch;margin-bottom:48px}

/* ── SERVICES ── */
.services-bg{background:#F9FAFB}
.svc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.svc-card{background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:20px;display:flex;gap:16px;align-items:flex-start;transition:all .22s;cursor:default}
.svc-card:hover{border-color:${pal.primary};box-shadow:0 4px 20px ${pal.primary}1a;transform:translateY(-2px)}
.svc-card-icon{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.svc-card-body h4{font-size:14px;font-weight:700;color:#111827;margin-bottom:3px;line-height:1.3}
.svc-card-body p{font-size:12.5px;color:#6B7280;line-height:1.5}

/* ── ABOUT / VALUES ── */
.about-grid{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}
.about-visual{background:linear-gradient(140deg,${pal.primary}18,${pal.dark}0d);border-radius:24px;padding:40px;display:grid;grid-template-columns:1fr 1fr;gap:14px}
.value-chip{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:20px;text-align:center}
.value-chip-icon{font-size:30px;margin-bottom:10px}
.value-chip h4{font-size:13.5px;font-weight:700;color:#111827;line-height:1.3}
.about-text .section-sub{margin-bottom:32px}
.about-checks{display:flex;flex-direction:column;gap:14px}
.about-check{display:flex;align-items:flex-start;gap:12px;font-size:14.5px;color:#374151;line-height:1.5}
.check-dot{width:22px;height:22px;border-radius:6px;background:${pal.light};color:${pal.text};display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;margin-top:1px;font-weight:700}

/* ── PROCESS ── */
.process-bg{background:linear-gradient(135deg,#0F0C29,#302B63)}
.process-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
.process-card{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:28px 24px;position:relative}
.process-num{font-family:'Poppins',sans-serif;font-size:42px;font-weight:900;color:${pal.primary};opacity:.6;line-height:1;margin-bottom:12px}
.process-card h4{font-size:16px;font-weight:700;color:#fff;margin-bottom:8px}
.process-card p{font-size:13px;color:rgba(255,255,255,.6);line-height:1.55}
.process-tag{display:inline-block;background:${pal.primary}33;border:1px solid ${pal.primary}55;color:${pal.light};font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:14px}

/* ── TESTIMONIALS ── */
.testi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.testi-card{background:#fff;border:1px solid #E5E7EB;border-radius:20px;padding:28px;display:flex;flex-direction:column;gap:16px;box-shadow:0 2px 12px rgba(0,0,0,.04)}
.testi-stars{color:#F59E0B;font-size:16px;letter-spacing:1px}
.testi-quote{font-size:15px;color:#374151;line-height:1.65;flex:1;font-style:italic}
.testi-author{display:flex;align-items:center;gap:12px}
.testi-avatar{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,${pal.primary},${pal.dark});display:flex;align-items:center;justify-content:center;font-family:'Poppins',sans-serif;font-weight:800;color:#fff;font-size:14px;flex-shrink:0}
.testi-name{font-size:13.5px;font-weight:700;color:#111827}
.testi-role{font-size:12px;color:#9CA3AF}

/* ── CONTACT ── */
.contact-bg{background:#F9FAFB}
.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:flex-start}
.contact-info-block h3{font-family:'Poppins',sans-serif;font-size:22px;font-weight:800;color:#111827;margin-bottom:10px}
.contact-info-block p{font-size:15px;color:#6B7280;line-height:1.65;margin-bottom:28px}
.contact-detail{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.contact-detail-icon{width:44px;height:44px;border-radius:12px;background:${pal.light};color:${pal.text};display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.contact-detail-text{font-size:14px;color:#374151}
.contact-detail-text strong{display:block;font-size:12px;color:#9CA3AF;font-weight:500;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
.contact-detail-text a{color:${pal.primary};font-weight:600}
.contact-form-card{background:#fff;border:1px solid #E5E7EB;border-radius:24px;padding:36px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.form-field{margin-bottom:16px}
.form-field label{display:block;font-size:12px;font-weight:600;color:#4B5563;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.form-field input,.form-field textarea,.form-field select{width:100%;padding:12px 16px;border:1.5px solid #E5E7EB;border-radius:10px;font-family:'Inter',sans-serif;font-size:14px;color:#111827;outline:none;transition:border-color .2s;background:#fff}
.form-field textarea{height:110px;resize:none}
.form-field input:focus,.form-field textarea:focus,.form-field select:focus{border-color:${pal.primary};box-shadow:0 0 0 3px ${pal.primary}18}
.form-submit{width:100%;background:linear-gradient(135deg,${pal.primary},${pal.dark});color:#fff;padding:14px;border-radius:12px;font-family:'Poppins',sans-serif;font-size:15px;font-weight:700;border:none;cursor:pointer;transition:opacity .2s;box-shadow:0 4px 16px ${pal.primary}44}
.form-submit:hover{opacity:.9}

/* ── CLAIM CTA ── */
.claim-section{background:linear-gradient(140deg,#0F0C29 0%,#302B63 50%,#4C1D95 100%);position:relative;overflow:hidden;padding:90px 5vw;text-align:center}
.claim-section::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 60% 70% at 50% 50%,${pal.primary}40,transparent 70%)}
.claim-section-inner{position:relative;z-index:2;max-width:640px;margin:0 auto}
.claim-section h2{font-family:'Poppins',sans-serif;font-size:clamp(26px,4vw,46px);font-weight:900;color:#fff;letter-spacing:-.03em;line-height:1.1;margin-bottom:16px}
.claim-section p{font-size:17px;color:rgba(255,255,255,.72);line-height:1.6;margin-bottom:36px}
.claim-btns{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.claim-btn-gold{background:linear-gradient(135deg,#F59E0B,#D97706);color:#fff;padding:16px 36px;border-radius:14px;font-family:'Poppins',sans-serif;font-size:16px;font-weight:800;display:inline-flex;align-items:center;gap:8px;box-shadow:0 4px 20px #F59E0B66;transition:transform .2s}
.claim-btn-gold:hover{transform:translateY(-2px)}
.claim-btn-outline{background:rgba(255,255,255,.1);color:#fff;padding:16px 32px;border-radius:14px;font-size:15px;font-weight:600;border:1.5px solid rgba(255,255,255,.25);display:inline-flex;align-items:center;gap:8px;backdrop-filter:blur(8px)}

/* ── FOOTER ── */
footer{background:#0F0C29;color:#9CA3AF;padding:56px 5vw 32px}
.footer-inner{max-width:1200px;margin:0 auto}
.footer-top{display:grid;grid-template-columns:2fr 1fr 1fr;gap:48px;margin-bottom:48px}
.footer-brand{font-family:'Poppins',sans-serif;font-size:18px;font-weight:800;color:#fff;margin-bottom:12px}
.footer-brand em{font-style:normal;color:${pal.primary}}
.footer-tagline{font-size:13.5px;line-height:1.6;max-width:32ch;color:#6B7280}
.footer-col h4{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#4B5563;margin-bottom:16px}
.footer-col a{display:block;font-size:13.5px;color:#6B7280;margin-bottom:10px;transition:color .15s}
.footer-col a:hover{color:#fff}
.footer-bottom{border-top:1px solid #1F1B35;padding-top:24px;display:flex;align-items:center;justify-content:space-between;font-size:12.5px;color:#4B5563;flex-wrap:wrap;gap:10px}
.ndismart-credit a{color:${pal.primary};font-weight:600}

/* ── RESPONSIVE ── */
@media(max-width:1024px){
  .hero-inner{grid-template-columns:1fr}
  .hero-card{display:none}
  .about-grid{grid-template-columns:1fr;gap:36px}
  .about-visual{display:none}
  .process-grid{grid-template-columns:1fr 1fr}
  .footer-top{grid-template-columns:1fr 1fr}
}
@media(max-width:680px){
  .hero{padding:56px 5vw 52px}
  .stats-bar-inner{grid-template-columns:1fr 1fr}
  .stat-item{border-right:none;border-bottom:1px solid #F3F4F6;padding:20px}
  .testi-grid{grid-template-columns:1fr}
  .contact-grid{grid-template-columns:1fr}
  .process-grid{grid-template-columns:1fr}
  .form-row{grid-template-columns:1fr}
  .nav-links{display:none}
  .footer-top{grid-template-columns:1fr}
  .footer-bottom{flex-direction:column;text-align:center}
  .svc-grid{grid-template-columns:1fr}
  .claim-btns{flex-direction:column;align-items:center}
}
</style>
</head>
<body>

<!-- Preview Banner -->
<div class="preview-banner">
  👋 This is a <strong>free preview website</strong> built for ${name} by NDISmart.
  <a href="https://ndismart.com.au/provider">Claim this website →</a>
</div>

<!-- Nav -->
<nav class="nav">
  <div class="nav-inner">
    <div class="nav-logo">${shortName.split(' ').slice(0,2).join(' ')}<em>.</em></div>
    <div class="nav-links">
      <a href="#services">Services</a>
      <a href="#about">About Us</a>
      <a href="#process">How It Works</a>
      <a href="#contact">Contact</a>
    </div>
    <a class="nav-cta" href="https://ndismart.com.au/provider">✦ Claim this site</a>
  </div>
</nav>

<!-- Hero -->
<section class="hero">
  <div class="hero-inner">
    <div class="hero-text">
      <div class="hero-badge"><span></span> NDIS Registered Provider · ${shortLoc}</div>
      <h1>We support you <em>like family</em></h1>
      <p class="hero-sub">High-quality, compassionate NDIS support${suburb ? ' in ' + shortLoc : ' across Australia'} — tailored to your unique needs and goals.</p>
      <div class="hero-btns">
        ${phone ? `<a class="btn-hero-primary" href="tel:${phone}">📞 Call ${phone}</a>` : `<a class="btn-hero-primary" href="#contact">Get in touch</a>`}
        ${email ? `<a class="btn-hero-secondary" href="mailto:${email}">✉ Send an enquiry</a>` : `<a class="btn-hero-secondary" href="#services">Our services</a>`}
      </div>
    </div>
    <div class="hero-card">
      <div class="hero-card-avatar">${initials}</div>
      <h3>${name}</h3>
      <div class="hero-card-loc">📍 ${shortLoc}</div>
      <div class="hero-card-stat"><span>Support Services</span><strong>${statCount}</strong></div>
      <div class="hero-card-stat"><span>Registered Since</span><strong>NDIS Reg.</strong></div>
      <div class="hero-card-ndis">✓ NDIS Registered &amp; Compliant</div>
    </div>
  </div>
</section>

<!-- Stats Bar -->
<div class="stats-bar">
  <div class="stats-bar-inner">
    <div class="stat-item"><div class="stat-num">${statCount}</div><div class="stat-label">Support Services</div></div>
    <div class="stat-item"><div class="stat-num">100%</div><div class="stat-label">Participant-Led</div></div>
    <div class="stat-item"><div class="stat-num">∞</div><div class="stat-label">Caring Like Family</div></div>
    <div class="stat-item"><div class="stat-num">✓</div><div class="stat-label">NDIS Registered</div></div>
  </div>
</div>

<!-- Services -->
<div class="services-bg" id="services">
  <div class="section-wrap">
    <div class="section-eyebrow">What we offer</div>
    <div class="section-h2">Our NDIS <em>Services</em></div>
    <p class="section-sub">We provide a wide range of NDIS-funded supports tailored to each participant's individual goals, lifestyle, and needs.</p>
    ${services.length > 0
      ? `<div class="svc-grid">${svcCards}</div>`
      : `<div class="svc-grid">
          <div class="svc-card"><div class="svc-card-icon" style="background:${pal.light};color:${pal.text}">🤝</div><div class="svc-card-body"><h4>Support Coordination</h4><p>Connecting you with the right supports</p></div></div>
          <div class="svc-card"><div class="svc-card-icon" style="background:${pal.light};color:${pal.text}">🏃</div><div class="svc-card-body"><h4>Daily Personal Activities</h4><p>Personal care & daily living support</p></div></div>
          <div class="svc-card"><div class="svc-card-icon" style="background:${pal.light};color:${pal.text}">🌍</div><div class="svc-card-body"><h4>Community Participation</h4><p>Social & civic community involvement</p></div></div>
        </div>`
    }
  </div>
</div>

<!-- About -->
<div id="about">
  <div class="section-wrap">
    <div class="about-grid">
      <div class="about-visual">
        <div class="value-chip"><div class="value-chip-icon">💜</div><h4>Compassion First</h4></div>
        <div class="value-chip"><div class="value-chip-icon">🎯</div><h4>Your Choice, Your Control</h4></div>
        <div class="value-chip"><div class="value-chip-icon">🌱</div><h4>Growth & Independence</h4></div>
        <div class="value-chip"><div class="value-chip-icon">🤝</div><h4>Community Connected</h4></div>
      </div>
      <div class="about-text">
        <div class="section-eyebrow">Who we are</div>
        <div class="section-h2">About <em>${name.split(' ').slice(0,2).join(' ')}</em></div>
        <p class="section-sub">We are a registered NDIS provider${location ? ' based in ' + shortLoc : ''}. Our team is passionate about delivering person-centred support that empowers participants to live independently and joyfully.</p>
        <div class="about-checks">
          <div class="about-check"><div class="check-dot">✓</div>Fully registered and compliant with NDIS Practice Standards</div>
          <div class="about-check"><div class="check-dot">✓</div>Support plans tailored to your individual goals and lifestyle</div>
          <div class="about-check"><div class="check-dot">✓</div>Dedicated team available when you need us most</div>
          <div class="about-check"><div class="check-dot">✓</div>Transparent reporting and open communication always</div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- How NDIS Works -->
<div class="process-bg full-wrap" id="process">
  <div style="max-width:1200px;margin:0 auto">
    <div style="text-align:center;margin-bottom:48px">
      <div class="section-eyebrow" style="color:${pal.light}">Getting started</div>
      <div class="section-h2" style="color:#fff">How <em>NDIS Funding</em> Works</div>
    </div>
    <div class="process-grid">
      <div class="process-card"><div class="process-tag">Step 1</div><div class="process-num">01</div><h4>Get Your Plan</h4><p>Work with the NDIA to create an NDIS plan with your goals and allocated funding.</p></div>
      <div class="process-card"><div class="process-tag">Step 2</div><div class="process-num">02</div><h4>Choose a Provider</h4><p>Select a registered provider like us who matches your needs and values.</p></div>
      <div class="process-card"><div class="process-tag">Step 3</div><div class="process-num">03</div><h4>Start Your Supports</h4><p>We'll build your personalised support plan and begin delivering services straight away.</p></div>
      <div class="process-card"><div class="process-tag">Step 4</div><div class="process-num">04</div><h4>Review &amp; Grow</h4><p>Regular check-ins ensure your supports evolve as your goals and needs change.</p></div>
    </div>
  </div>
</div>

<!-- Testimonials -->
<div style="background:#fff">
  <div class="section-wrap">
    <div style="text-align:center;margin-bottom:48px">
      <div class="section-eyebrow">What participants say</div>
      <div class="section-h2">Trusted by <em>Families</em></div>
    </div>
    <div class="testi-grid">
      <div class="testi-card">
        <div class="testi-stars">★★★★★</div>
        <p class="testi-quote">"The team are absolutely fantastic. From day one they made my son feel comfortable and truly valued. I can't recommend them highly enough."</p>
        <div class="testi-author"><div class="testi-avatar">SM</div><div><div class="testi-name">Sarah M.</div><div class="testi-role">Parent of participant</div></div></div>
      </div>
      <div class="testi-card">
        <div class="testi-stars">★★★★★</div>
        <p class="testi-quote">"I've never felt so supported. The carers genuinely care — they go above and beyond every single time to help me reach my goals."</p>
        <div class="testi-author"><div class="testi-avatar">JT</div><div><div class="testi-name">James T.</div><div class="testi-role">NDIS Participant</div></div></div>
      </div>
      <div class="testi-card">
        <div class="testi-stars">★★★★★</div>
        <p class="testi-quote">"Their plan management service has taken all the stress away. I know my budget is in safe hands and can focus on what matters."</p>
        <div class="testi-author"><div class="testi-avatar">LK</div><div><div class="testi-name">Linda K.</div><div class="testi-role">NDIS Participant</div></div></div>
      </div>
    </div>
  </div>
</div>

<!-- Contact -->
<div class="contact-bg" id="contact">
  <div class="section-wrap">
    <div class="contact-grid">
      <div class="contact-info-block">
        <div class="section-eyebrow">Get in touch</div>
        <h3 class="section-h2">Ready to get <em>started?</em></h3>
        <p>Reach out to our team and we'll be happy to discuss how we can support you or your loved one.</p>
        ${phone ? `<div class="contact-detail"><div class="contact-detail-icon">📞</div><div class="contact-detail-text"><strong>Phone</strong><a href="tel:${phone}">${phone}</a></div></div>` : ''}
        ${email ? `<div class="contact-detail"><div class="contact-detail-icon">✉️</div><div class="contact-detail-text"><strong>Email</strong><a href="mailto:${email}">${email}</a></div></div>` : ''}
        ${location ? `<div class="contact-detail"><div class="contact-detail-icon">📍</div><div class="contact-detail-text"><strong>Location</strong>${location}</div></div>` : ''}
      </div>
      <div class="contact-form-card">
        <div class="section-eyebrow" style="margin-bottom:8px">Send a message</div>
        <h3 style="font-family:'Poppins',sans-serif;font-size:20px;font-weight:800;margin-bottom:24px;color:#111827">We'd love to hear from you</h3>
        <div class="form-row">
          <div class="form-field"><label>First name</label><input type="text" placeholder="Jane"></div>
          <div class="form-field"><label>Last name</label><input type="text" placeholder="Smith"></div>
        </div>
        <div class="form-field"><label>Email address</label><input type="email" placeholder="jane@email.com"></div>
        <div class="form-field"><label>I am a…</label><select><option>Participant</option><option>Family member / carer</option><option>Support coordinator</option><option>Other</option></select></div>
        <div class="form-field"><label>Message</label><textarea placeholder="Hi, I'd like to learn more about your services and how you can support me…"></textarea></div>
        <button class="form-submit">Send Message →</button>
      </div>
    </div>
  </div>
</div>

<!-- Claim CTA -->
<div class="claim-section">
  <div class="claim-section-inner">
    <div class="section-eyebrow" style="color:${pal.light}">Your free preview</div>
    <h2>This website could be <em style="font-style:italic;color:#FCD34D">yours</em></h2>
    <p>NDISmart has built this site for ${name} for free. Claim it and start receiving enquiries from participants near you — no tech skills required.</p>
    <div class="claim-btns">
      <a class="claim-btn-gold" href="https://ndismart.com.au/provider">✦ Claim this website</a>
      <a class="claim-btn-outline" href="https://ndismart.com.au/provider">View pricing →</a>
    </div>
  </div>
</div>

<!-- Footer -->
<footer>
  <div class="footer-inner">
    <div class="footer-top">
      <div>
        <div class="footer-brand">${shortName.split(' ').slice(0,2).join(' ')}<em>.</em></div>
        <p class="footer-tagline">NDIS registered provider${suburb ? ' in ' + shortLoc : ''}. Committed to empowering participants to live their best lives.</p>
      </div>
      <div class="footer-col">
        <h4>Services</h4>
        ${services.slice(0,5).map(s => `<a href="#services">${s}</a>`).join('') || '<a href="#services">View all services</a>'}
      </div>
      <div class="footer-col">
        <h4>Contact</h4>
        ${phone ? `<a href="tel:${phone}">${phone}</a>` : ''}
        ${email ? `<a href="mailto:${email}">${email}</a>` : ''}
        ${location ? `<a href="#contact">${shortLoc}</a>` : ''}
      </div>
    </div>
    <div class="footer-bottom">
      <span>© 2025 ${name}. All rights reserved.</span>
      <span class="ndismart-credit">Preview by <a href="https://ndismart.com.au">NDISmart</a> · <a href="https://ndismart.com.au/provider">Claim this site</a></span>
    </div>
  </div>
</footer>

</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Provider search API — replaces the 36MB client-side JSON fetch
app.get('/api/providers', (req, res) => {
  const providers = getProviders();
  const q       = (req.query.q       || '').toLowerCase().trim();
  const service = (req.query.service || '').toLowerCase().trim();
  const state   = (req.query.state   || '').toLowerCase().trim();
  const limit   = Math.min(parseInt(req.query.limit  || '200', 10), 500);
  const offset  = parseInt(req.query.offset || '0', 10);

  let results = providers;

  if (q) {
    const isPostcode = /^\d{4}$/.test(q);
    if (isPostcode) {
      // Exact postcode match only — avoids pulling in adjacent postcodes
      results = results.filter(p => (p.postcode || '') === q);
    } else {
      // Suburb name or provider name — no postcode/state fuzzy matching
      results = results.filter(p =>
        (p.name   || '').toLowerCase().includes(q) ||
        (p.suburb || '').toLowerCase().includes(q)
      );
    }
  }

  if (service) {
    results = results.filter(p =>
      (p.services || []).some(s => s.toLowerCase().includes(service))
    );
  }

  if (state) {
    results = results.filter(p => (p.state || '').toLowerCase() === state);
  }

  if (req.query.featured === 'true') {
    results = results.filter(p => p.featured);
  }

  // Featured first, then alphabetical
  results = [...results].sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  res.json({
    total: results.length,
    providers: results.slice(offset, offset + limit),
  });
});

const PLANS = {
  featured: { name: 'NDISmart Featured Listing', amount: 4900, currency: 'aud' },
  premium:  { name: 'NDISmart Premium Listing',  amount: 9900, currency: 'aud' },
};

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { name, email, plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan selected.' });

    const selected = PLANS[plan];
    const baseUrl = process.env.URL || `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      metadata: { business_name: name },
      line_items: [{
        price_data: {
          currency: selected.currency,
          product_data: { name: selected.name },
          unit_amount: selected.amount,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/provider.html?success=true`,
      cancel_url:  `${baseUrl}/provider.html?cancelled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customer-portal', async (req, res) => {
  try {
    const { email } = req.body;
    const customers = await stripe.customers.list({ email: email.trim(), limit: 1 });

    if (!customers.data.length) {
      return res.status(404).json({ error: 'No subscription found for that email address.' });
    }

    const baseUrl = process.env.URL || `${req.protocol}://${req.get('host')}`;

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: `${baseUrl}/provider.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submit-listing', (req, res) => {
  console.log('New listing submission:', req.body);
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`NDISmart server running on port ${PORT}`);
});
