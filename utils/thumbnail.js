const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobe = require('ffprobe-static');
const path = require('path');
const fs = require('fs');

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobe && ffprobe.path) ffmpeg.setFfprobePath(ffprobe.path);

/**
 * Generate a thumbnail from an uploaded video.
 * FFmpeg and FFprobe binaries are bundled as npm dependencies so this works
 * on Render without relying on system-installed executables.
 */
async function generateThumbnail(videoPath, thumbnailFilename) {
  const thumbnailDir = path.join(__dirname, '..', 'uploads', 'thumbnails');
  const thumbnailPath = path.join(thumbnailDir, path.basename(thumbnailFilename));

  await fs.promises.mkdir(thumbnailDir, { recursive: true });

  const duration = await getVideoDuration(videoPath);
  if (duration === null) {
    console.warn('Thumbnail skipped: video duration could not be read.');
    return { thumbnailPath: null, duration: null };
  }

  // Seek slightly into the video; 0 seconds can be a black/empty frame.
  const seekTime = Math.min(Math.max(duration * 0.1, 0.1), Math.max(duration - 0.1, 0));

  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .seekInput(seekTime)
      .frames(1)
      .outputOptions(['-y'])
      .size('640x360')
      .output(thumbnailPath)
      .on('end', async () => {
        try {
          const stat = await fs.promises.stat(thumbnailPath);
          if (!stat.isFile() || stat.size === 0) {
            return resolve({ thumbnailPath: null, duration });
          }
          resolve({
            thumbnailPath: `thumbnails/${path.basename(thumbnailFilename)}`,
            duration,
          });
        } catch {
          resolve({ thumbnailPath: null, duration });
        }
      })
      .on('error', (error) => {
        console.error('Thumbnail generation failed:', error.message);
        resolve({ thumbnailPath: null, duration });
      })
      .run();
  });
}

function getVideoDuration(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (error, metadata) => {
      if (error) {
        console.error('FFprobe failed:', error.message);
        return resolve(null);
      }
      const duration = Number(metadata?.format?.duration);
      resolve(Number.isFinite(duration) && duration >= 0 ? duration : null);
    });
  });
}

module.exports = { generateThumbnail, getVideoDuration };
