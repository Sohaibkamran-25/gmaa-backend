const PAYPAL_ENVIRONMENT = process.env.PAYPAL_ENVIRONMENT || 'sandbox';
const PAYPAL_BASE_URL =
  PAYPAL_ENVIRONMENT === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export async function getPayPalAccessToken() {
  const clientId = requiredEnv('PAYPAL_CLIENT_ID');
  const clientSecret = requiredEnv('PAYPAL_CLIENT_SECRET');
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Could not obtain PayPal access token.');
  return data.access_token;
}

export async function createPayPalOrder({ submissionId, description, amount, currency }) {
  const frontendUrl = process.env.FRONTEND_URL || 'https://gmaa.online';
  const token = await getPayPalAccessToken();

  const res = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: submissionId,
          custom_id: submissionId,
          description,
          amount: { currency_code: currency, value: amount },
        },
      ],
      application_context: {
        brand_name: 'GMAA',
        user_action: 'PAY_NOW',
        return_url: `${frontendUrl}/payment-success.html`,
        cancel_url: `${frontendUrl}/payment-cancelled.html`,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Could not create PayPal order.');

  const approvalUrl = data.links?.find((l) => l.rel === 'approve')?.href;
  if (!approvalUrl) throw new Error('PayPal did not return an approval URL.');

  return { orderId: data.id, approvalUrl };
}

export async function capturePayPalOrder(orderID) {
  const token = await getPayPalAccessToken();

  const res = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderID}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Could not capture PayPal order.');
  return data;
}

// Verifies a PayPal webhook using PayPal's own verification API.
// Returns true if the signature is valid.
export async function verifyPayPalWebhook(requestHeaders, event) {
  const token = await getPayPalAccessToken();

  const res = await fetch(`${PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_algo: requestHeaders['paypal-auth-algo'],
      cert_url: requestHeaders['paypal-cert-url'],
      transmission_id: requestHeaders['paypal-transmission-id'],
      transmission_sig: requestHeaders['paypal-transmission-sig'],
      transmission_time: requestHeaders['paypal-transmission-time'],
      webhook_id: requiredEnv('PAYPAL_WEBHOOK_ID'),
      webhook_event: event,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'PayPal webhook verification request failed.');
  return data.verification_status === 'SUCCESS';
}
