require('dotenv').config();

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const {
  pool,
  initDatabase,
  testConnection,
} = require('./config/database');

const { attachUser } = require('./middleware/auth');
const helpers = require('./utils/helpers');

const supabaseOrigin = process.env.SUPABASE_URL
  ? new URL(process.env.SUPABASE_URL).origin
  : 'https://*.supabase.co';

const app = express();

// ─────────────────────────────────────────────
// Render runs behind a proxy
// ─────────────────────────────────────────────

app.set('trust proxy', 1);

// ─────────────────────────────────────────────
// Ensure directories exist
// ─────────────────────────────────────────────

// Vercel's deployment filesystem is read-only. New uploads are stored in
// Supabase Storage; local folders are only needed for local development.
if (!process.env.VERCEL) {
  const dirs = [
    'uploads/videos',
    'uploads/thumbnails',
    'uploads/avatars',
    'data',
  ];

  dirs.forEach((dir) => {
    const fullPath = path.join(__dirname, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  });
}

// ─────────────────────────────────────────────
// Security headers
// ─────────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],

        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
        ],

        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
        ],

        fontSrc: [
          "'self'",
          'https://fonts.gstatic.com',
        ],

        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          supabaseOrigin,
        ],

        mediaSrc: [
          "'self'",
          'blob:',
          supabaseOrigin,
        ],

        connectSrc: [
          "'self'",
          supabaseOrigin,
        ],
      },
    },

    crossOriginEmbedderPolicy: false,
  })
);

// ─────────────────────────────────────────────
// Body parsing
// ─────────────────────────────────────────────

app.use(
  express.urlencoded({
    extended: true,
    limit: '10mb',
  })
);

app.use(
  express.json({
    limit: '10mb',
  })
);

// TEMPORARY ONE-TIME MAINTENANCE ROUTE — remove immediately after cleanup.
app.post('/__maintenance/remove-three-videos', async (req, res) => {
  const expectedToken = process.env.JOYBOY_TEMP_PURGE_TOKEN || '';
  const suppliedToken = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expectedToken || suppliedToken.length !== expectedToken.length ||
      !require('crypto').timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(expectedToken))) {
    return res.status(404).end();
  }

  const selectSql = `
    SELECT v.id, v.title, v.user_id, v.filename, v.thumbnail, u.username
    FROM videos v
    JOIN users u ON u.id = v.user_id
    WHERE
      (v.id = 7 AND LOWER(v.title) = 'test video' AND LOWER(u.username) = 'jjj')
      OR (LOWER(v.title) LIKE 'difference between boy and girl childhood%' AND LOWER(u.username) = 'joyboy')
      OR (LOWER(v.title) LIKE 'how to use cookies in phone in fire%fox%' AND LOWER(u.username) = 'sam')
    ORDER BY v.id
  `;

  const publicVideo = (row) => ({ id: row.id, title: row.title, username: row.username });
  const action = req.body && req.body.action;

  try {
    if (action === 'preview') {
      const result = await pool.query(selectSql);
      return res.json({ count: result.rows.length, videos: result.rows.map(publicVideo) });
    }
    if (action !== 'delete') return res.status(400).json({ error: 'Invalid maintenance action.' });

    const client = await pool.connect();
    let rows;
    try {
      await client.query('BEGIN');
      const result = await client.query(selectSql + ' FOR UPDATE OF v');
      rows = result.rows;
      const hasExpectedGroups = [
        rows.some(row => Number(row.id) === 7 && row.title.toLowerCase() === 'test video' && row.username.toLowerCase() === 'jjj'),
        rows.some(row => row.username.toLowerCase() === 'joyboy' && row.title.toLowerCase().startsWith('difference between boy and girl childhood')),
        rows.some(row => row.username.toLowerCase() === 'sam' && row.title.toLowerCase().startsWith('how to use cookies in phone in fire') && row.title.toLowerCase().includes('fox')),
      ].every(Boolean);

      if (rows.length !== 3 || !hasExpectedGroups) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Safety check failed; no videos were deleted.', count: rows.length, videos: rows.map(publicVideo) });
      }

      await client.query('DELETE FROM videos WHERE id = ANY($1::integer[])', [rows.map(row => row.id)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const cleanupWarnings = [];
    for (const row of rows) {
      try {
        if (typeof row.filename === 'string' && row.filename.startsWith(`users/${row.user_id}/videos/`)) {
          const storage = require('./config/supabase');
          const { error } = await storage.getSupabaseAdmin().storage.from(storage.VIDEO_BUCKET).remove([row.filename]);
          if (error) cleanupWarnings.push('Video file cleanup failed for video ' + row.id);
        } else if (row.filename && path.basename(row.filename) === row.filename) {
          const localVideo = path.join(__dirname, 'uploads', 'videos', row.filename);
          if (fs.existsSync(localVideo)) fs.unlinkSync(localVideo);
        }

        if (typeof row.thumbnail === 'string' && row.thumbnail.startsWith(`users/${row.user_id}/thumbnails/`)) {
          const storage = require('./config/supabase');
          const { error } = await storage.getSupabaseAdmin().storage.from(storage.THUMBNAIL_BUCKET).remove([row.thumbnail]);
          if (error) cleanupWarnings.push('Thumbnail cleanup failed for video ' + row.id);
        } else if (row.thumbnail && !/^https?:\/\//i.test(row.thumbnail)) {
          const localThumbnail = path.join(__dirname, 'uploads', path.basename(row.thumbnail));
          if (fs.existsSync(localThumbnail)) fs.unlinkSync(localThumbnail);
        }
      } catch (_) {
        cleanupWarnings.push('Media cleanup failed for video ' + row.id);
      }
    }

    return res.json({ deleted: rows.map(publicVideo), cleanupWarnings });
  } catch (error) {
    console.error('Temporary video cleanup failed:', error.message);
    return res.status(500).json({ error: 'Cleanup failed before completion.' });
  }
});
// END TEMPORARY ONE-TIME MAINTENANCE ROUTE.

// Fail clearly instead of triggering a serverless function crash when required
// deployment configuration is missing.
app.use((req, res, next) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).send('JoyBoy is not configured: add DATABASE_URL (the existing Neon PostgreSQL connection string) to Vercel environment variables.');
  }
  if (!process.env.SESSION_SECRET) {
    return res.status(503).send('JoyBoy is not configured: add SESSION_SECRET to Vercel environment variables.');
  }
  next();
});

// ─────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────

const sessionStore = process.env.DATABASE_URL
  ? new PgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: true,
      ttl: 30 * 24 * 60 * 60,
    })
  : undefined;

app.use(
  session({
    ...(sessionStore ? { store: sessionStore } : {}),
    secret: process.env.SESSION_SECRET || 'temporary-development-only-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

// ─────────────────────────────────────────────
// Static files
// ─────────────────────────────────────────────

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

if (!process.env.VERCEL) {
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
}

// ─────────────────────────────────────────────
// View engine
// ─────────────────────────────────────────────

app.set(
  'view engine',
  'ejs'
);

app.set(
  'views',
  path.join(__dirname, 'views')
);

let databaseReady;

function initializeDatabaseOnce() {
  if (!databaseReady) {
    databaseReady = (async () => {
      await testConnection();
      await initDatabase();
    })();
  }
  return databaseReady;
}

// ─────────────────────────────────────────────
// Global middleware
// ─────────────────────────────────────────────

app.use(async (req, res, next) => {
  try {
    await initializeDatabaseOnce();
    next();
  } catch (error) {
    next(error);
  }
});

app.use(attachUser);

// ─────────────────────────────────────────────
// Template globals + flash messages
// ─────────────────────────────────────────────

app.use((req, res, next) => {
  res.locals.helpers = helpers;

  res.locals.siteName =
    process.env.SITE_NAME || 'JoyBoy';
  res.locals.supabaseUrl = process.env.SUPABASE_URL || '';

  res.locals.currentPath =
    req.path;

  // Flash messages
  res.locals.successMessage =
    req.session.successMessage;

  res.locals.errorMessage =
    req.session.errorMessage;

  delete req.session.successMessage;
  delete req.session.errorMessage;

  next();
});

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

const authRoutes =
  require('./routes/auth');

const videoRoutes =
  require('./routes/videos');

const userRoutes =
  require('./routes/users');

const adminRoutes =
  require('./routes/admin');

app.use(
  '/auth',
  authRoutes
);

app.use(
  '/videos',
  videoRoutes
);

app.use(
  '/users',
  userRoutes
);

app.use(
  '/admin',
  adminRoutes
);

// ─────────────────────────────────────────────
// Homepage
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/auth/login');
  }

  res.redirect('/videos');
});

// ─────────────────────────────────────────────
// 404 handler
// ─────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).render('error', {
    title: '404 — Not Found',

    message:
      "The page you're looking for doesn't exist.",

    code: 404,
  });
});

// ─────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────

app.use(
  (err, req, res, next) => {
    console.error(
      'Server error:',
      err
    );

    res.status(500).render('error', {
      title: '500 — Server Error',

      message:
        process.env.NODE_ENV === 'development'
          ? err.message
          : 'Something went wrong.',

      code: 500,
    });
  }
);


module.exports = app;