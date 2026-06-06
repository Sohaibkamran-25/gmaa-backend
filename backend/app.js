import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { Resend } from 'resend';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://gmaa.online';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || FRONTEND_URL;
const PAYPAL_ENVIRONMENT = process.env.PAYPAL_ENVIRONMENT || 'sandbox';
const PAYPAL_BASE_URL = PAYPAL_ENVIRONMENT === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Submissions';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const HEADERS = [
  'Submission ID', 'Created At', 'Sport', 'Form Type', 'Payment Status', 'Amount',
  'PayPal Order ID', 'PayPal Capture ID', 'Full Name', 'Email', 'Phone Number',
  'Team Name', 'Jersey Size', 'Jersey Type', 'Jersey Number', 'Printed Name on Jersey',
  'Waiver Accepted', 'Electronic Signature', 'Company / Sponsor Name', 'Sponsorship Notes',
  'Paid At', 'Admin Email Sent', 'Participant Email Sent', 'Raw Form Data'
];

app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function cleanPrivateKey(key) {
  return key.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
}

function getAmount(sport, mode) {
  const normalizedSport = String(sport || '').toUpperCase().replace(/-/g, '_');
  const normalizedMode = mode === 'sponsor' ? 'SPONSOR' : 'PLAYER';
  const specific = process.env[`${normalizedSport}_${normalizedMode}_AMOUNT`];
  const fallback = normalizedMode === 'SPONSOR'
    ? process.env.DEFAULT_SPONSOR_AMOUNT
    : process.env.DEFAULT_PLAYER_AMOUNT;
  const amount = Number(specific || fallback || 0);
  if (!amount || amount <= 0) throw new Error('Payment amount is not configured.');
  return amount.toFixed(2);
}

function getSportLabel(slug) {
  const names = { 'track-field': 'Track and Field', mma: 'MMA' };
  if (names[slug]) return names[slug];
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Event';
}

function field(fields, name) {
  return fields?.[name] || '';
}

function buildRow({ submissionId, createdAt, sport, mode, amount, orderId, fields }) {
  const isSponsor = mode === 'sponsor';
  const acknowledgments = Object.entries(fields || {})
    .filter(([key]) => key.startsWith('Acknowledgment'))
    .map(([, value]) => value)
    .join(' | ');

  return [
    submissionId,
    createdAt,
    getSportLabel(sport),
    isSponsor ? 'Sponsorship' : 'Player Registration',
    'Pending',
    amount,
    orderId || '',
    '',
    field(fields, 'Full Name') || field(fields, 'Contact Name'),
    field(fields, 'email'),
    field(fields, 'Phone Number'),
    field(fields, 'Team Name'),
    field(fields, 'Jersey Size'),
    field(fields, 'Jersey Type'),
    field(fields, 'Jersey Number'),
    field(fields, 'Printed Name on Jersey'),
    isSponsor ? '' : acknowledgments,
    field(fields, 'Electronic Signature'),
    field(fields, 'Company / Sponsor Name'),
    field(fields, 'Sponsorship Notes'),
    '',
    '',
    '',
    JSON.stringify(fields || {})
  ];
}

async function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: requiredEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    key: cleanPrivateKey(requiredEnv('GOOGLE_PRIVATE_KEY')),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function appendSubmission(row) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: requiredEnv('GOOGLE_SHEET_ID'),
    range: `${SHEET_TAB}!A:X`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

async function getAllRows() {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: requiredEnv('GOOGLE_SHEET_ID'),
    range: `${SHEET_TAB}!A:X`
  });
  return response.data.values || [];
}

function rowObject(headers, row) {
  const obj = {};
  headers.forEach((header, index) => { obj[header] = row[index] || ''; });
  return obj;
}

async function updateRowByOrderId(orderId, updates) {
  const sheets = await getSheetsClient();
  const rows = await getAllRows();
  if (!rows.length) throw new Error('Google Sheet has no rows. Add the header row first.');
  const headers = rows[0];
  const orderCol = headers.indexOf('PayPal Order ID');
  if (orderCol === -1) throw new Error('PayPal Order ID column is missing.');

  const rowIndex = rows.findIndex((row, index) => index > 0 && row[orderCol] === orderId);
  if (rowIndex === -1) throw new Error(`Submission not found for PayPal order ${orderId}.`);

  const row = [...rows[rowIndex]];
  headers.forEach((header, index) => {
    if (Object.prototype.hasOwnProperty.call(updates, header)) row[index] = updates[header];
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: requiredEnv('GOOGLE_SHEET_ID'),
    range: `${SHEET_TAB}!A${rowIndex + 1}:X${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });

  return rowObject(headers, row);
}

async function getPayPalAccessToken() {
  const clientId = requiredEnv('PAYPAL_CLIENT_ID');
  const clientSecret = requiredEnv('PAYPAL_CLIENT_SECRET');
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Could not get PayPal access token.');
  return data.access_token;
}

async function createPayPalOrder({ submissionId, sport, mode, amount }) {
  const token = await getPayPalAccessToken();
  const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: submissionId,
        custom_id: submissionId,
        description: `GMAA ${getSportLabel(sport)} ${mode === 'sponsor' ? 'Sponsorship' : 'Registration'}`,
        amount: { currency_code: 'USD', value: amount }
      }],
      application_context: {
        brand_name: 'GMAA',
        user_action: 'PAY_NOW',
        return_url: `${FRONTEND_URL}/payment-success.html`,
        cancel_url: `${FRONTEND_URL}/payment-cancelled.html`
      }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Could not create PayPal order.');
  const approvalUrl = data.links?.find(link => link.rel === 'approve')?.href;
  if (!approvalUrl) throw new Error('PayPal approval link was not returned.');
  return { orderId: data.id, approvalUrl };
}

async function capturePayPalOrder(orderID) {
  const token = await getPayPalAccessToken();
  const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderID}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Could not capture PayPal order.');
  return data;
}

async function verifyPayPalWebhook(headers, event) {
  const token = await getPayPalAccessToken();
  const response = await fetch(`${PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: requiredEnv('PAYPAL_WEBHOOK_ID'),
      webhook_event: event
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Webhook verification failed.');
  return data.verification_status === 'SUCCESS';
}

function paymentSummaryHtml(row) {
  return `
    <h2>GMAA Payment Confirmed</h2>
    <p><strong>Sport:</strong> ${row['Sport']}</p>
    <p><strong>Type:</strong> ${row['Form Type']}</p>
    <p><strong>Name:</strong> ${row['Full Name']}</p>
    <p><strong>Email:</strong> ${row['Email']}</p>
    <p><strong>Amount:</strong> $${row['Amount']}</p>
    <p><strong>PayPal Order:</strong> ${row['PayPal Order ID']}</p>
  `;
}

async function sendPaidEmails(row) {
  if (!resend) return { admin: 'Skipped', participant: 'Skipped' };
  const from = requiredEnv('EMAIL_FROM');
  const adminEmail = requiredEnv('ADMIN_EMAIL');
  const participantEmail = row['Email'];
  const subject = `Paid ${row['Form Type']}: ${row['Sport']} - ${row['Full Name']}`;
  const html = paymentSummaryHtml(row);

  await resend.emails.send({ from, to: adminEmail, subject, html });
  if (participantEmail) {
    await resend.emails.send({
      from,
      to: participantEmail,
      subject: `GMAA Payment Confirmed - ${row['Sport']}`,
      html: `<p>Thank you. Your GMAA payment has been confirmed.</p>${html}`
    });
  }
  return { admin: 'Sent', participant: participantEmail ? 'Sent' : 'No Email' };
}

async function finalizePaidOrder({ orderId, captureId }) {
  const paidAt = new Date().toISOString();
  let row = await updateRowByOrderId(orderId, {
    'Payment Status': 'Paid',
    'PayPal Capture ID': captureId || '',
    'Paid At': paidAt
  });

  if (row['Admin Email Sent'] === 'Sent' && row['Participant Email Sent'] === 'Sent') return row;

  const emailStatus = await sendPaidEmails(row);
  row = await updateRowByOrderId(orderId, {
    'Admin Email Sent': emailStatus.admin,
    'Participant Email Sent': emailStatus.participant
  });
  return row;
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'GMAA PayPal + Google Sheets backend' });
});

app.post('/api/create-order', async (req, res) => {
  try {
    const { sport, mode, fields } = req.body || {};
    if (!sport || !mode || !fields) return res.status(400).json({ error: 'Missing form data.' });

    const amount = getAmount(sport, mode);
    const submissionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const paypal = await createPayPalOrder({ submissionId, sport, mode, amount });
    const row = buildRow({ submissionId, createdAt, sport, mode, amount, orderId: paypal.orderId, fields });
    await appendSubmission(row);

    res.json({ approvalUrl: paypal.approvalUrl, orderId: paypal.orderId, submissionId });
  } catch (error) {
    console.error('create-order error:', error);
    res.status(500).json({ error: error.message || 'Could not create checkout.' });
  }
});

app.post('/api/capture-order', async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: 'Missing PayPal order ID.' });

    const capture = await capturePayPalOrder(orderID);
    const captureInfo = capture.purchase_units?.[0]?.payments?.captures?.[0];
    if (!captureInfo || captureInfo.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'PayPal payment was not completed.' });
    }

    const row = await finalizePaidOrder({ orderId: orderID, captureId: captureInfo.id });
    res.json({ ok: true, status: 'Paid', row });
  } catch (error) {
    console.error('capture-order error:', error);
    res.status(500).json({ error: error.message || 'Could not verify payment.' });
  }
});

app.post('/api/paypal-webhook', async (req, res) => {
  try {
    const event = req.body;
    const verified = await verifyPayPalWebhook(req.headers, event);
    if (!verified) return res.status(400).json({ error: 'Invalid PayPal webhook signature.' });

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const capture = event.resource;
      const orderId = capture.supplementary_data?.related_ids?.order_id;
      if (orderId) await finalizePaidOrder({ orderId, captureId: capture.id });
    }

    res.json({ received: true });
  } catch (error) {
    console.error('paypal-webhook error:', error);
    res.status(500).json({ error: error.message || 'Webhook failed.' });
  }
});

export default app;
