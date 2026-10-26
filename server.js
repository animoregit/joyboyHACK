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

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in the deployment environment.');
}

const app = express();

// ─────────────────────────────────────────────
// Render runs behind a proxy
// ─────────────────────────────────────────────

app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

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

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────

async function startServer() {
  try {
    await initializeDatabaseOnce();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`JoyBoy is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module && !process.env.VERCEL) {
  startServer();
}

module.exports = app;