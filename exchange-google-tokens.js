#!/usr/bin/env node
'use strict';
const { exchangeCode } = require('./src/integrations/calendar');

const personalCode = '4/0AXlqoi4YPOtXzOigtHdfV3j22yohl4kE4gU8RHcsqDZ0Quz6LlPRvBuWgRSdEu7Wjcx4zQ';
const asuCode = '4/0AXlqoi7qUgcscy5P-lsMZ4HvSXiVuHyEQNZz1aVH4pSzcZvz5nBlSXUR4N6HbEKkGME0dw';

(async () => {
  try {
    console.log('Exchanging personal account token...');
    await exchangeCode(personalCode, 'personal');
    console.log('✓ Personal account token saved');

    console.log('Exchanging ASU account token...');
    await exchangeCode(asuCode, 'asu');
    console.log('✓ ASU account token saved');

    console.log('\n✓ All tokens exchanged successfully!');
    process.exit(0);
  } catch (err) {
    console.error('✗ Error exchanging tokens:', err.message);
    process.exit(1);
  }
})();
