const { IgApiClient } = require('instagram-private-api');
const axios = require('axios');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffprobeStatic = require('ffprobe-static');

// Set ffprobe path from ffprobe-static
ffmpeg.setFfprobePath(ffprobeStatic.path);

const MAX_UPLOADS = 15;
const HISTORY_FILE = path.resolve(__dirname, 'history.json');
const TEMP_VIDEO_PATH = path.resolve(__dirname, 'temp_video.mp4');
const TEMP_THUMBNAIL_PATH = path.resolve(__dirname, 'temp_thumbnail.jpg');
const SESSION_FILE_PATH = path.resolve(__dirname, 'ig_session.json');

function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  }
  return {};
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

async function downloadVideo(url, outputPath) {
  console.log(`Starting download from: ${url}`);
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', async () => {
      try {
        const stats = await fsp.stat(outputPath);
        console.log(`Download finished. File size: ${stats.size} bytes`);
        if (stats.size === 0) {
          reject(new Error('Downloaded video file is empty'));
        } else {
          resolve();
        }
      } catch (err) {
        reject(err);
      }
    });
    writer.on('error', reject);
  });
}

function generateThumbnail(videoPath, thumbnailPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on('end', () => {
        console.log('Thumbnail generated:', thumbnailPath);
        resolve();
      })
      .on('error', (err) => {
        reject(new Error(`Failed to generate thumbnail: ${err.message}`));
      })
      // Take a screenshot at 1 second into the video
      .screenshots({
        count: 1,
        folder: path.dirname(thumbnailPath),
        filename: path.basename(thumbnailPath),
        size: '640x?'
      });
  });
}

async function uploadVideo(ig, videoPath, caption) {
  // Generate thumbnail first
  await generateThumbnail(videoPath, TEMP_THUMBNAIL_PATH);

  // Read video and thumbnail files into buffers
  const videoBuffer = await fsp.readFile(videoPath);
  const thumbnailBuffer = await fsp.readFile(TEMP_THUMBNAIL_PATH);

  console.log(`Uploading video with thumbnail...`);

  const result = await ig.publish.video({
    video: videoBuffer,
    coverImage: thumbnailBuffer,
    caption,
  });

  return result;
}

async function saveSession(ig) {
  const serialized = await ig.state.serialize();
  await fsp.writeFile(SESSION_FILE_PATH, JSON.stringify(serialized, null, 2));
}

async function loadSession(ig) {
  if (!fs.existsSync(SESSION_FILE_PATH)) {
    return false;
  }
  const savedSession = JSON.parse(await fsp.readFile(SESSION_FILE_PATH, 'utf-8'));
  await ig.state.deserialize(savedSession);
  return true;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const jsonFilePath = path.resolve(__dirname, 'reelsData.json');
  if (!fs.existsSync(jsonFilePath)) {
    console.error('reelsData.json file not found!');
    process.exit(1);
  }
  const jsonData = JSON.parse(await fsp.readFile(jsonFilePath, 'utf-8'));

  const username = process.env.IG_USERNAME || '';
  const password = process.env.IG_PASSWORD || '';

  if (!username || !password) {
    console.error('Instagram username or password not set!');
    process.exit(1);
  }

  const ig = new IgApiClient();
  ig.state.generateDevice(username);

  const sessionLoaded = await loadSession(ig);
  if (sessionLoaded) {
    console.log('Session loaded from file.');
  } else {
    console.log('Logging in to Instagram...');
    await ig.account.login(username, password);
    console.log('Login successful.');
    await saveSession(ig);
    console.log('Session saved to file.');
  }

  const history = loadHistory();
  let uploadCount = 0;

  for (const postUrl in jsonData) {
    if (uploadCount >= MAX_UPLOADS) {
      console.log(`Reached max upload limit of ${MAX_UPLOADS}. Stopping.`);
      break;
    }

    if (history[postUrl]) {
      console.log(`Skipping already uploaded video: ${postUrl}`);
      continue;
    }

    const post = jsonData[postUrl];
    if (post.results_number > 0 && post.url_list.length > 0) {
      const videoUrl = post.url_list[0];
      const caption = post.post_info.caption || '';

      try {
        console.log(`Downloading video from ${videoUrl}`);
        await downloadVideo(videoUrl, TEMP_VIDEO_PATH);
        console.log('Download complete');

        console.log('Uploading video to Instagram...');
        const result = await uploadVideo(ig, TEMP_VIDEO_PATH, caption);
        console.log('Upload successful:', result);

        history[postUrl] = {
          uploadedAt: new Date().toISOString(),
          result,
          caption,
          videoUrl,
        };
        saveHistory(history);

        uploadCount++;

        // Optional delay to avoid rate limits (uncomment if needed)
        // console.log('Waiting 30 seconds before next upload...');
        // await delay(30000);

      } catch (err) {
        console.error(`Error processing video ${postUrl}:`, err);
      } finally {
        // Clean up temp files after upload completes
        for (const filePath of [TEMP_VIDEO_PATH, TEMP_THUMBNAIL_PATH]) {
          try {
            await fsp.unlink(filePath);
            console.log(`Deleted temporary file: ${filePath}`);
          } catch (err) {
            if (err.code !== 'ENOENT') {
              console.error(`Error deleting temp file ${filePath}:`, err);
            }
          }
        }
      }
    } else {
      console.log(`No video found for post: ${postUrl}`);
    }
  }

  console.log(`Finished uploading ${uploadCount} videos.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
