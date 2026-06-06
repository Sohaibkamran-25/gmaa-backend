import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';

import { getEventPricing } from './config/events.js';
import {
  buildPendingRow,
  appendPendingSubmission,
  findSubmissionByPayPalOrderId,
  updateSubmissionPaid,
} from './lib/sheets.js';
import {
  createPayPalOrder,
  capturePayPalOrder,
  verifyPayPalWebhook,
} from './lib/paypal.js';
import {
  sendParticipantConfirmation,
  sendAdminPaidNotification,
} from './lib/email.js';

dotenv.config();

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://gmaa.online';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || FRONTEND_URL;

app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// ─── Orchestration helper ────────────────────────────────────────────────────

// Marks a submission Paid, then sends emails. Idempotent: if both emails were
// already sent, returns the existing row without making any further changes.
async function finalizePaidOrder({ orderId, captureId }) {
  const found = await findSubmissionByPayPalOrderId(orderId);
  if (!found) {
    throw new Error(`No submission found for PayPal order: ${orderId}`);
  }

  const { data } = found;

  // Idempotency guard — skip if already fully processed
  if (
    data['Payment Status'] === 'Paid' &&
    data['Admin Email Sent'] === 'Sent' &&
    data['Participant Email Sent'] === 'Sent'
  ) {
    return data;
  }

  // Mark as Paid in Google Sheets
  const paidAt = new Date().toISOString();
  const paidRow = await updateSubmissionPaid(orderId, {
    'Payment Status': 'Paid',
    'PayPal Capture ID': captureId || '',
    'Paid At': paidAt,
    'Updated At': paidAt,
  });

  // Send emails (only those not already sent)
  let adminSent = paidRow['Admin Email Sent'];
  let participantSent = paidRow['Participant Email Sent'];

  if (adminSent !== 'Sent') {
    try {
      adminSent = await sendAdminPaidNotification(paidRow);
    } catch (err) {
      console.error('Admin email error:', err.message);
      adminSent = `Failed: ${err.message}`;
    }
  }

  if (participantSent !== 'Sent') {
    try {
      participantSent = await sendParticipantConfirmation(paidRow);
    } catch (err) {
      console.error('Participant email error:', err.message);
      participantSent = `Failed: ${err.message}`;
    }
  }

  // Persist email send status
  const finalRow = await updateSubmissionPaid(orderId, {
    'Admin Email Sent': adminSent,
    'Participant Email Sent': participantSent,
  });

  return finalRow;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'GMAA backend', timestamp: new Date().toISOString() });
});

// POST /api/create-order
// Receives form data, validates it, stores a Pending row in Google Sheets,
// creates a PayPal order, and returns the approval URL to the frontend.
app.post('/api/create-order', async (req, res) => {
  try {
    const { sport, mode, fields } = req.body || {};
    if (!sport || !mode || !fields) {
      return res.status(400).json({ error: 'Missing required fields: sport, mode, fields.' });
    }

    // Backend decides amount from config — never trust a price from the frontend
    const formType = mode === 'sponsor' ? 'sponsor' : 'signup';
    const pricing = getEventPricing(sport, formType); // throws if not configured
    const { amount, currency, label } = pricing;

    const submissionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const description = `GMAA ${label} ${formType === 'sponsor' ? 'Sponsorship' : 'Registration'}`;

    // Create PayPal order first so we have the orderId for the sheet row
    const { orderId, approvalUrl } = await createPayPalOrder({
      submissionId,
      description,
      amount,
      currency,
    });

    // Save Pending row to Google Sheets
    const row = buildPendingRow({
      submissionId,
      createdAt,
      sport,
      label,
      formType,
      amount,
      currency,
      orderId,
      fields,
    });
    await appendPendingSubmission(row);

    res.json({ approvalUrl, orderId, submissionId });
  } catch (err) {
    console.error('create-order error:', err.message);
    res.status(500).json({ error: err.message || 'Could not create checkout.' });
  }
});

// POST /api/capture-order
// Called by the frontend after the user returns from PayPal.
// Captures the order with PayPal (server-to-server) and finalizes the submission.
// The PayPal webhook (below) is the authoritative source; this endpoint provides
// an immediate response to the frontend and acts as a fallback if the webhook is slow.
// finalizePaidOrder is idempotent — whichever fires first wins; the second is a no-op.
app.post('/api/capture-order', async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: 'Missing orderID.' });

    const capture = await capturePayPalOrder(orderID);
    const captureInfo = capture.purchase_units?.[0]?.payments?.captures?.[0];
    if (!captureInfo || captureInfo.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'PayPal payment was not completed.' });
    }

    const finalRow = await finalizePaidOrder({ orderId: orderID, captureId: captureInfo.id });
    res.json({ ok: true, status: 'Paid', submission: finalRow });
  } catch (err) {
    console.error('capture-order error:', err.message);
    res.status(500).json({ error: err.message || 'Could not verify payment.' });
  }
});

// POST /api/paypal-webhook
// Receives PayPal webhook events. Verifies the signature before acting.
// Only PAYMENT.CAPTURE.COMPLETED events trigger finalization.
app.post('/api/paypal-webhook', async (req, res) => {
  try {
    const event = req.body;

    const verified = await verifyPayPalWebhook(req.headers, event);
    if (!verified) {
      console.warn('PayPal webhook signature verification failed.');
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const capture = event.resource;
      const orderId = capture.supplementary_data?.related_ids?.order_id;
      const captureId = capture.id;

      if (!orderId) {
        console.warn('Webhook received without order_id:', JSON.stringify(capture));
        return res.json({ received: true, note: 'No order_id found in webhook payload.' });
      }

      await finalizePaidOrder({ orderId, captureId });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('paypal-webhook error:', err.message);
    res.status(500).json({ error: err.message || 'Webhook processing failed.' });
  }
});

export default app;
