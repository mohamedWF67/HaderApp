// Server-side input checks (Lab 4). The browser form is NOT trusted:
// every value is checked here before it reaches the database.
const { ApiError } = require('../middleware/errors');

function bad(message) {
  return new ApiError(400, 'VALIDATION_ERROR', message);
}

// Route ids like /workshops/12 must be positive whole numbers.
function parseId(value, name = 'id') {
  if (!/^[1-9][0-9]{0,9}$/.test(String(value))) {
    throw bad(`${name} must be a positive whole number.`);
  }
  return Number(value);
}

// Body for creating or editing a workshop:
// { "title": "...", "description": "...", "date": "2026-12-01T10:00:00Z", "totalSeats": 30,
//   "registrationDeadline": "2026-11-30T18:00:00Z" }   <- optional; empty or missing = open until it starts
function validateWorkshop(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('Request body must be a JSON object.');
  }
  const { title, description = '', date, totalSeats, registrationDeadline = null } = body;

  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 100) {
    throw bad('Title must contain between 3 and 100 characters.');
  }
  if (typeof description !== 'string' || description.length > 1000) {
    throw bad('Description must be text of at most 1000 characters.');
  }
  if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) {
    throw bad('Date must be a valid date, for example 2026-12-01T10:00:00Z.');
  }
  if (new Date(date) <= new Date()) {
    throw bad('Date must be in the future.');
  }
  if (!Number.isInteger(totalSeats) || totalSeats < 1 || totalSeats > 1000) {
    throw bad('totalSeats must be a whole number between 1 and 1000.');
  }

  // Optional deadline: must be a valid date, and not after the workshop starts.
  // An organizer may set it to a time that has passed, to close registration early.
  let deadline = null;
  if (registrationDeadline !== null && registrationDeadline !== '') {
    if (typeof registrationDeadline !== 'string' || Number.isNaN(Date.parse(registrationDeadline))) {
      throw bad('registrationDeadline must be a valid date, for example 2026-11-30T18:00:00Z.');
    }
    if (new Date(registrationDeadline) > new Date(date)) {
      throw bad('The registration deadline cannot be after the workshop starts.');
    }
    deadline = new Date(registrationDeadline).toISOString();
  }

  return {
    registrationDeadline: deadline,
    title: title.trim(),
    description: description.trim(),
    date: new Date(date).toISOString(),
    totalSeats
  };
}

module.exports = { parseId, validateWorkshop };
