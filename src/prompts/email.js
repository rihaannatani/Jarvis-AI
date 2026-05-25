'use strict';

function draftReplyPrompt({ originalEmail, instruction }) {
  return `Draft a reply to the following email.

ORIGINAL EMAIL:
From: ${originalEmail.from}
Subject: ${originalEmail.subject}
Body:
${originalEmail.body}

${instruction ? `INSTRUCTION: ${instruction}` : ''}

WRITING RULES:
- Sound like a real person, not a corporate template
- Match the tone of the original email (formal if they're formal, casual if casual)
- Be concise — say what needs to be said, nothing more
- End with an appropriate sign-off (use just a first name or "Best," based on the relationship)
- Do NOT include a subject line — just the body of the reply
- Do NOT include any commentary before or after the draft — output only the email body`;
}

function emailTriagePrompt(emails) {
  return `You're reviewing a batch of new emails for importance triage.

EMAILS:
${JSON.stringify(emails, null, 2)}

For each email, output a JSON array with objects containing:
- id: the email id
- score: importance score 1-10 (10 = needs immediate attention)
- reason: one short sentence explaining the score
- summary: 1-2 sentence summary of what the email is about
- needsDraft: true if this email warrants a draft reply

Score high (7+) for:
- Direct emails from real people (professors, family, work contacts)
- Anything with urgency keywords: urgent, deadline, asap, action required, time-sensitive
- Thread replies where the user was directly addressed
- Appointment confirmations or cancellations

Score low for:
- Mailing lists, newsletters, marketing
- Auto-generated notifications
- CC'd emails where action isn't required

Output ONLY valid JSON array, no other text.`;
}

module.exports = { draftReplyPrompt, emailTriagePrompt };
