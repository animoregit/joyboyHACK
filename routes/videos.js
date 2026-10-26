const express = require('express');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');

const { pool } = require('../config/database');
const { requireAuth, requireOwnerOrAdmin } = require('../middleware/auth');
const { videoUpload } = require('../middleware/upload');
const { generateThumbnail } = require('../utils/thumbnail');

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
// POST /videos/upload — Process upload
// ─────────────────────────────────────────────

router.post('/upload', requireAuth, (req, res) => {
  videoUpload.single('video')(req, res, async (err) => {

    if (err) {
      return res.render('videos/upload', {
        title: 'Upload Video',
        errors: [{ msg: err.message }],
      });
    }

    if (!req.file) {
      return res.render('videos/upload', {
        title: 'Upload Video',
        errors: [
          { msg: 'Please select a video file.' }
        ],
      });
    }

    const { title, description, visibility } = req.body;

    // ───────────────────────────────────────
    // Validate title
    // ───────────────────────────────────────

    if (!title || title.trim().length === 0) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      return res.render('videos/upload', {
        title: 'Upload Video',
        errors: [
          { msg: 'Video title is required.' }
        ],
      });
    }

    try {

      // ─────────────────────────────────────
      // Generate thumbnail
      // ─────────────────────────────────────

      const thumbnailFilename =
        path.basename(
          req.file.filename,
          path.extname(req.file.filename)
        ) + '.jpg';

      const {
        thumbnailPath,
        duration
      } = await generateThumbnail(
        req.file.path,
        thumbnailFilename
      );

      // ─────────────────────────────────────
      // Insert video into Neon
      // ─────────────────────────────────────

      const result = await pool.query(
        `
        INSERT INTO videos (
          title,
          description,
          filename,
          thumbnail,
          duration,
          file_size,
          mime_type,
          user_id,
          visibility
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9
        )
        RETURNING id
        `,
        [
          title.trim(),
          description ? description.trim() : null,
          req.file.filename,
          thumbnailPath,
          duration,
          req.file.size,
          req.file.mimetype,
          req.session.userId,
          visibility === 'private'
            ? 'private'
            : 'public',
        ]
      );

      const videoId = result.rows[0].id;

      req.session.successMessage =
        'Video uploaded successfully!';

      res.redirect(`/videos/${videoId}`);

    } catch (error) {

      console.error('Upload error:', error);

      // Clean up uploaded video
      if (
        req.file &&
        req.file.path &&
        fs.existsSync(req.file.path)
      ) {
        fs.unlinkSync(req.file.path);
      }

      res.render('videos/upload', {
        title: 'Upload Video',
        errors: [
          {
            msg: 'Failed to process video. Please try again.'
          }
        ],
      });
    }
  });
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

      // Delete local video file
      if (video.filename) {
        const videoPath = path.join(
          __dirname,
          '..',
          'uploads',
          'videos',
          video.filename
        );

        if (fs.existsSync(videoPath)) {
          fs.unlinkSync(videoPath);
        }
      }

      // Delete local thumbnail
      if (video.thumbnail) {
        const thumbnailPath = path.join(
          __dirname,
          '..',
          'uploads',
          video.thumbnail
        );

        if (fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }
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
// GET /videos/stream/:filename
// ─────────────────────────────────────────────

router.get(
  '/stream/:filename',
  requireAuth,
  async (req, res, next) => {
    try {
      const filename = path.basename(req.params.filename);
      const videoResult = await pool.query(
        `SELECT user_id, visibility, mime_type
         FROM videos
         WHERE filename = $1
         LIMIT 1`,
        [filename]
      );
      const video = videoResult.rows[0];
      if (!video) return res.status(404).send('Video file not found.');

      const currentUser = res.locals.currentUser;
      if (
        video.visibility === 'private' &&
        (!currentUser ||
          (String(video.user_id) !== String(currentUser.id) &&
           currentUser.role !== 'admin'))
      ) {
        return res.status(403).send('This video is private.');
      }

      const videoPath = path.join(__dirname, '..', 'uploads', 'videos', filename);
      if (!fs.existsSync(videoPath)) return res.status(404).send('Video file not found.');

      const stat = fs.statSync(videoPath);
      if (!stat.isFile()) return res.status(404).send('Video file not found.');

      const fileSize = stat.size;
      const contentType = video.mime_type || 'application/octet-stream';
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (!range) {
        res.setHeader('Content-Length', fileSize);
        return fs.createReadStream(videoPath).on('error', next).pipe(res);
      }

      const match = /^bytes=(\\d*)-(\\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.sendStatus(416);
      }

      let start;
      let end;
      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          return res.sendStatus(416);
        }
        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : fileSize - 1;
      }

      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= fileSize ||
        end < start
      ) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.sendStatus(416);
      }

      end = Math.min(end, fileSize - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(videoPath, { start, end }).on('error', next).pipe(res);
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;