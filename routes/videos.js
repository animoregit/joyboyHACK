const express = require('express');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const { randomUUID } = require('crypto');

const { pool } = require('../config/database');
const { requireAuth, requireOwnerOrAdmin } = require('../middleware/auth');
const {
  getSupabaseAdmin,
  isUserStoragePath,
  VIDEO_BUCKET,
  THUMBNAIL_BUCKET,
} = require('../config/supabase');

const router = express.Router();

// ─────────────────────────────────────────────
// GET /videos — Homepage feed
// ─────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 12;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  try {
    let videosResult;
    let countResult;

    if (search) {
      const searchPattern = `%${search}%`;

      videosResult = await pool.query(
        `
        SELECT v.*, u.username, u.avatar
        FROM videos v
        JOIN users u ON v.user_id = u.id
        WHERE v.visibility = 'public'
          AND (
            v.title ILIKE $1
            OR v.description ILIKE $2
          )
        ORDER BY v.created_at DESC
        LIMIT $3 OFFSET $4
        `,
        [searchPattern, searchPattern, limit, offset]
      );

      countResult = await pool.query(
        `
        SELECT COUNT(*)::integer AS count
        FROM videos
        WHERE visibility = 'public'
          AND (
            title ILIKE $1
            OR description ILIKE $2
          )
        `,
        [searchPattern, searchPattern]
      );
    } else {
      videosResult = await pool.query(
        `
        SELECT v.*, u.username, u.avatar
        FROM videos v
        JOIN users u ON v.user_id = u.id
        WHERE v.visibility = 'public'
        ORDER BY v.created_at DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      );

      countResult = await pool.query(
        `
        SELECT COUNT(*)::integer AS count
        FROM videos
        WHERE visibility = 'public'
        `
      );
    }

    const videos = videosResult.rows;
    const totalCount = countResult.rows[0].count;
    const totalPages = Math.ceil(totalCount / limit);

    res.render('home', {
      title: 'Home',
      videos,
      currentPage: page,
      totalPages,
      search,
    });

  } catch (error) {
    console.error('Videos feed error:', error);

    res.status(500).render('error', {
      title: '500 — Server Error',
      message: 'Something went wrong while loading videos.',
      code: 500,
    });
  }
});

// ─────────────────────────────────────────────
// GET /videos/upload — Upload form
// ─────────────────────────────────────────────

router.get('/upload', requireAuth, (req, res) => {
  res.render('videos/upload', {
    title: 'Upload Video',
    errors: [],
  });
});

// ─────────────────────────────────────────────
// POST /videos/upload/sign — Create one-use upload URL
// ─────────────────────────────────────────────

router.post('/upload/sign', requireAuth, async (req, res) => {
  try {
    const { kind, filename, mimeType, size } = req.body || {};
    const byteSize = Number(size);
    const ext = path.extname(String(filename || '')).toLowerCase();

    // Limit uploads to formats with broad native browser playback support.
    // We no longer transcode on the serverless upload path.
    const videoTypes = new Set(['video/mp4', 'video/webm']);
    const videoExtensions = new Set(['.mp4', '.webm']);
    const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const isThumbnail = kind === 'thumbnail';
    const maxSize = isThumbnail ? 5 * 1024 * 1024 : 50 * 1024 * 1024;

    if (!['video', 'thumbnail'].includes(kind)) {
      return res.status(400).json({ error: 'Invalid upload type.' });
    }
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > maxSize) {
      return res.status(413).json({
        error: isThumbnail ? 'Thumbnail must be smaller than 5 MB.' : 'Video uploads are limited to 50 MB on the current storage plan.',
      });
    }
    if (isThumbnail ? (!imageTypes.has(mimeType) || ext !== '.jpg') : (!videoTypes.has(mimeType) || !videoExtensions.has(ext))) {
      return res.status(415).json({ error: isThumbnail ? 'Unsupported thumbnail format.' : 'Use an MP4 or WebM video for reliable browser playback.' });
    }

    const bucket = isThumbnail ? THUMBNAIL_BUCKET : VIDEO_BUCKET;
    const folder = isThumbnail ? 'thumbnails' : 'videos';
    const objectPath = `users/${req.session.userId}/${folder}/${randomUUID()}${ext}`;
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(objectPath);

    if (error || !data?.token) {
      console.error('Supabase signed-upload URL error:', error?.message || 'No upload token returned');
      return res.status(502).json({ error: 'Could not prepare a secure upload. Please try again.' });
    }

    const signedUrl = data.signedUrl && /^https?:\/\//i.test(data.signedUrl)
      ? data.signedUrl
      : `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/upload/sign/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(data.token)}`;

    return res.json({
      path: objectPath,
      signedUrl,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
    });
  } catch (error) {
    if (error.code === 'SUPABASE_STORAGE_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Media storage is temporarily unavailable. Please try again later.' });
    }
    console.error('Create video upload URL error:', error);
    return res.status(500).json({ error: 'Could not prepare the upload.' });
  }
});

// ─────────────────────────────────────────────
// POST /videos/upload/complete — Save uploaded media metadata
// ─────────────────────────────────────────────

router.post('/upload/complete', requireAuth, async (req, res) => {
  const { title, description, visibility, videoPath, thumbnailPath, duration, fileSize, mimeType } = req.body || {};
  const userId = req.session.userId;

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Video title is required.' });
  }
  if (!isUserStoragePath(videoPath, userId) || !videoPath.includes('/videos/')) {
    return res.status(400).json({ error: 'Invalid video storage path.' });
  }
  if (thumbnailPath && (!isUserStoragePath(thumbnailPath, userId) || !thumbnailPath.includes('/thumbnails/'))) {
    return res.status(400).json({ error: 'Invalid thumbnail storage path.' });
  }
  const byteSize = Number(fileSize);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > 50 * 1024 * 1024) {
    return res.status(400).json({ error: 'Invalid video size.' });
  }
  const allowedMimeTypes = new Set(['video/mp4', 'video/webm']);
  if (!allowedMimeTypes.has(mimeType)) {
    return res.status(415).json({ error: 'Unsupported video format.' });
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data: signedCheck, error: signedError } = await supabase.storage
      .from(VIDEO_BUCKET).createSignedUrl(videoPath, 60);
    if (signedError || !signedCheck?.signedUrl) {
      return res.status(400).json({ error: 'Uploaded video was not found in storage. Please retry the upload.' });
    }

    if (thumbnailPath) {
      const { data: thumbCheck, error: thumbError } = await supabase.storage
        .from(THUMBNAIL_BUCKET).createSignedUrl(thumbnailPath, 60);
      if (thumbError || !thumbCheck?.signedUrl) {
        console.warn('Uploaded thumbnail could not be verified; saving video without a thumbnail.');
      }
    }

    const cleanDuration = Number(duration);
    const result = await pool.query(
      `INSERT INTO videos (
        title, description, filename, thumbnail, duration, file_size,
        mime_type, user_id, visibility
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        title.trim().slice(0, 200),
        typeof description === 'string' ? description.trim().slice(0, 5000) || null : null,
        videoPath,
        thumbnailPath || null,
        Number.isFinite(cleanDuration) && cleanDuration >= 0 ? cleanDuration : null,
        byteSize,
        mimeType,
        userId,
        visibility === 'private' ? 'private' : 'public',
      ]
    );

    req.session.successMessage = 'Video uploaded successfully!';
    return res.status(201).json({ videoId: result.rows[0].id, redirectUrl: `/videos/${result.rows[0].id}` });
  } catch (error) {
    if (error.code === 'SUPABASE_STORAGE_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Media storage is temporarily unavailable. Please try again later.' });
    }
    console.error('Finalize video upload error:', error);
    return res.status(500).json({ error: 'Upload completed, but saving video details failed. Please contact the site admin before retrying.' });
  }
});

// ─────────────────────────────────────────────
// GET /videos/:id — Watch video
// ─────────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
  const videoId = parseInt(req.params.id, 10);

  if (Number.isNaN(videoId)) {
    return res.status(404).render('error', {
      title: '404',
      message: 'Video not found.',
      code: 404,
    });
  }

  try {

    const videoResult = await pool.query(
      `
      SELECT
        v.*,
        u.username,
        u.avatar,
        u.id AS uploader_id
      FROM videos v
      JOIN users u ON v.user_id = u.id
      WHERE v.id = $1
      `,
      [videoId]
    );

    const video = videoResult.rows[0];

    if (!video) {
      return res.status(404).render('error', {
        title: '404',
        message: 'Video not found.',
        code: 404,
      });
    }

    // ─────────────────────────────────────
    // Check visibility
    // ─────────────────────────────────────

    const currentUser = res.locals.currentUser;

    if (
      video.visibility === 'private' &&
      video.user_id !== currentUser.id &&
      currentUser.role !== 'admin'
    ) {
      return res.status(403).render('error', {
        title: '403',
        message: 'This video is private.',
        code: 403,
      });
    }

    // ─────────────────────────────────────
    // Increment views
    // ─────────────────────────────────────

    await pool.query(
      `
      UPDATE videos
      SET views = views + 1
      WHERE id = $1
      `,
      [videoId]
    );

    video.views += 1;

    // ─────────────────────────────────────
    // More videos from uploader
    // ─────────────────────────────────────

    const moreResult = await pool.query(
      `
      SELECT v.*, u.username
      FROM videos v
      JOIN users u ON v.user_id = u.id
      WHERE v.user_id = $1
        AND v.id != $2
        AND v.visibility = 'public'
      ORDER BY v.created_at DESC
      LIMIT 6
      `,
      [video.user_id, videoId]
    );

    const moreFromUploader = moreResult.rows;

    res.render('videos/watch', {
      title: video.title,
      video,
      moreFromUploader,
      isOwner: currentUser.id === video.user_id,
      isAdmin: currentUser.role === 'admin',
    });

  } catch (error) {

    console.error('Watch video error:', error);

    res.status(500).render('error', {
      title: '500 — Server Error',
      message: 'Something went wrong while loading the video.',
      code: 500,
    });
  }
});

// ─────────────────────────────────────────────
// GET /videos/:id/edit
// ─────────────────────────────────────────────

router.get(
  '/:id/edit',
  requireAuth,
  requireOwnerOrAdmin('video'),
  async (req, res) => {

    const videoId = parseInt(req.params.id, 10);

    try {

      const result = await pool.query(
        `
        SELECT *
        FROM videos
        WHERE id = $1
        `,
        [videoId]
      );

      const video = result.rows[0];

      if (!video) {
        return res.status(404).render('error', {
          title: '404',
          message: 'Video not found.',
          code: 404,
        });
      }

      res.render('videos/edit', {
        title: `Edit: ${video.title}`,
        video,
        errors: [],
      });

    } catch (error) {

      console.error('Edit video error:', error);

      res.status(500).render('error', {
        title: '500 — Server Error',
        message: 'Something went wrong.',
        code: 500,
      });
    }
  }
);

// ─────────────────────────────────────────────
// POST /videos/:id/edit
// ─────────────────────────────────────────────

router.post(
  '/:id/edit',
  requireAuth,
  requireOwnerOrAdmin('video'),

  [
    body('title')
      .trim()
      .notEmpty()
      .withMessage('Title is required.'),
  ],

  async (req, res) => {

    const videoId = parseInt(req.params.id, 10);
    const errors = validationResult(req);

    try {

      const result = await pool.query(
        `
        SELECT *
        FROM videos
        WHERE id = $1
        `,
        [videoId]
      );

      const video = result.rows[0];

      if (!video) {
        return res.status(404).render('error', {
          title: '404',
          message: 'Video not found.',
          code: 404,
        });
      }

      if (!errors.isEmpty()) {
        return res.render('videos/edit', {
          title: `Edit: ${video.title}`,
          video,
          errors: errors.array(),
        });
      }

      const {
        title,
        description,
        visibility
      } = req.body;

      await pool.query(
        `
        UPDATE videos
        SET
          title = $1,
          description = $2,
          visibility = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        `,
        [
          title.trim(),
          description
            ? description.trim()
            : null,
          visibility === 'private'
            ? 'private'
            : 'public',
          videoId,
        ]
      );

      req.session.successMessage =
        'Video updated successfully!';

      res.redirect(`/videos/${videoId}`);

    } catch (error) {

      console.error('Update video error:', error);

      res.status(500).render('error', {
        title: '500 — Server Error',
        message: 'Something went wrong while updating the video.',
        code: 500,
      });
    }
  }
);

// ─────────────────────────────────────────────
// POST /videos/:id/delete
// ─────────────────────────────────────────────

router.post(
  '/:id/delete',
  requireAuth,
  requireOwnerOrAdmin('video'),
  async (req, res) => {

    const videoId = parseInt(req.params.id, 10);

    try {

      const result = await pool.query(
        `
        SELECT *
        FROM videos
        WHERE id = $1
        `,
        [videoId]
      );

      const video = result.rows[0];

      if (!video) {
        return res.status(404).render('error', {
          title: '404',
          message: 'Video not found.',
          code: 404,
        });
      }

      // Delete persistent cloud objects, or clean up legacy local files.
      if (video.filename && String(video.filename).startsWith(`users/${video.user_id}/videos/`)) {
        const supabase = getSupabaseAdmin();
        const { error } = await supabase.storage.from(VIDEO_BUCKET).remove([video.filename]);
        if (error) throw error;
      } else if (video.filename && path.basename(video.filename) === video.filename) {
        const localVideo = path.join(__dirname, '..', 'uploads', 'videos', video.filename);
        if (fs.existsSync(localVideo)) fs.unlinkSync(localVideo);
      }

      if (video.thumbnail && String(video.thumbnail).startsWith(`users/${video.user_id}/thumbnails/`)) {
        const supabase = getSupabaseAdmin();
        const { error } = await supabase.storage.from(THUMBNAIL_BUCKET).remove([video.thumbnail]);
        if (error) console.warn('Thumbnail cleanup failed:', error.message);
      } else if (video.thumbnail && !/^https?:\/\//i.test(video.thumbnail)) {
        const localThumbnail = path.join(__dirname, '..', 'uploads', path.basename(video.thumbnail));
        if (fs.existsSync(localThumbnail)) fs.unlinkSync(localThumbnail);
      }

      // Delete database record
      await pool.query(
        'DELETE FROM videos WHERE id = $1',
        [videoId]
      );

      req.session.successMessage =
        'Video deleted successfully.';

      res.redirect('/videos');

    } catch (error) {

      console.error('Delete video error:', error);

      res.status(500).render('error', {
        title: '500 — Server Error',
        message: 'Something went wrong while deleting the video.',
        code: 500,
      });
    }
  }
);

// ─────────────────────────────────────────────
// GET /videos/stream/:id — Securely stream stored media
// ─────────────────────────────────────────────

router.get('/stream/:id', requireAuth, async (req, res, next) => {
  const videoId = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(videoId) || videoId <= 0) {
    return res.status(404).send('Video not found.');
  }

  try {
    const result = await pool.query('SELECT id, user_id, filename, mime_type, visibility FROM videos WHERE id = $1 LIMIT 1', [videoId]);
    const video = result.rows[0];
    if (!video) return res.status(404).send('Video not found.');

    const currentUser = res.locals.currentUser;
    if (
      video.visibility === 'private' &&
      (!currentUser ||
        String(video.user_id) !== String(currentUser.id) &&
        currentUser.role !== 'admin')
    ) {
      return res.status(403).send('This video is private.');
    }

    // New uploads use private Supabase Storage objects. Signed URLs let the
    // browser perform range requests directly against Supabase, avoiding the
    // Vercel serverless response-size limit.
    if (typeof video.filename === 'string' && video.filename.startsWith(`users/${video.user_id}/videos/`)) {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.storage.from(VIDEO_BUCKET).createSignedUrl(video.filename, 60 * 60);
      if (error || !data?.signedUrl) {
        console.error('Could not sign video URL:', error?.message || 'No signed URL returned');
        return res.status(502).send('Video storage is temporarily unavailable.');
      }
      return res.redirect(302, data.signedUrl);
    }

    // Compatibility for old public videos whose files still exist on the old
    // host. Private legacy files are never redirected to public static storage.
    const legacyBase = (process.env.LEGACY_MEDIA_BASE_URL || '').replace(/\/$/, '');
    if (video.visibility === 'public' && legacyBase && video.filename && path.basename(video.filename) === video.filename) {
      return res.redirect(302, `${legacyBase}/uploads/videos/${encodeURIComponent(video.filename)}`);
    }
    return res.status(410).send('This older video file is not in persistent storage yet.');
  } catch (error) {
    if (error.code === 'SUPABASE_STORAGE_NOT_CONFIGURED') {
      return res.status(503).send('Supabase Storage is not configured yet.');
    }
    return next(error);
  }
});
module.exports = router;