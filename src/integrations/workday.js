'use strict';
const { chromium } = require('playwright');
const logger = require('../logger');

const WORKDAY_JOBS_URL =
  'https://asu.wd1.myworkdayjobs.com/en-US/asustudentworker';

async function fetchJobListings() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const jobs = [];

  try {
    logger.info('[workday] Navigating to jobs listing page...');
    await page.goto(WORKDAY_JOBS_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('[data-automation-id="jobItem"]', { timeout: 20000 });

    const listings = await page.$$('[data-automation-id="jobItem"]');
    logger.info(`[workday] Found ${listings.length} job listings`);

    for (const item of listings) {
      try {
        const titleEl = await item.$('[data-automation-id="jobTitle"]');
        const title = titleEl ? (await titleEl.innerText()).trim() : 'Unknown';

        const locationEl = await item.$('[data-automation-id="location"]');
        const location = locationEl ? (await locationEl.innerText()).trim() : '';

        const timeEl = await item.$('[data-automation-id="time"]');
        const timeType = timeEl ? (await timeEl.innerText()).trim() : '';

        const linkEl = await item.$('a');
        const href = linkEl ? await linkEl.getAttribute('href') : null;
        const url = href ? `https://asu.wd1.myworkdayjobs.com${href}` : WORKDAY_JOBS_URL;
        const id = href ? href.replace(/[^a-zA-Z0-9]/g, '_').slice(-60) : title.replace(/\s+/g, '_');

        jobs.push({ id, title, location, timeType, url });
      } catch (err) {
        logger.warn('[workday] Failed to parse a job item:', err.message);
      }
    }
  } finally {
    await browser.close();
  }

  return jobs;
}

async function applyToJob({ resumePath, coverLetterPath, jobUrl }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    logger.info(`[workday] Navigating to job: ${jobUrl}`);
    await page.goto(jobUrl, { waitUntil: 'networkidle', timeout: 30000 });

    const applyBtn = await page.$('[data-automation-id="applyButton"]');
    if (!applyBtn) throw new Error('Apply button not found — may require login first');
    await applyBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    const currentUrl = page.url();
    if (currentUrl.includes('shibboleth') || currentUrl.includes('weblogin.asu.edu')) {
      logger.warn('[workday] Hit SSO wall — cannot proceed headlessly');
      return { success: false, reason: 'sso_required', url: currentUrl };
    }

    if (resumePath) {
      const resumeInput = await page.$('input[type="file"]');
      if (resumeInput) {
        await resumeInput.setInputFiles(resumePath);
        await page.waitForTimeout(2000);
        logger.info('[workday] Resume uploaded');
      }
    }

    if (coverLetterPath) {
      const fileInputs = await page.$$('input[type="file"]');
      if (fileInputs.length > 1) {
        await fileInputs[1].setInputFiles(coverLetterPath);
        await page.waitForTimeout(2000);
        logger.info('[workday] Cover letter uploaded');
      }
    }

    const submitBtn = await page.$('[data-automation-id="bottom-navigation-next-button"]');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      logger.info('[workday] Application submitted');
      return { success: true };
    }

    return { success: false, reason: 'submit_button_not_found' };
  } catch (err) {
    logger.error('[workday] Apply failed:', err.message);
    return { success: false, reason: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { fetchJobListings, applyToJob };
