const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const { pool } = require('../config/database');

const router = express.Router();

// ─────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Please try again later.',
});

// ─────────────────────────────────────────────
// GET /auth/login
// ─────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/videos');
  }

  res.render('auth/login', {
    title: 'Log In',
    errors: [],
  });
});

// ─────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────

router.post(
  '/login',
  authLimiter,

  [
    body('email')
      .trim()
      .isEmail()
      .withMessage('Please enter a valid email address.')
      .normalizeEmail(),

    body('password')
      .notEmpty()
      .withMessage('Password is required.'),
  ],

  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.render('auth/login', {
        title: 'Log In',
        errors: errors.array(),
      });
    }

    const { email, password } = req.body;

    try {
      // Find user in Neon PostgreSQL
      const result = await pool.query(
        `
        SELECT *
        FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
        `,
        [email]
      );

      const user = result.rows[0];

      if (!user) {
        return res.render('auth/login', {
          title: 'Log In',
          errors: [
            { msg: 'Invalid email or password.' }
          ],
        });
      }

      // Check password
      const passwordMatches = await bcrypt.compare(
        password,
        user.password_hash
      );

      if (!passwordMatches) {
        return res.render('auth/login', {
          title: 'Log In',
          errors: [
            { msg: 'Invalid email or password.' }
          ],
        });
      }

      // Rotate the session ID after authentication to prevent session fixation.
      req.session.regenerate((sessionError) => {
        if (sessionError) {
          console.error('Session regeneration error:', sessionError);
          return res.status(500).render('error', {
            title: '500 — Server Error',
            message: 'Something went wrong while logging in.',
            code: 500,
          });
        }

        req.session.userId = user.id;
        req.session.successMessage = `Welcome back, ${user.username}!`;
        req.session.save((saveError) => {
          if (saveError) {
            console.error('Session save error:', saveError);
            return res.status(500).render('error', {
              title: '500 — Server Error',
              message: 'Something went wrong while logging in.',
              code: 500,
            });
          }
          return res.redirect('/videos');
        });
      });

    } catch (err) {
      console.error('Login error:', err);

      return res.status(500).render('error', {
        title: '500 — Server Error',
        message: 'Something went wrong while logging in.',
        code: 500,
      });
    }
  }
);

// ─────────────────────────────────────────────
// GET /auth/register
// ─────────────────────────────────────────────

router.get('/register', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/videos');
  }

  res.render('auth/register', {
    title: 'Register',
    errors: [],
    formData: {},
  });
});

// ─────────────────────────────────────────────
// POST /auth/register
// ─────────────────────────────────────────────

router.post(
  '/register',
  authLimiter,

  [
    body('username')
      .trim()
      .isLength({ min: 3, max: 30 })
      .withMessage('Username must be 3–30 characters.')
      .matches(/^[a-zA-Z0-9_-]+$/)
      .withMessage(
        'Username can only contain letters, numbers, hyphens, and underscores.'
      ),

    body('email')
      .trim()
      .isEmail()
      .withMessage('Please enter a valid email address.')
      .normalizeEmail(),

    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters.'),

    body('confirmPassword')
      .custom((value, { req }) => value === req.body.password)
      .withMessage('Passwords do not match.'),
  ],

  async (req, res) => {
    const errors = validationResult(req);

    // Validation failed
    if (!errors.isEmpty()) {
      return res.render('auth/register', {
        title: 'Register',
        errors: errors.array(),
        formData: {
          username: req.body.username || '',
          email: req.body.email || '',
        },
      });
    }

    const username = req.body.username.trim();
    const email = req.body.email.trim().toLowerCase();
    const password = req.body.password;

    try {
      // ───────────────────────────────────────
      // Check username
      // ───────────────────────────────────────

      const usernameResult = await pool.query(
        `
        SELECT id
        FROM users
        WHERE LOWER(username) = LOWER($1)
        LIMIT 1
        `,
        [username]
      );

      if (usernameResult.rows.length > 0) {
        return res.render('auth/register', {
          title: 'Register',
          errors: [
            { msg: 'That username is already taken.' }
          ],
          formData: {
            username,
            email,
          },
        });
      }

      // ───────────────────────────────────────
      // Check email
      // ───────────────────────────────────────

      const emailResult = await pool.query(
        `
        SELECT id
        FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
        `,
        [email]
      );

      if (emailResult.rows.length > 0) {
        return res.render('auth/register', {
          title: 'Register',
          errors: [
            { msg: 'That email is already registered.' }
          ],
          formData: {
            username,
            email,
          },
        });
      }

      // ───────────────────────────────────────
      // Hash password
      // ───────────────────────────────────────

      const passwordHash = await bcrypt.hash(password, 12);

      // ───────────────────────────────────────
      // Public registration must never grant administrator privileges.
      // Promote a trusted account manually or through a protected admin workflow.
      const role = 'user';

      // ───────────────────────────────────────
      // Create user
      // ───────────────────────────────────────

      const insertResult = await pool.query(
        `
        INSERT INTO users
          (username, email, password_hash, role)
        VALUES
          ($1, $2, $3, $4)
        RETURNING id
        `,
        [
          username,
          email,
          passwordHash,
          role,
        ]
      );

      const userId = insertResult.rows[0].id;

      // ───────────────────────────────────────
      // Auto-login with a fresh session ID after account creation.
      req.session.regenerate((sessionError) => {
        if (sessionError) {
          console.error('Registration session error:', sessionError);
          return res.status(500).render('error', {
            title: '500 — Server Error',
            message: 'Your account was created, but automatic login failed. Please log in.',
            code: 500,
          });
        }

        req.session.userId = userId;
        req.session.successMessage = `Welcome to JoyBoy, ${username}!`;
        req.session.save((saveError) => {
          if (saveError) {
            console.error('Registration session save error:', saveError);
            return res.status(500).render('error', {
              title: '500 — Server Error',
              message: 'Your account was created, but automatic login failed. Please log in.',
              code: 500,
            });
          }
          return res.redirect('/videos');
        });
      });

    } catch (err) {
      console.error('Registration error:', err);

      // PostgreSQL unique violation
      if (err.code === '23505') {
        return res.render('auth/register', {
          title: 'Register',
          errors: [
            {
              msg: 'That username or email is already registered.'
            }
          ],
          formData: {
            username,
            email,
          },
        });
      }

      return res.status(500).render('error', {
        title: '500 — Server Error',
        message: 'Something went wrong while creating your account.',
        code: 500,
      });
    }
  }
);

// ─────────────────────────────────────────────
// POST /auth/logout
// ─────────────────────────────────────────────

router.post('/logout', (req, res) => {
  if (!req.session) {
    res.clearCookie('connect.sid', { path: '/' });
    return res.redirect('/auth/login');
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
      return res.status(500).render('error', {
        title: '500 — Server Error',
        message: 'Could not log out safely. Please try again.',
        code: 500,
      });
    }

    res.clearCookie('connect.sid', { path: '/' });
    return res.redirect('/auth/login');
  });
});

module.exports = router;