// Supabase Storage is accessed through a locked-down Edge Function.
// Keep the Supabase secret/service-role key inside Supabase; this app only
// holds an application-to-gateway secret and never receives a privileged key.

const VIDEO_BUCKET = 'joyboy-videos';
const THUMBNAIL_BUCKET = 'joyboy-thumbnails';
const AVATAR_BUCKET = 'joyboy-avatars';
const ALLOWED_BUCKETS = new Set([VIDEO_BUCKET, THUMBNAIL_BUCKET, AVATAR_BUCKET]);

function storageNotConfigured() {
  const error = new Error(
    'Supabase Storage is not configured. Add SUPABASE_URL and JOYBOY_STORAGE_GATEWAY_SECRET to the server environment.'
  );
  error.code = 'SUPABASE_STORAGE_NOT_CONFIGURED';
  return error;
}

function isUserStoragePath(value, userId) {
  return typeof value === 'string' &&
    value.startsWith(`users/${userId}/`) &&
    !value.includes('..') &&
    !value.startsWith('/') &&
    !value.includes('\\\\');
}

async function callStorageGateway(action, payload) {
  const baseUrl = process.env.SUPABASE_URL;
  const gatewaySecret = process.env.JOYBOY_STORAGE_GATEWAY_SECRET;
  if (!baseUrl || !gatewaySecret) throw storageNotConfigured();

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/functions/v1/joyboy-media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-joyboy-storage-secret': gatewaySecret,
      },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (_) {
    return { data: null, error: { message: 'Could not reach the Supabase Storage gateway.' } };
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      data: null,
      error: {
        message: typeof result.error === 'string' ? result.error : 'Supabase Storage operation failed.',
        status: response.status,
        code: result.code || 'SUPABASE_STORAGE_GATEWAY_ERROR',
      },
    };
  }

  return result;
}

function getSupabaseAdmin() {
  if (!process.env.SUPABASE_URL || !process.env.JOYBOY_STORAGE_GATEWAY_SECRET) {
    throw storageNotConfigured();
  }

  return {
    storage: {
      from(bucket) {
        if (!ALLOWED_BUCKETS.has(bucket)) {
          throw new Error('Unsupported Supabase Storage bucket.');
        }
        return {
          createSignedUploadUrl(path, options = {}) {
            return callStorageGateway('create-upload-url', {
              bucket,
              path,
              upsert: options.upsert === true,
            });
          },
          createSignedUrl(path, expiresIn = 3600) {
            return callStorageGateway('create-signed-url', {
              bucket,
              path,
              expiresIn,
            });
          },
          remove(paths) {
            return callStorageGateway('remove-objects', {
              bucket,
              paths: Array.isArray(paths) ? paths : [],
            });
          },
        };
      },
    },
  };
}

module.exports = {
  getSupabaseAdmin,
  isUserStoragePath,
  VIDEO_BUCKET,
  THUMBNAIL_BUCKET,
  AVATAR_BUCKET,
};
