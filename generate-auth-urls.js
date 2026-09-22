#!/usr/bin/env node
'use strict';
const { getAuthUrl } = require('./src/integrations/calendar');

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║ Google OAuth Authorization URLs                              ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

console.log('1. Personal Account (natanikush@gmail.com):');
console.log('───────────────────────────────────────────────────────────────');
console.log(getAuthUrl('personal'));
console.log('\n');

console.log('2. ASU Account (rnatani1@asu.edu):');
console.log('───────────────────────────────────────────────────────────────');
console.log(getAuthUrl('asu'));
console.log('\n');

console.log('Instructions:');
console.log('1. Click the Personal Account URL above');
console.log('2. Sign in with natanikush@gmail.com and click "Allow"');
console.log('3. Copy the full URL from the browser address bar');
console.log('4. Paste it into this command:');
console.log('   node -e "const c = require(\'./src/integrations/calendar\'); c.exchangeCode(\'PASTE_CODE_HERE\', \'personal\').then(() => console.log(\'✓ Done\')).catch(e => console.error(e.message))"');
console.log('\n5. Repeat for the ASU account (step 2 and 3 above, but use asu instead of personal)\n');
