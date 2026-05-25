'use strict';
/**
 * First-time setup script. Run with: npm run setup
 * Authenticates both Google accounts sequentially.
 */
require('dotenv').config();
const readline = require('readline');
const { getAuthUrl, exchangeCode } = require('./integrations/calendar');

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function extractCode(input) {
  try {
    const url = new URL(input);
    const code = url.searchParams.get('code');
    if (code) return code;
  } catch { /* not a URL, treat as bare code */ }
  return input.trim();
}

async function authorizeAccount(account, label, hint) {
  console.log(`\n── ${label} ──────────────────────────────────────`);
  if (hint) console.log(`(Sign in as: ${hint})\n`);

  const authUrl = getAuthUrl(account);
  console.log('Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('');

  try {
    const open = require('open');
    await open(authUrl);
    console.log('(Browser opened automatically)\n');
  } catch { /* URL already printed */ }

  console.log('After you sign in and click Allow, your browser will show');
  console.log('"This site can\'t be reached" — that\'s normal.');
  console.log('Copy the FULL URL from the address bar and paste it below.\n');

  const input = await prompt(`Paste the redirect URL for ${label}: `);
  if (!input) throw new Error('No input received.');

  const code = extractCode(input);
  if (!code) throw new Error('Could not extract authorization code from input.');

  console.log('Exchanging code for token...');
  await exchangeCode(code, account);
  console.log(`✓  Token saved for ${label}\n`);
}

async function runSetup() {
  console.log('\n=== Jarvis Setup — Google OAuth (2 accounts) ===\n');

  const fs = require('fs');
  const path = require('path');
  const credPath = path.resolve(process.cwd(), process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json');

  if (!fs.existsSync(credPath)) {
    console.error('❌  credentials.json not found at:', credPath);
    console.error('\nTo get it:');
    console.error('1. Go to https://console.cloud.google.com');
    console.error('2. Select your project → APIs & Services → Credentials');
    console.error('3. Download your OAuth 2.0 Client ID JSON');
    console.error('4. Rename it to credentials.json and place it in the project root\n');
    process.exit(1);
  }

  console.log('✓  credentials.json found');
  console.log('You will authorize TWO Google accounts in sequence.\n');

  // Account 1 — Personal
  await authorizeAccount('personal', 'Personal Google (natanikush@gmail.com)', 'natanikush@gmail.com');

  // Account 2 — ASU
  await authorizeAccount('asu', 'ASU Google (rnatani1@asu.edu)', 'rnatani1@asu.edu');

  console.log('=== Setup Complete ===');
  console.log('\nBoth Google accounts are authorized. Start Jarvis with:');
  console.log('  npm run dev    (development)');
  console.log('  npm start      (production)\n');
}

runSetup().catch((err) => {
  console.error('\n❌  Setup failed:', err.message);
  process.exit(1);
});
