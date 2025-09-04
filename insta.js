const { IgApiClient } = require('instagram-private-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const MAX_UPLOADS = 15;
const HISTORY_FILE = path.resolve(__dirname, 'history.json');
const TEMP_VIDEO_PATH = path.resolve(__dirname, 'temp_video.mp4');
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
    writer.on('finish', () => {
      try {
        const stats = fs.statSync(outputPath);
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

async function uploadVideo(ig, videoPath, caption) {
  const videoBuffer = fs.readFileSync(videoPath);
  console.log(`Read video buffer length: ${videoBuffer.length} bytes`);
  if (!videoBuffer || videoBuffer.length === 0) {
    throw new Error('Video buffer is empty');
  }
  return await ig.publish.video({
    video: videoBuffer,
    caption,
  });
}

async function saveSession(ig) {
  const serialized = await ig.state.serialize();
  fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(serialized, null, 2));
}

async function loadSession(ig) {
  if (!fs.existsSync(SESSION_FILE_PATH)) {
    return false;
  }
  const savedSession = JSON.parse(fs.readFileSync(SESSION_FILE_PATH, 'utf-8'));
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
  const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));

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
        if (fs.existsSync(TEMP_VIDEO_PATH)) {
          fs.unlinkSync(TEMP_VIDEO_PATH);
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
