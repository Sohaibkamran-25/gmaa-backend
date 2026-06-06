import { google } from 'googleapis';

const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Submissions';

export const HEADERS = [
  'Submission ID',
  'Created At',
  'Updated At',
  'Sport',
  'Event Label',
  'Form Type',
  'Payment Status',
  'Amount',
  'Currency',
  'PayPal Order ID',
  'PayPal Capture ID',
  'Full Name',
  'Email',
  'Phone',
  'Team Name',
  'Jersey Size',
  'Jersey Type',
  'Jersey Number',
  'Printed Name',
  'Waiver Accepted',
  'Signature',
  'Sponsor Name',
  'Sponsor Business',
  'Sponsor Message',
  'Paid At',
  'Admin Email Sent',
  'Participant Email Sent',
];

// Convert 1-based column number to letter(s): 1=A, 26=Z, 27=AA
function colLetter(n) {
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

const LAST_COL = colLetter(HEADERS.length); // 'AA' for 27 columns

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function cleanPrivateKey(key) {
  return key.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
}

async function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: requiredEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    key: cleanPrivateKey(requiredEnv('GOOGLE_PRIVATE_KEY')),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function fieldOf(fields, ...names) {
  for (const name of names) {
    if (fields?.[name]) return String(fields[name]);
  }
  return '';
}

export function buildPendingRow({
  submissionId,
  createdAt,
  sport,
  label,
  formType,
  amount,
  currency,
  orderId,
  fields,
}) {
  const isSponsor = formType === 'sponsor';
  const waiverText = Object.entries(fields || {})
    .filter(([key]) => key.startsWith('Acknowledgment'))
    .map(([, v]) => v)
    .join(' | ');

  const row = new Array(HEADERS.length).fill('');
  const set = (header, value) => {
    const idx = HEADERS.indexOf(header);
    if (idx !== -1) row[idx] = value ?? '';
  };

  set('Submission ID', submissionId);
  set('Created At', createdAt);
  set('Updated At', createdAt);
  set('Sport', sport);
  set('Event Label', label);
  set('Form Type', isSponsor ? 'Sponsor' : 'Signup');
  set('Payment Status', 'Pending');
  set('Amount', amount);
  set('Currency', currency);
  set('PayPal Order ID', orderId || '');
  set('Full Name', fieldOf(fields, 'Full Name', 'Contact Name'));
  set('Email', fieldOf(fields, 'email', 'Email'));
  set('Phone', fieldOf(fields, 'Phone Number', 'Phone'));
  set('Team Name', fieldOf(fields, 'Team Name'));

  if (!isSponsor) {
    set('Jersey Size', fieldOf(fields, 'Jersey Size'));
    set('Jersey Type', fieldOf(fields, 'Jersey Type'));
    set('Jersey Number', fieldOf(fields, 'Jersey Number'));
    set('Printed Name', fieldOf(fields, 'Printed Name on Jersey', 'Printed Name'));
    set('Waiver Accepted', waiverText);
    set('Signature', fieldOf(fields, 'Electronic Signature', 'Signature'));
  }

  if (isSponsor) {
    set('Sponsor Name', fieldOf(fields, 'Company / Sponsor Name', 'Sponsor Name'));
    set('Sponsor Business', fieldOf(fields, 'Sponsor Business'));
    set('Sponsor Message', fieldOf(fields, 'Sponsorship Notes', 'Sponsor Message'));
  }

  return row;
}

export async function appendPendingSubmission(row) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: requiredEnv('GOOGLE_SHEET_ID'),
    range: `${SHEET_TAB}!A:${LAST_COL}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

export async function findSubmissionByPayPalOrderId(orderId) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: requiredEnv('GOOGLE_SHEET_ID'),
    range: `${SHEET_TAB}!A:${LAST_COL}`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return null;

  const headers = rows[0];
  const orderCol = headers.indexOf('PayPal Order ID');
  if (orderCol === -1) {
    throw new Error('"PayPal Order ID" column not found. Ensure the sheet has the correct header row.');
  }

  const rowIndex = rows.findIndex((row, i) => i > 0 && row[orderCol] === orderId);
  if (rowIndex === -1) return null;

  const data = {};
  headers.forEach((h, i) => { data[h] = rows[rowIndex][i] || ''; });

  return { rowIndex, data, rawRow: rows[rowIndex], headers };
}

// Updates a submission to Paid and records email send results.
// orderId: PayPal Order ID stored in the sheet.
// updates: object with keys matching HEADERS (only provided keys are changed).
export async function updateSubmissionPaid(orderId, updates) {
  const found = await findSubmissionByPayPalOrderId(orderId);
  if (!found) throw new Error(`No submission found for PayPal order: ${orderId}`);

  const { rowIndex, rawRow, headers } = found;
  const row = [...rawRow];

  // Extend the row if the sheet has fewer columns than our HEADERS (safe padding)
  while (row.length < HEADERS.length) row.push('');

  for (const [header, value] of Object.entries(updates)) {
    const idx = headers.indexOf(header);
    if (idx !== -1) row[idx] = value ?? '';
  }

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: requiredEnv('GOOGLE_SHEET_ID'),
    range: `${SHEET_TAB}!A${rowIndex + 1}:${LAST_COL}${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });

  const data = {};
  headers.forEach((h, i) => { data[h] = row[i] || ''; });
  return data;
}
