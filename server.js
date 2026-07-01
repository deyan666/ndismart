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

  const name    = (p.outlet || p.name || '').replace(/^\([^)]+\)\s*/i, '');
  const suburb  = p.suburb  || '';
  const state   = p.state   || '';
  const postcode= p.postcode|| '';
  const phone   = p.phone   || '';
  const email   = p.email   || '';
  const services= (p.services || []);
  const location= [suburb, state, postcode].filter(Boolean).join(', ');
  const initials= name.replace(/[^a-zA-Z\s]/g,'').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase() || '?';

  const SERVICE_ICONS = {
    'plan management': '📋', 'support coordination': '🤝', 'therapeutic': '🧠',
    'daily personal': '🏃', 'behaviour': '💬', 'accommodation': '🏠',
    'group': '👥', 'early intervention': '👶', 'nursing': '💊',
    'mobility': '♿', 'home modification': '🔨', 'travel': '🚗',
    'transport': '🚗', 'assistive': '🦾', 'community': '🌍',
    'employment': '💼', 'household': '🏡',
  };
  function getIcon(svc) {
    const s = svc.toLowerCase();
    for (const [k, v] of Object.entries(SERVICE_ICONS)) { if (s.includes(k)) return v; }
    return '✅';
  }

  const servicesHTML = services.map(s =>
    `<div class="svc-item"><span class="svc-icon">${getIcon(s)}</span><span>${s}</span></div>`
  ).join('');

  const contactItems = [
    phone ? `<div class="contact-item"><span>📞</span><a href="tel:${phone}">${phone}</a></div>` : '',
    email ? `<div class="contact-item"><span>✉️</span><a href="mailto:${email}">${email}</a></div>` : '',
    location ? `<div class="contact-item"><span>📍</span><span>${location}</span></div>` : '',
  ].join('');

  const colors = ['#7C3AED','#0A7EA4','#059669','#DC2626','#D97706','#2563EB','#DB2777'];
  const color  = colors[id % colors.length];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — NDIS Provider</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Poppins',sans-serif;color:#1a1a2e;background:#fff}
a{text-decoration:none;color:inherit}

/* Preview banner */
.preview-banner{background:linear-gradient(90deg,#7C3AED,#5B21B6);color:white;padding:14px 24px;text-align:center;position:sticky;top:0;z-index:100}
.preview-banner strong{font-weight:700}
.preview-banner a{color:#FCD34D;font-weight:700;text-decoration:underline}

/* Nav */
nav{background:#fff;border-bottom:1px solid #eee;padding:0 40px;display:flex;align-items:center;justify-content:space-between;height:68px}
.nav-logo{font-size:20px;font-weight:800;color:#1a1a2e}
.nav-logo span{color:${color}}
.nav-links{display:flex;gap:28px;font-size:14px;font-weight:500;color:#555}
.nav-cta{background:${color};color:white;padding:10px 22px;border-radius:100px;font-size:14px;font-weight:600}

/* Hero */
.hero{background:linear-gradient(135deg,${color}18 0%,${color}08 100%);padding:80px 40px;display:flex;align-items:center;gap:48px;flex-wrap:wrap}
.hero-avatar{width:110px;height:110px;border-radius:24px;background:${color};display:flex;align-items:center;justify-content:center;font-size:38px;font-weight:800;color:white;flex-shrink:0;box-shadow:0 8px 32px ${color}44}
.hero-text h1{font-size:clamp(28px,4vw,48px);font-weight:800;line-height:1.1;margin-bottom:12px;color:#1a1a2e}
.hero-text p{font-size:16px;color:#555;max-width:52ch;line-height:1.6;margin-bottom:24px}
.ndis-badge{display:inline-flex;align-items:center;gap:8px;background:#e8f5e9;color:#2e7d32;padding:8px 18px;border-radius:100px;font-size:13px;font-weight:600;border:1px solid #a5d6a7}
.hero-btns{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
.btn-primary{background:${color};color:white;padding:14px 28px;border-radius:12px;font-size:15px;font-weight:700;display:inline-block}
.btn-secondary{background:white;color:${color};padding:14px 28px;border-radius:12px;font-size:15px;font-weight:600;border:2px solid ${color};display:inline-block}

/* Sections */
section{padding:64px 40px;max-width:1100px;margin:0 auto}
.section-label{font-size:12px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px}
.section-title{font-size:clamp(24px,3vw,36px);font-weight:800;color:#1a1a2e;margin-bottom:16px;line-height:1.15}
.section-sub{font-size:16px;color:#666;max-width:56ch;line-height:1.6;margin-bottom:40px}

/* Services */
.svc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.svc-item{display:flex;align-items:center;gap:14px;background:#fafafa;border:1px solid #eee;border-radius:12px;padding:16px 18px;font-size:14px;font-weight:500;color:#333;transition:all .2s}
.svc-item:hover{border-color:${color};background:${color}0d;transform:translateY(-1px)}
.svc-icon{font-size:22px;flex-shrink:0}

/* Why us */
.why-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
@media(max-width:680px){.why-grid{grid-template-columns:1fr}}
.why-card{background:linear-gradient(135deg,${color}0d,${color}05);border:1px solid ${color}25;border-radius:16px;padding:28px;text-align:center}
.why-icon{font-size:36px;margin-bottom:12px}
.why-card h3{font-size:16px;font-weight:700;margin-bottom:8px;color:#1a1a2e}
.why-card p{font-size:13px;color:#666;line-height:1.5}

/* Contact */
.contact-section{background:linear-gradient(135deg,${color}14,${color}06);border-radius:24px;padding:48px;display:flex;gap:48px;flex-wrap:wrap;align-items:flex-start}
.contact-info{flex:1;min-width:240px}
.contact-item{display:flex;align-items:center;gap:12px;font-size:15px;color:#444;margin-bottom:16px}
.contact-item a{color:${color};font-weight:600}
.contact-form{flex:1;min-width:260px;background:white;border-radius:16px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.contact-form h3{font-size:18px;font-weight:700;margin-bottom:20px}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:12px;font-weight:600;color:#666;margin-bottom:5px;text-transform:uppercase;letter-spacing:.05em}
.form-group input,.form-group textarea{width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:8px;font-family:'Poppins',sans-serif;font-size:14px;color:#1a1a2e;outline:none}
.form-group textarea{height:90px;resize:none}
.form-group input:focus,.form-group textarea:focus{border-color:${color}}
.form-submit{width:100%;background:${color};color:white;padding:13px;border-radius:10px;font-family:'Poppins',sans-serif;font-size:15px;font-weight:700;border:none;cursor:pointer;margin-top:4px}

/* Footer */
footer{background:#1a1a2e;color:#aaa;padding:32px 40px;text-align:center;font-size:13px}
footer strong{color:white}

/* Claim CTA */
.claim-cta{background:linear-gradient(135deg,#7C3AED,#5B21B6);color:white;padding:56px 40px;text-align:center}
.claim-cta h2{font-size:clamp(22px,3vw,34px);font-weight:800;margin-bottom:12px}
.claim-cta p{font-size:16px;opacity:.85;max-width:48ch;margin:0 auto 28px}
.claim-btn{background:#FCD34D;color:#1a1a2e;padding:16px 36px;border-radius:12px;font-size:16px;font-weight:800;display:inline-block}

@media(max-width:600px){
  nav{padding:0 20px}.nav-links{display:none}
  .hero{padding:48px 20px;gap:24px}
  section{padding:48px 20px}
  .contact-section{padding:28px 20px}
  .claim-cta{padding:40px 20px}
  footer{padding:24px 20px}
}
</style>
</head>
<body>

<div class="preview-banner">
  👋 <strong>This is a free preview site</strong> built for ${name} by NDISmart.
  <a href="https://ndismart.com.au/provider">Claim this website →</a>
</div>

<nav>
  <div class="nav-logo">${name.split(' ').slice(0,2).join(' ')}<span>.</span></div>
  <div class="nav-links">
    <a href="#services">Services</a>
    <a href="#about">About</a>
    <a href="#contact">Contact</a>
  </div>
  <a class="nav-cta" href="https://ndismart.com.au/provider">Get this site</a>
</nav>

<div class="hero">
  <div class="hero-avatar">${initials}</div>
  <div class="hero-text">
    <div class="ndis-badge">✓ NDIS Registered Provider</div>
    <h1>${name}</h1>
    <p>Providing quality NDIS support services${suburb ? ' in ' + suburb + (state ? ', ' + state : '') : ' across Australia'}. We are committed to empowering participants to live their best lives.</p>
    <div class="hero-btns">
      ${phone ? `<a class="btn-primary" href="tel:${phone}">📞 Call us now</a>` : ''}
      ${email ? `<a class="btn-secondary" href="mailto:${email}">✉ Send an enquiry</a>` : ''}
    </div>
  </div>
</div>

<section id="services">
  <div class="section-label">What we offer</div>
  <div class="section-title">Our NDIS Services</div>
  <div class="section-sub">We provide a range of NDIS-funded supports tailored to each participant's goals and needs.</div>
  ${services.length > 0 ? `<div class="svc-grid">${servicesHTML}</div>` : '<p style="color:#888">Contact us to learn about our available services.</p>'}
</section>

<section id="about" style="background:#fafafa;max-width:100%;padding:64px 40px">
  <div style="max-width:1100px;margin:0 auto">
    <div class="section-label">Who we are</div>
    <div class="section-title">About ${name}</div>
    <div class="section-sub">We are a registered NDIS provider${location ? ' based in ' + location : ''}. Our team is passionate about delivering person-centred support that makes a real difference in the lives of our participants and their families.</div>
    <div class="why-grid">
      <div class="why-card"><div class="why-icon">🏅</div><h3>NDIS Registered</h3><p>Fully registered and compliant with NDIS Practice Standards.</p></div>
      <div class="why-card"><div class="why-icon">❤️</div><h3>Person-Centred</h3><p>Every support plan is tailored to your individual goals and lifestyle.</p></div>
      <div class="why-card"><div class="why-icon">🤝</div><h3>Here For You</h3><p>Dedicated team ready to support you every step of the way.</p></div>
    </div>
  </div>
</section>

<section id="contact" style="max-width:100%;padding:64px 40px;background:#fff">
  <div style="max-width:1100px;margin:0 auto">
    <div class="section-label">Get in touch</div>
    <div class="section-title">Contact Us</div>
    <div class="contact-section">
      <div class="contact-info">
        <p style="font-size:16px;color:#555;line-height:1.6;margin-bottom:24px">Ready to get started? Reach out to our team and we'll be happy to discuss how we can support you.</p>
        ${contactItems}
      </div>
      <div class="contact-form">
        <h3>Send us a message</h3>
        <div class="form-group"><label>Your name</label><input type="text" placeholder="Jane Smith"></div>
        <div class="form-group"><label>Email</label><input type="email" placeholder="jane@email.com"></div>
        <div class="form-group"><label>Message</label><textarea placeholder="Hi, I'd like to learn more about your services..."></textarea></div>
        <button class="form-submit">Send Message</button>
      </div>
    </div>
  </div>
</section>

<div class="claim-cta">
  <h2>This is your free NDISmart preview</h2>
  <p>Claim this website and start receiving enquiries from NDIS participants near you.</p>
  <a class="claim-btn" href="https://ndismart.com.au/provider">Claim your website →</a>
</div>

<footer>
  <p>Preview generated by <strong>NDISmart</strong> · <a href="https://ndismart.com.au" style="color:#FCD34D">ndismart.com.au</a></p>
  <p style="margin-top:6px;font-size:12px;opacity:.6">This is a demo page. Content is based on publicly available NDIS registration data.</p>
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
