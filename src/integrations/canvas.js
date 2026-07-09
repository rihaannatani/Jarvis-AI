'use strict';
const axios = require('axios');
const config = require('../config');
const logger = require('../logger');
const { withResilience } = require('./api-utils');

function client() {
  return axios.create({
    baseURL: `${config.canvas.baseUrl}/api/v1`,
    headers: { Authorization: `Bearer ${config.canvas.apiToken}` },
  });
}

function describeError(err) {
  if (err.response) return `HTTP ${err.response.status} ${JSON.stringify(err.response.data)?.slice(0, 300)}`;
  if (err.request) return `no response (${err.code || 'network error'})`;
  return err.message || String(err);
}

// Assignments, announcements, and grades each need the course list, and
// several cron jobs (morning brief, canvas watcher, assignment reminders)
// can all fire within the same minute — cache briefly so a burst of calls
// shares one request instead of hammering Canvas with duplicates.
const COURSES_CACHE_MS = 60 * 1000;
let coursesCache = { data: null, fetchedAt: 0 };

async function getCourses() {
  if (!config.canvas.apiToken) return [];
  if (coursesCache.data && Date.now() - coursesCache.fetchedAt < COURSES_CACHE_MS) {
    return coursesCache.data;
  }
  try {
    const courses = await withResilience('canvas', async () => {
      const res = await client().get('/courses', {
        params: { enrollment_state: 'active', per_page: 50 },
      });
      return res.data.filter((c) => c.name && !c.access_restricted_by_date);
    });
    coursesCache = { data: courses, fetchedAt: Date.now() };
    return courses;
  } catch (err) {
    logger.error(`[canvas] getCourses failed: ${describeError(err)}`);
    return [];
  }
}

async function getAssignments() {
  if (!config.canvas.apiToken) return [];
  try {
    const courses = await getCourses();
    const now = new Date();

    const allAssignments = await Promise.all(
      courses.map(async (course) => {
        try {
          const res = await withResilience('canvas', () =>
            client().get(`/courses/${course.id}/assignments`, {
              params: {
                order_by: 'due_at',
                per_page: 50,
                bucket: 'upcoming',
              },
            })
          );
          return res.data
            .filter((a) => a.due_at)
            .map((a) => ({
              id: a.id,
              course: course.name,
              courseCode: course.course_code,
              name: a.name,
              dueAt: a.due_at,
              pointsPossible: a.points_possible,
              submissionTypes: a.submission_types,
              htmlUrl: a.html_url,
            }));
        } catch (err) {
          logger.warn(`[canvas] getAssignments for course ${course.id} failed: ${describeError(err)}`);
          return [];
        }
      })
    );

    return allAssignments
      .flat()
      .filter((a) => new Date(a.dueAt) > now)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  } catch (err) {
    logger.error(`[canvas] getAssignments failed: ${describeError(err)}`);
    throw err;
  }
}

async function getAnnouncements() {
  if (!config.canvas.apiToken) return [];
  try {
    const courses = await getCourses();
    const courseIds = courses.map((c) => `context_codes[]=course_${c.id}`).join('&');
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // Canvas announcements don't include a course name field directly —
    // resolve it from the course id embedded in html_url (courses/<id>/discussion_topics/...)
    const courseNameById = new Map(courses.map((c) => [String(c.id), c.name]));

    const res = await withResilience('canvas', () =>
      client().get(`/announcements?${courseIds}`, {
        params: { start_date: since, per_page: 20 },
      })
    );

    return res.data.map((a) => {
      const courseIdMatch = a.html_url?.match(/courses\/(\d+)/);
      const course = (courseIdMatch && courseNameById.get(courseIdMatch[1])) || 'Unknown course';
      return {
        id: a.id,
        title: a.title,
        author: a.author?.display_name,
        course,
        postedAt: a.posted_at,
        message: a.message?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      };
    });
  } catch (err) {
    logger.error(`[canvas] getAnnouncements failed: ${describeError(err)}`);
    throw err;
  }
}

async function getGrades() {
  if (!config.canvas.apiToken) return [];
  try {
    const courses = await getCourses();
    return courses.map((c) => ({
      course: c.name,
      courseCode: c.course_code,
      grade: c.enrollments?.[0]?.computed_current_grade,
      score: c.enrollments?.[0]?.computed_current_score,
    }));
  } catch (err) {
    logger.error(`[canvas] getGrades failed: ${describeError(err)}`);
    return [];
  }
}

module.exports = { getCourses, getAssignments, getAnnouncements, getGrades };
