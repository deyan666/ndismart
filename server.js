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

function getProviders() {
  if (cachedProviders) return cachedProviders;
  loadSuburbCoords();
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'providers_data.json'), 'utf8');
    const providers = JSON.parse(raw);
    // Attach coords to each provider once at load time
    providers.forEach(p => {
      const key = (p.suburb || '').toLowerCase().trim();
      if (key && suburbCoords[key]) {
        p._coords = suburbCoords[key];
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

// Suburb autocomplete — searches all 7,337 geocoded suburbs, returns { name, state }
let suburbIndex = null;
function getSuburbIndex() {
  if (suburbIndex) return suburbIndex;
  const stateMap = {};
  const postcodeMap = {};
  getProviders().forEach(p => {
    const key = (p.suburb || '').toLowerCase().trim();
    if (key && p.state    && !stateMap[key])    stateMap[key]    = p.state.toUpperCase();
    if (key && p.postcode && !postcodeMap[key]) postcodeMap[key] = p.postcode;
  });
  suburbIndex = Object.keys(suburbCoords).sort().map(name => ({
    name,
    state:    stateMap[name]    || '',
    postcode: postcodeMap[name] || '',
  }));
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

// Build a postcode → coords lookup from the suburb index
let postcodeToCoords = null;
function getPostcodeToCoords() {
  if (postcodeToCoords) return postcodeToCoords;
  const index = getSuburbIndex();
  postcodeToCoords = {};
  index.forEach(s => {
    if (s.postcode && !postcodeToCoords[s.postcode] && suburbCoords[s.name]) {
      postcodeToCoords[s.postcode] = suburbCoords[s.name];
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
    results = results.filter(p =>
      (p.name    || '').toLowerCase().includes(q) ||
      (p.suburb  || '').toLowerCase().includes(q) ||
      (p.state   || '').toLowerCase().includes(q) ||
      (p.postcode|| '').includes(q)
    );
  }

  if (service) {
    results = results.filter(p =>
      (p.services || []).some(s => s.toLowerCase().includes(service))
    );
  }

  if (state) {
    results = results.filter(p => (p.state || '').toLowerCase() === state);
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
