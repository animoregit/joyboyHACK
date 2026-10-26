/**
 * Format duration in seconds to MM:SS or HH:MM:SS
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';

  const s = Math.floor(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format file size in bytes to human readable
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);

  return `${size} ${units[i]}`;
}

/**
 * Human-readable "time ago" from a date string or Date object
 */
function timeAgo(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
  if (diffWeek < 5) return `${diffWeek} week${diffWeek !== 1 ? 's' : ''} ago`;
  if (diffMonth < 12) return `${diffMonth} month${diffMonth !== 1 ? 's' : ''} ago`;
  return `${diffYear} year${diffYear !== 1 ? 's' : ''} ago`;
}

/**
 * Truncate text to maxLength characters, appending "…"
 */
function truncate(str, maxLength = 100) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength).trimEnd() + '…';
}

/**
 * Format view count (1200 → 1.2K, 1500000 → 1.5M)
 */
function formatViews(count) {
  if (!count || count === 0) return '0 views';
  if (count === 1) return '1 view';
  if (count < 1000) return `${count} views`;
  if (count < 1000000) return `${(count / 1000).toFixed(1)}K views`;
  return `${(count / 1000000).toFixed(1)}M views`;
}

/**
 * Escape HTML entities
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function publicStorageUrl(bucket, key, legacyPath) {
  if (!key) return '';
  if (/^https?:\\/\\//i.test(key)) return key;

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\\/$/, '');
  const legacyBase = (process.env.LEGACY_MEDIA_BASE_URL || '').replace(/\\/$/, '');
  const pathParts = String(key).split('/').filter(Boolean).map(encodeURIComponent);

  if (String(key).startsWith('users/') && supabaseUrl) {
    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${pathParts.join('/')}`;
  }

  if (legacyBase) {
    return `${legacyBase}/uploads/${legacyPath || pathParts.join('/')}`;
  }

  return `/uploads/${legacyPath || pathParts.join('/')}`;
}

function thumbnailUrl(key) {
  return publicStorageUrl('joyboy-thumbnails', key, key);
}

function avatarUrl(key) {
  if (key && String(key).startsWith('users/')) {
    return publicStorageUrl('joyboy-avatars', key, key);
  }
  return publicStorageUrl('joyboy-avatars', key, `avatars/${key}`);
}

module.exports = {
  formatDuration,
  formatFileSize,
  timeAgo,
  truncate,
  formatViews,
  escapeHtml,
  thumbnailUrl,
  avatarUrl,
};
