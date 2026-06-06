import { Resend } from 'resend';

let _resend = null;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function row(label, value) {
  if (!value) return '';
  return `<tr>
    <td style="padding:6px 12px;font-weight:600;color:#555;white-space:nowrap;">${label}</td>
    <td style="padding:6px 12px;color:#111;">${value}</td>
  </tr>`;
}

function emailShell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr>
          <td style="background:#1a1a2e;padding:24px 32px;">
            <h1 style="margin:0;color:#F2D500;font-size:22px;letter-spacing:1px;">GMAA</h1>
            <p style="margin:4px 0 0;color:#aaa;font-size:13px;">Georgia Muslim Athletic Association</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h2 style="margin:0 0 20px;color:#1a1a2e;font-size:18px;">${title}</h2>
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;background:#f9f9f9;border-top:1px solid #eee;">
            <p style="margin:0;color:#999;font-size:12px;">Questions? Email us at <a href="mailto:info@gmaa.online" style="color:#1a1a2e;">info@gmaa.online</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildParticipantHtml(s) {
  const isSignup = s['Form Type'] === 'Signup';
  const tableRows = [
    row('Sport', s['Event Label'] || s['Sport']),
    row('Registration Type', s['Form Type']),
    row('Name', s['Full Name']),
    row('Email', s['Email']),
    row('Phone', s['Phone']),
    row('Amount Paid', `$${s['Amount']} ${s['Currency']}`),
    row('PayPal Order ID', s['PayPal Order ID']),
    isSignup ? row('Team', s['Team Name']) : '',
    isSignup ? row('Jersey Size', s['Jersey Size']) : '',
    isSignup ? row('Jersey Type', s['Jersey Type']) : '',
    isSignup ? row('Jersey Number', s['Jersey Number']) : '',
    !isSignup ? row('Sponsor / Business', s['Sponsor Name'] || s['Sponsor Business']) : '',
  ].filter(Boolean).join('\n');

  return emailShell(
    'Payment Confirmed!',
    `<p style="color:#333;margin:0 0 20px;">Thank you! Your GMAA registration payment has been confirmed. Keep this email for your records.</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:6px;overflow:hidden;">
      ${tableRows}
    </table>
    <p style="color:#555;margin:20px 0 0;font-size:14px;">We look forward to seeing you at the event!</p>`
  );
}

function buildAdminHtml(s) {
  const tableRows = [
    row('Submission ID', s['Submission ID']),
    row('Paid At', s['Paid At']),
    row('Sport', s['Event Label'] || s['Sport']),
    row('Form Type', s['Form Type']),
    row('Name', s['Full Name']),
    row('Email', s['Email']),
    row('Phone', s['Phone']),
    row('Team', s['Team Name']),
    row('Amount', `$${s['Amount']} ${s['Currency']}`),
    row('PayPal Order ID', s['PayPal Order ID']),
    row('PayPal Capture ID', s['PayPal Capture ID']),
    row('Jersey Size', s['Jersey Size']),
    row('Jersey Type', s['Jersey Type']),
    row('Jersey Number', s['Jersey Number']),
    row('Printed Name', s['Printed Name']),
    row('Sponsor Name', s['Sponsor Name']),
    row('Sponsor Business', s['Sponsor Business']),
    row('Sponsor Message', s['Sponsor Message']),
  ].filter(Boolean).join('\n');

  return emailShell(
    `New Paid ${s['Form Type']}: ${s['Full Name']}`,
    `<p style="color:#333;margin:0 0 20px;">A new payment has been confirmed. Details below.</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:6px;overflow:hidden;">
      ${tableRows}
    </table>`
  );
}

export async function sendParticipantConfirmation(submission) {
  const resend = getResend();
  if (!resend) return 'Skipped (RESEND_API_KEY not set)';
  if (!submission['Email']) return 'Skipped (no email address)';

  const from = requiredEnv('EMAIL_FROM');
  await resend.emails.send({
    from,
    to: submission['Email'],
    subject: `GMAA Payment Confirmed – ${submission['Event Label'] || submission['Sport']}`,
    html: buildParticipantHtml(submission),
  });
  return 'Sent';
}

export async function sendAdminPaidNotification(submission) {
  const resend = getResend();
  if (!resend) return 'Skipped (RESEND_API_KEY not set)';

  const from = requiredEnv('EMAIL_FROM');
  const adminEmail = requiredEnv('ADMIN_EMAIL');
  await resend.emails.send({
    from,
    to: adminEmail,
    subject: `[GMAA] Paid ${submission['Form Type']}: ${submission['Full Name']} – ${submission['Event Label'] || submission['Sport']}`,
    html: buildAdminHtml(submission),
  });
  return 'Sent';
}
