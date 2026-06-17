'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../logger');
const state = require('../state');
const { fetchJobListings, applyToJob } = require('../integrations/workday');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const JOB_PREFERENCES = {
  preferred: ['computer', 'software', 'it ', 'tech', 'data', 'research', 'tutor', 'lab', 'library', 'helpdesk'],
  avoid: ['custodial', 'dining', 'food service', 'grounds', 'parking'],
};

const RESUME_PATH = process.env.RESUME_PATH || path.join(os.homedir(), 'Jarvis-AI', 'data', 'resume.pdf');

function scoreJob(title) {
  const t = title.toLowerCase();
  if (JOB_PREFERENCES.avoid.some((kw) => t.includes(kw))) return 'skip';
  if (JOB_PREFERENCES.preferred.some((kw) => t.includes(kw))) return 'good';
  return 'neutral';
}

async function generateCoverLetter(jobTitle, jobUrl) {
  const prompt = `Write a concise, professional cover letter for a student applying to the following ASU campus job:

Job Title: ${jobTitle}
Job URL: ${jobUrl}

The applicant is Rihaan Natani, a Computer Science student at Arizona State University.
He has experience building full-stack applications, automation systems, and AI integrations.
He is responsible, detail-oriented, and eager to apply his technical skills.

Write 3 short paragraphs: opening (interest + fit), middle (relevant skills/experience), closing (availability + enthusiasm).
Keep it under 250 words. Do not include date, address headers, or "Dear Hiring Manager" — just the body paragraphs.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

async function runWorkdayWatcher(sendFn, sendWithButtons) {
  logger.info('[workday-watcher] Starting job check...');

  let jobs;
  try {
    jobs = await fetchJobListings();
  } catch (err) {
    logger.error('[workday-watcher] Failed to fetch listings:', err.message);
    return;
  }

  const newJobs = jobs.filter((j) => !state.isWorkdayJobSeen(j.id));
  logger.info(`[workday-watcher] ${newJobs.length} new job(s) out of ${jobs.length} total`);

  if (newJobs.length === 0) {
    await sendFn('✅ No new jobs found on Workday since last check.');
    return;
  }

  for (const job of newJobs) {
    state.markWorkdayJobSeen(job.id, job.title, job.url);
  }

  const good = newJobs.filter((j) => scoreJob(j.title) === 'good');
  const neutral = newJobs.filter((j) => scoreJob(j.title) === 'neutral');
  const skipped = newJobs.filter((j) => scoreJob(j.title) === 'skip');

  logger.info(`[workday-watcher] good=${good.length} neutral=${neutral.length} skipped=${skipped.length}`);

  const toShow = [...good, ...neutral];
  if (toShow.length === 0) {
    await sendFn(`ℹ️ ${skipped.length} new job(s) found but all were filtered out (dining/custodial/etc). Nothing relevant.`);
    return;
  }

  const lines = toShow.map((j, i) => {
    const star = scoreJob(j.title) === 'good' ? '⭐ ' : '';
    return `${i + 1}. ${star}*${j.title}*\n   📍 ${j.location || 'ASU Campus'} · ${j.timeType || 'Part-time'}\n   [View posting](${j.url})`;
  });

  const skipNote = skipped.length > 0 ? `\n_(${skipped.length} less relevant job(s) hidden)_` : '';

  const msg =
    `💼 *${toShow.length} new ASU job(s) found!*\n\n` +
    lines.join('\n\n') +
    skipNote +
    `\n\nWhat would you like to do?`;

  state.setSetting('workday_pending_jobs', JSON.stringify(toShow));

  if (sendWithButtons) {
    await sendWithButtons(msg, [
      [
        { text: '✅ Apply to all', callback_data: 'workday_apply_all' },
        { text: '🔍 Let me pick', callback_data: 'workday_pick' },
      ],
      [{ text: '❌ Skip all', callback_data: 'workday_skip_all' }],
    ]);
  } else {
    await sendFn(msg);
    await sendFn('Reply with:\n• `apply all` — apply to all\n• `apply 1,3` — apply to specific jobs\n• `skip` — dismiss all');
  }
}

async function handleApply(indices, sendFn) {
  const pendingRaw = state.getSetting('workday_pending_jobs');
  if (!pendingRaw) {
    await sendFn('⚠️ No pending jobs found. Send `scan jobs` to check for new listings.');
    return;
  }

  const allJobs = JSON.parse(pendingRaw);
  const toApply = indices === 'all' ? allJobs : indices.map((i) => allJobs[i]).filter(Boolean);

  if (toApply.length === 0) {
    await sendFn('⚠️ No valid jobs selected.');
    return;
  }

  await sendFn(`🤖 Generating cover letters and applying to ${toApply.length} job(s)...`);

  const results = [];

  for (const job of toApply) {
    try {
      await sendFn(`📝 Generating cover letter for: *${job.title}*`);
      const coverLetter = await generateCoverLetter(job.title, job.url);

      const clPath = path.join(os.tmpdir(), `cover_letter_${Date.now()}.txt`);
      fs.writeFileSync(clPath, coverLetter, 'utf8');

      if (!fs.existsSync(RESUME_PATH)) {
        await sendFn(
          `⚠️ Resume not found at \`${RESUME_PATH}\`\n\nUpload it with:\n\`\`\`\ngcloud compute scp resume.pdf jarvis:~/Jarvis-AI/data/resume.pdf --zone=us-central1-a\n\`\`\`\n\n📄 *Cover letter for ${job.title}:*\n\n${coverLetter}`
        );
        results.push({ job, success: false, reason: 'no_resume' });
        continue;
      }

      const result = await applyToJob({
        resumePath: RESUME_PATH,
        coverLetterPath: clPath,
        jobUrl: job.url,
      });

      fs.unlinkSync(clPath);

      if (result.success) {
        state.markWorkdayJobApplied(job.id);
        await sendFn(`✅ Applied to: *${job.title}*`);
        results.push({ job, success: true });
      } else if (result.reason === 'sso_required') {
        await sendFn(
          `🔐 *${job.title}* requires ASU SSO login — can't auto-apply headlessly.\n\nApply manually: ${job.url}\n\n📄 *Your cover letter:*\n\n${coverLetter}`
        );
        results.push({ job, success: false, reason: 'sso_required' });
      } else {
        await sendFn(`⚠️ Could not apply to *${job.title}*: ${result.reason}\n\nApply manually: ${job.url}`);
        results.push({ job, success: false, reason: result.reason });
      }
    } catch (err) {
      logger.error(`[workday-watcher] Apply error for ${job.title}:`, err.message);
      await sendFn(`❌ Error on *${job.title}*: ${err.message}`);
      results.push({ job, success: false, reason: err.message });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  await sendFn(`📊 *Done!*\n✅ Applied: ${succeeded}\n⚠️ Manual needed: ${failed}\n\nGood luck! 🍀`);
  state.setSetting('workday_pending_jobs', '');
}

module.exports = { runWorkdayWatcher, handleApply };
