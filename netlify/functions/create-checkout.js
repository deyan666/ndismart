const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  featured: {
    name: 'NDISmart Featured Listing',
    amount: 4900,   // $49.00 AUD in cents
    currency: 'aud',
  },
  premium: {
    name: 'NDISmart Premium Listing',
    amount: 9900,   // $99.00 AUD in cents
    currency: 'aud',
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { name, email, plan } = JSON.parse(event.body);

    if (!PLANS[plan]) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan selected.' }) };
    }

    const selected = PLANS[plan];

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
      success_url: `${process.env.URL || 'https://ndismart.netlify.app'}/provider.html?success=true`,
      cancel_url:  `${process.env.URL || 'https://ndismart.netlify.app'}/provider.html?cancelled=true`,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
