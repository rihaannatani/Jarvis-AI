'use strict';

function announcementInferencePrompt(announcement) {
  return `You're reviewing a new Canvas course announcement for Rihaan Natani, a CS student at ASU (student ID 1234832666). Read between the lines — professors often bury the actually important part in a wall of text.

Course: ${announcement.course}
Title: ${announcement.title}
Posted by: ${announcement.author || 'unknown'}
Full text:
${announcement.message}

Extract what actually matters. Look for:
- Deadline changes, extensions, or new due dates (even if mentioned in passing)
- Exam/quiz format changes, new topics added/removed, open-book vs closed-book
- Required actions: things to bring, forms to submit, sign-ups needed
- Extra credit opportunities
- Cancellations (class, office hours, exam)
- Anything that contradicts or updates the syllabus

Reply with ONLY a JSON object:
{
  "matters": true/false,
  "urgency": 1-10 (10 = needs to see this today, 1 = routine/skippable),
  "summary": "1-2 sentence plain-language summary of what actually changed or is required — not a restatement of the announcement title",
  "action_needed": "specific thing Rihaan needs to do, or null if none"
}

Set "matters" to false only for routine posts with no action items or changes (e.g. "welcome to the course", "here's the syllabus", generic reminders already on the calendar).`;
}

function assignmentInferencePrompt(assignment, context) {
  return `You're reviewing a new or changed Canvas assignment for Rihaan Natani, a CS student at ASU.

Assignment: ${assignment.name}
Course: ${assignment.course}
Due: ${assignment.dueAt}
Points: ${assignment.pointsPossible ?? 'unknown'}
Submission type: ${(assignment.submissionTypes || []).join(', ') || 'unknown'}
${context ? `\nOther context (nearby deadlines, past patterns):\n${context}` : ''}

Flag anything worth a heads-up beyond the routine "new assignment posted" notice. Consider:
- Does this due date collide with or land right before/after another known deadline?
- Is the point value unusually high (suggests a major project/exam-weight item) or unusually low (quick/no-brainer)?
- Does the submission type need prep time (e.g. a physical/proctored exam, group project, presentation)?

Reply with ONLY a JSON object:
{
  "noteworthy": true/false,
  "note": "short heads-up sentence if noteworthy, else null"
}`;
}

module.exports = { announcementInferencePrompt, assignmentInferencePrompt };
