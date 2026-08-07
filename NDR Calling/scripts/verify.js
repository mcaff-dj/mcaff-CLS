const { google } = require('googleapis');

async function main() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  console.log('TABS:', meta.data.sheets.map((s) => s.properties.title));

  const firstTab = meta.data.sheets[0].properties.title;
  const header = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${firstTab}!A1:Z1`,
  });
  console.log('HEADER:', header.data.values[0]);

  const sample = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${firstTab}!A2:Z10`,
  });
  console.log('SAMPLE ROWS:', JSON.stringify(sample.data.values, null, 2));
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
