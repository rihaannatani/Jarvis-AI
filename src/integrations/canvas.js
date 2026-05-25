'use strict';
const axios = require('axios');
const config = require('../config');
const logger = require('../logger');

function client() {
  return axios.create({
    baseURL: `${config.canvas.baseUrl}/api/v1`,
    headers: { Authorization: `Bearer ${config.canvas.apiToken}` },
  });
}

async function getCourses() {
  if (!config.canvas.apiToken) return [];
  try {
    const res = await client().get('/courses', {
      params: { enrollment_state: 'active', per_page: 50 },
    });
    return res.data.filter((c) => c.name && !c.access_restricted_by_date);
  } catch (err) {
    logger.error('[canvas] getCourses failed:', err.message);
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
          const res = await client().get(`/courses/${course.id}/assignments`, {
            params: {
              order_by: 'due_at',
              per_page: 50,
              bucket: 'upcoming',
            },
          });
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
        } catch {
          return [];
        }
      })
    );

    return allAssignments
      .flat()
      .filter((a) => new Date(a.dueAt) > now)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  } catch (err) {
    logger.error('[canvas] getAssignments failed:', err.message);
    throw err;
  }
}

async function getAnnouncements() {
  if (!config.canvas.apiToken) return [];
  try {
    const courses = await getCourses();
    const courseIds = courses.map((c) => `context_codes[]=course_${c.id}`).join('&');
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const res = await client().get(`/announcements?${courseIds}`, {
      params: { start_date: since, per_page: 20 },
    });

    return res.data.map((a) => ({
      id: a.id,
      title: a.title,
      author: a.author?.display_name,
      course: a.context_name,
      postedAt: a.posted_at,
      message: a.message?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
    }));
  } catch (err) {
    logger.error('[canvas] getAnnouncements failed:', err.message);
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
    logger.error('[canvas] getGrades failed:', err.message);
    throw err;
  }
}

module.exports = { getCourses, getAssignments, getAnnouncements, getGrades };
