// Vercel Node function entrypoint. Keep the import guarded so deployment
// startup errors become visible diagnostics rather than opaque invocation failures.
let app;
let startupError;

try {
  app = require('../server');
} catch (error) {
  startupError = error;
  console.error('JoyBoy startup error:', error && error.stack ? error.stack : error);
}

module.exports = function handler(req, res) {
  if (startupError) {
    console.error('JoyBoy could not initialize:', startupError.message);
    return res.status(500).send(`JoyBoy startup error: ${startupError.message || 'unknown startup failure'}`);
  }
  return app(req, res);
};
