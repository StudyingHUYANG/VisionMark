const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const execPromise = util.promisify(exec);

class BilibiliDownloader {
  constructor() {
    this.downloadDir = path.join(__dirname, '../../downloads');
    this.ensureDownloadDir();
  }

  ensureDownloadDir() {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  extractBvid(url) {
    const bvMatch = url.match(/BV[\w]+/i);
    if (bvMatch) {
      return bvMatch[0];
    }
    throw new Error('无法从URL中提取BV号');
  }

  async getVideoInfo(bvid) {
    try {
      // 获取视频基本信息（包含 pages 信息）
      const response = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://www.bilibili.com/video/${bvid}`
        },
        timeout: 10000
      });

      if (response.data.code !== 0) {
        throw new Error(`获取视频信息失败: ${response.data.message}`);
      }

      return response.data.data;
    } catch (error) {
      console.error('[BilibiliDownloader] 获取视频信息失败:', error.message);
      throw new Error(`获取视频信息失败: ${error.message}`);
    }
  }

  async getPlayUrl(bvid, cid) {
    try {
      // 获取播放地址
      const response = await axios.get('https://api.bilibili.com/x/player/playurl', {
        params: {
          bvid: bvid,
          cid: cid,
          qn: 120, // 最高画质
          fnval: 16, // 返回 MP4 格式
          fnver: 0,
          fourk: 1,
          otf: 0,
          type: '',
          platform: 'html5'
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://www.bilibili.com/video/${bvid}`
        },
        timeout: 10000
      });

      if (response.data.code !== 0) {
        throw new Error(`获取播放地址失败: ${response.data.message}`);
      }

      return response.data;
    } catch (error) {
      console.error('[BilibiliDownloader] 获取播放地址失败:', error.message);
      throw new Error(`获取播放地址失败: ${error.message}`);
    }
  }

  async downloadFile(url, outputPath, onProgress = null) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 300000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/'
      }
    });

    const totalLength = response.headers['content-length'];
    let currentLength = 0;
    
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    if (onProgress && totalLength) {
      response.data.on('data', (chunk) => {
        currentLength += chunk.length;
        const percent = Math.min(95, Math.floor((currentLength / totalLength) * 85) + 10);
        onProgress({ stage: 'download', percent: percent, message: `正在下载 ${percent}%` });
      });
    }

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async downloadVideo(url, onProgress = null) {
    const bvid = this.extractBvid(url);
    const outputPath = path.join(this.downloadDir, `${bvid}.mp4`);

    // 检查是否已存在
    if (fs.existsSync(outputPath)) {
      console.log(`[BilibiliDownloader] 视频已存在: ${outputPath}`);
      if (onProgress) onProgress({ stage: 'download', percent: 20, message: '视频已缓存，跳过下载' });
      return outputPath;
    }

    try {
      if (onProgress) onProgress({ stage: 'prepare', percent: 5, message: '获取视频信息' });
      
      // 获取视频信息
      const videoInfo = await this.getVideoInfo(bvid);
      const cid = videoInfo.pages?.[0]?.cid;
      
      if (!cid) {
        throw new Error('无法获取视频CID');
      }

      // 获取播放地址
      const playUrlData = await this.getPlayUrl(bvid, cid);
      
      if (!playUrlData.data || !playUrlData.data.durl || playUrlData.data.durl.length === 0) {
        throw new Error('未找到有效的下载链接');
      }

      const videoUrl = playUrlData.data.durl[0].url;
      
      if (onProgress) onProgress({ stage: 'download', percent: 10, message: '开始下载' });
      
      await this.downloadFile(videoUrl, outputPath, onProgress);
      
      if (onProgress) onProgress({ stage: 'download', percent: 20, message: '视频下载完成' });
      console.log('[BilibiliDownloader] 视频下载完成:', outputPath);
      return outputPath;
    } catch (error) {
      console.error('[BilibiliDownloader] 下载失败:', error.message);
      throw error;
    }
  }
}

module.exports = BilibiliDownloader;