const express = require('express');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegStatic);
const { execSync } = require('child_process');

const app = express();
app.use(express.json({ limit: '100mb' }));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Auth middleware
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/render', async (req, res) => {
  const jobId = uuidv4();
  const tmpDir = `/tmp/${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const { scenes, audio_url, audio_base64 } = req.body;
    console.log(`[${jobId}] Starting render with ${scenes.length} scenes`);

    // Download or decode audio
    const audioPath = path.join(tmpDir, 'audio.mp3');
    if (audio_base64) {
      const b64 = audio_base64.replace(/^data:audio\/\w+;base64,/, '');
      fs.writeFileSync(audioPath, Buffer.from(b64, 'base64'));
      console.log(`[${jobId}] Audio decoded from base64`);
    } else {
      const audioResponse = await axios.get(audio_url, { responseType: 'arraybuffer' });
      fs.writeFileSync(audioPath, audioResponse.data);
      console.log(`[${jobId}] Audio downloaded`);
    }

    // Process each scene
    const clipPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const imgPath = path.join(tmpDir, `img_${i}.jpg`);
      const clipPath = path.join(tmpDir, `clip_${i}.mp4`);

      // Save image (base64 or URL)
      if (scene.image_base64) {
        const base64Data = scene.image_base64.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
      } else {
        const imgResponse = await axios.get(scene.image_url, { responseType: 'arraybuffer' });
        fs.writeFileSync(imgPath, imgResponse.data);
      }

      const duration = scene.duration || 8;
      const zoomEnd = 1.08;

      // FFmpeg: Ken Burns zoom effect
      await new Promise((resolve, reject) => {
        ffmpeg(imgPath)
          .inputOptions(['-loop 1'])
          .videoFilters([
            `scale=1080:1920:force_original_aspect_ratio=increase`,
            `crop=1080:1920`,
            `zoompan=z='min(zoom+0.0009,${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${duration * 30}:s=1080x1920:fps=30`,
            i === 0 ? `fade=t=in:st=0:d=0.4` : `fade=t=in:st=0:d=0.4`,
            `fade=t=out:st=${duration - 0.4}:d=0.4`
          ])
          .outputOptions([
            `-t ${duration}`,
            '-c:v libx264',
            '-pix_fmt yuv420p',
            '-r 30'
          ])
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      clipPaths.push(clipPath);
      console.log(`[${jobId}] Scene ${i + 1}/${scenes.length} processed`);
    }

    // Create concat list
    const listPath = path.join(tmpDir, 'list.txt');
    const listContent = clipPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    // Concatenate clips
    const concatPath = path.join(tmpDir, 'concat.mp4');
    execSync(`"${ffmpegStatic}" -f concat -safe 0 -i "${listPath}" -c copy "${concatPath}"`);
    console.log(`[${jobId}] Clips concatenated`);

    // Mix audio with video
    const outputPath = path.join(tmpDir, 'final.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg(concatPath)
        .addInput(audioPath)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-shortest',
          '-af afade=t=out:st=50:d=5'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    console.log(`[${jobId}] Audio mixed`);

    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(outputPath, {
      resource_type: 'video',
      public_id: `tiktok_${jobId}`,
      folder: 'walter_studio'
    });
    console.log(`[${jobId}] Uploaded to Cloudinary: ${uploadResult.secure_url}`);

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

    res.json({
      success: true,
      video_url: uploadResult.secure_url,
      duration: uploadResult.duration,
      job_id: jobId
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: error.message, job_id: jobId });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
