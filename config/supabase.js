const { createClient } = require('@supabase/supabase-js');

const VIDEO_BUCKET = 'joyboy-videos';
const THUMBNAIL_BUCKET = 'joyboy-thumbnails';
const AVATAR_BUCKET = 'joyboy-avatars';

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    const missing = [
      !url && 'SUPABASE_URL',
      !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean);
    const error = new Error(`Supabase Storage is not configured: missing ${missing.join(', ')}.`);
    error.code = 'SUPABASE_STORAGE_NOT_CONFIGURED';
    throw error;
  }

  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

function isUserStoragePath(value, userId) {
  return typeof value === 'string' &&
    value.startsWith(`users/${userId}/`) &&
    !value.includes('..') &&
    !value.startsWith('/');
}

module.exports = {
  getSupabaseAdmin,
  isUserStoragePath,
  VIDEO_BUCKET,
  THUMBNAIL_BUCKET,
  AVATAR_BUCKET,
};
