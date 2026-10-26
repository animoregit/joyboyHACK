const express = require('express');
const { randomUUID } = require('crypto');
const path = require('path');
const { body, validationResult } = require('express-validator');

const { pool } = require('../config/database');

const { requireAuth, requireOwnerOrAdmin } = require('../middleware/auth');
const { getSupabaseAdmin, isUserStoragePath, AVATAR_BUCKET } = require('../config/supabase');

const router = express.Router();

// ─────────────────────────────────────────────
// GET /users/:id — User profile
// ─────────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
  const userId = parseInt(req.params.id, 10);

  if (Number.isNaN(userId)) {
    return res.status(404).render('error', {
      title: '404',
      message: 'User not found.',
      code: 404,
    });
  }

  try {
    const userResult = await pool.query(
      `
      SELECT
        id,
        username,
        email,
        avatar,
        bio,
        role,
        created_at
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).render('error', {
        title: '404',
        message: 'User not found.',
        code: 404,
      });
    }

    const currentUser = res.locals.currentUser;

    const isOwner = currentUser.id === user.id;
    const isAdmin = currentUser.role === 'admin';

    // ───────────────────────────────────────
    // Get user's videos
    // ───────────────────────────────────────

    let videosResult;

    if (isOwner || isAdmin) {
      videosResult = await pool.query(
        `
        SELECT *
        FROM videos
        WHERE user_id = $1
        ORDER BY created_at DESC
        `,
        [userId]
      );
    } else {
      videosResult = await pool.query(
        `
        SELECT *
        FROM videos
        WHERE user_id = $1
          AND visibility = 'public'
        ORDER BY created_at DESC
        `,
        [userId]
      );
    }

    const videos = videosResult.rows;

    // ───────────────────────────────────────
    // Total views
    // ───────────────────────────────────────

    const viewsResult = await pool.query(
      `
      SELECT COALESCE(SUM(views), 0)::bigint AS total
      FROM videos
      WHERE user_id = $1
      `,
      [userId]
    );

    const totalViews = Number(viewsResult.rows[0].total);

    res.render('users/profile', {
      title: `${user.username}'s Profile`,
      profileUser: user,
      videos,
      totalViews,
      isOwner,
      isAdmin,
    });

  } catch (err) {
    console.error('Profile error:', err);

    return res.status(500).render('error', {
      title: '500 — Server Error',
      message: 'Something went wrong while loading the profile.',
      code: 500,
    });
  }
});

// ─────────────────────────────────────────────
// GET /users/:id/edit — Edit profile form
// ─────────────────────────────────────────────

router.get(
  '/:id/edit',
  requireAuth,
  requireOwnerOrAdmin('user'),
  async (req, res) => {
    const userId = parseInt(req.params.id, 10);

    try {
      const result = await pool.query(
        `
        SELECT
          id,
          username,
          email,
          avatar,
          bio,
          role,
          created_at
        FROM users
        WHERE id = $1
        `,
        [userId]
      );

      const user = result.rows[0];

      if (!user) {
        return res.status(404).render('error', {
          title: '404',
          message: 'User not found.',
          code: 404,
        });
      }

      res.render('users/edit', {
        title: 'Edit Profile',
        profileUser: user,
        errors: [],
      });

    } catch (err) {
      console.error('Edit profile error:', err);

      return res.status(500).render('error', {
        title: '500 — Server Error',
        message: 'Something went wrong.',
        code: 500,
      });
    }
  }
);

// ─────────────────────────────────────────────
// POST /users/:id/avatar-sign — Create signed avatar upload URL
// ─────────────────────────────────────────────

router.post(
  '/:id/avatar-sign',
  requireAuth,
  requireOwnerOrAdmin('user'),
  async (req, res) => {
    const userId = Number.parseInt(req.params.id, 10);
    const { filename, mimeType, size } = req.body || {};
    const byteSize = Number(size);
    const ext = path.extname(String(filename || '')).toLowerCase();
    const allowed = new Map([
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.png', 'image/png'],
      ['.webp', 'image/webp'],
      ['.gif', 'image/gif'],
    ]);

    if (byteSize <= 0 || byteSize > 5 * 1024 * 1024 || !Number.isSafeInteger(byteSize)) {
      return res.status(413).json({ error: 'Avatar images must be smaller than 5 MB.' });
    }
    if (!allowed.has(ext) || allowed.get(ext) !== mimeType) {
      return res.status(415).json({ error: 'Unsupported avatar format.' });
    }

    try {
      const objectPath = `users/${req.session.userId}/avatars/${randomUUID()}${ext}`;
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.storage.from(AVATAR_BUCKET).createSignedUploadUrl(objectPath);
      if (error || !data?.token) {
        console.error('Supabase avatar upload URL error:', error?.message || 'No token returned');
        return res.status(502).json({ error: 'Could not prepare avatar upload.' });
      }

      const signedUrl = data.signedUrl && /^https?:\/\//i.test(data.signedUrl)
        ? data.signedUrl
        : `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/upload/sign/${AVATAR_BUCKET}/${objectPath.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(data.token)}`;
      return res.json({
        path: objectPath,
        signedUrl,
        publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
      });
    } catch (error) {
      if (error.code === 'SUPABASE_STORAGE_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'Media storage is temporarily unavailable. Please try again later.' });
      }
      console.error('Create avatar upload URL error:', error);
      return res.status(500).json({ error: 'Could not prepare avatar upload.' });
    }
  }
);

// ─────────────────────────────────────────────
// POST /users/:id/edit — Process profile edit
// ─────────────────────────────────────────────

router.post(
  '/:id/edit',
  requireAuth,
  requireOwnerOrAdmin('user'),
  async (req, res) => {
    const userId = Number.parseInt(req.params.id, 10);

    try {
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      const user = userResult.rows[0];
      if (!user) {
        return res.status(404).render('error', {
          title: '404',
          message: 'User not found.',
          code: 404,
        });
      }

      const { username, bio } = req.body;
      if (typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 30 || !/^[a-zA-Z0-9_-]+$/.test(username.trim())) {
        return res.render('users/edit', {
          title: 'Edit Profile',
          profileUser: user,
          errors: [{ msg: 'Username must be 3–30 characters and contain only letters, numbers, hyphens, and underscores.' }],
        });
      }

      const cleanUsername = username.trim();
      const existing = await pool.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2 LIMIT 1',
        [cleanUsername, userId]
      );
      if (existing.rows.length) {
        return res.render('users/edit', {
          title: 'Edit Profile',
          profileUser: user,
          errors: [{ msg: 'Username is already taken.' }],
        });
      }

      let avatarPath = user.avatar;
      const requestedAvatarPath = req.body.avatarPath;
      if (requestedAvatarPath) {
        if (!isUserStoragePath(requestedAvatarPath, req.session.userId) || !requestedAvatarPath.includes('/avatars/')) {
          return res.status(400).render('users/edit', {
            title: 'Edit Profile',
            profileUser: user,
            errors: [{ msg: 'Invalid avatar upload. Please try again.' }],
          });
        }
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.storage.from(AVATAR_BUCKET).createSignedUrl(requestedAvatarPath, 60);
        if (error || !data?.signedUrl) {
          return res.status(400).render('users/edit', {
            title: 'Edit Profile',
            profileUser: user,
            errors: [{ msg: 'Avatar was not found in storage. Please upload it again.' }],
          });
        }
        avatarPath = requestedAvatarPath;
      }

      await pool.query(
        `UPDATE users
         SET username = $1, bio = $2, avatar = $3
         WHERE id = $4`,
        [cleanUsername, typeof bio === 'string' ? bio.trim().slice(0, 500) || null : null, avatarPath, userId]
      );

      if (user.avatar && user.avatar !== avatarPath && String(user.avatar).startsWith(`users/${req.session.userId}/avatars/`)) {
        try {
          const supabase = getSupabaseAdmin();
          await supabase.storage.from(AVATAR_BUCKET).remove([user.avatar]);
        } catch (cleanupError) {
          console.warn('Old avatar cleanup failed:', cleanupError.message);
        }
      }

      req.session.successMessage = 'Profile updated successfully!';
      return res.redirect(`/users/${userId}`);
    } catch (error) {
      console.error('Profile update error:', error);
      if (error.code === '23505') {
        return res.status(400).render('users/edit', {
          title: 'Edit Profile',
          profileUser: { ...req.body, id: userId },
          errors: [{ msg: 'Username is already taken.' }],
        });
      }
      if (error.code === 'SUPABASE_STORAGE_NOT_CONFIGURED') {
        return res.status(503).render('error', {
          title: '503 — Storage Not Configured',
          message: 'Add SUPABASE_SERVICE_ROLE_KEY to the Vercel project environment variables.',
          code: 503,
        });
      }
      return res.status(500).render('error', {
        title: '500 — Server Error',
        message: 'Something went wrong while updating the profile.',
        code: 500,
      });
    }
  }
);

module.exports = router;