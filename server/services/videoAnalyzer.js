const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const OpenAI = require('openai');

const execPromise = util.promisify(exec);

// 通义千问API配置 - 使用OpenAI兼容模式
const QWEN_API_KEY = process.env.QWEN_API_KEY || 'sk-df7f07a45dee431fb8cc9b6453df5f34';

// 创建OpenAI客户端
const openaiClient = new OpenAI({
  apiKey: QWEN_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
});

// 阿里云OSS配置 - 用于上传音频文件
const OSS = require('ali-oss');

const hasOssConfig = Boolean(
  process.env.OSS_ACCESS_KEY_ID &&
  process.env.OSS_ACCESS_KEY_SECRET &&
  process.env.OSS_BUCKET
);

let ossClient = null;
if (hasOssConfig) {
  ossClient = new OSS({
    region: process.env.OSS_REGION || 'oss-cn-beijing',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET
  });
} else {
  console.warn('[VideoAnalyzer] OSS config missing, audio transcription upload will be skipped.');
}

// 时间格式化辅助函数
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

class VideoAnalyzer {
  constructor() {
    this.downloadDir = path.join(__dirname, '../../downloads');
    this.ensureDownloadDir();
  }

  ensureDownloadDir() {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /**
   * 从B站URL提取视频信息
   */
  extractBilibiliInfo(url) {
    // 支持 BV 号和完整URL
    const bvMatch = url.match(/BV[\w]+/i);
    if (bvMatch) {
      return { bvid: bvMatch[0], url };
    }
    throw new Error('无法从URL中提取BV号');
  }

  /**
   * 使用yt-dlp下载B站视频
   */
  async downloadVideo(bvid, url) {
    const outputTemplate = path.join(this.downloadDir, `${bvid}.%(ext)s`);

    // 检查是否已下载（查找匹配的文件）
    const existingFiles = fs.readdirSync(this.downloadDir).filter(f => f.startsWith(bvid) && f.endsWith('.mp4'));
    if (existingFiles.length > 0) {
      const existingPath = path.join(this.downloadDir, existingFiles[0]);
      console.log(`[VideoAnalyzer] 视频已存在: ${existingPath}`);
      return existingPath;
    }

    console.log(`[VideoAnalyzer] 开始下载视频 ${bvid}...`);

    try {
      // 使用yt-dlp下载（使用shell:true来确保找到正确的命令）
      // 使用 @ffmpeg-installer/ffmpeg 提供的路径，避免依赖系统 ffmpeg
      const command = `python -m yt_dlp --ffmpeg-location "${ffmpegPath}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${outputTemplate}" "${url}"`;

      await execPromise(command, { shell: true });

      // 查找下载的视频文件
      const downloadedFiles = fs.readdirSync(this.downloadDir).filter(f => f.startsWith(bvid) && f.endsWith('.mp4'));
      if (downloadedFiles.length === 0) {
        throw new Error('视频下载完成但找不到文件');
      }

      const videoPath = path.join(this.downloadDir, downloadedFiles[0]);
      console.log(`[VideoAnalyzer] 视频下载完成: ${videoPath}`);
      return videoPath;
    } catch (error) {
      console.error('[VideoAnalyzer] 下载失败:', error);
      throw new Error(`视频下载失败: ${error.message}`);
    }
  }

  /**
   * 获取视频时长（秒）
   */
  async getVideoDuration(videoPath) {
    const command = `"${ffmpegPath}" -i "${videoPath}" -f null -`;
    try {
      const { stderr } = await execPromise(command, { shell: true });
      // 从stderr中解析时长
      const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1]);
        const mins = parseInt(durationMatch[2]);
        const secs = parseFloat(durationMatch[3]);
        const duration = hours * 3600 + mins * 60 + secs;
        console.log(`[VideoAnalyzer] 视频时长: ${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')} (${duration.toFixed(2)}秒)`);
        return duration;
      }
      // 如果无法解析，返回默认值
      console.warn('[VideoAnalyzer] 无法获取视频时长，使用默认值300秒');
      return 300;
    } catch (error) {
      console.error('[VideoAnalyzer] 获取视频时长失败:', error.message);
      return 300; // 默认5分钟
    }
  }

  /**
   * 使用ffprobe获取视频关键帧时间戳
   * @param {string} videoPath - 视频路径
   * @returns {Promise<number[]>} 关键帧时间戳（秒）
   */
  async extractKeyframeTimestamps(videoPath) {
    try {
      const command = `"${ffmpegPath.replace(/ffmpeg$/, 'ffprobe')}" -v error -select_streams v -skip_frame nokey -show_entries frame=pkt_pts_time -of csv=p=0 "${videoPath}"`;
      const { stdout } = await execPromise(command, { shell: true });
      const timestamps = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line)
        .map(line => parseFloat(line))
        .filter(t => !Number.isNaN(t));
      return timestamps;
    } catch (error) {
      console.warn('[VideoAnalyzer] 提取关键帧时间戳失败，回退到均匀采样', error.message);
      return [];
    }
  }

  /**
   * 使用ffmpeg提取视频关键帧
   * @param {string} videoPath - 视频路径
   * @param {string} bvid - 视频BV号
   */
  async extractFrames(videoPath, bvid) {
    const framesDir = path.join(this.downloadDir, `${bvid}_frames`);

    if (!fs.existsSync(framesDir)) {
      fs.mkdirSync(framesDir, { recursive: true });
    }

    console.log(`[VideoAnalyzer] 提取视频关键帧...`);

    try {
      // 获取视频实际时长
      const duration = await this.getVideoDuration(videoPath);

      // 尝试使用ffprobe获取关键帧时间戳（更接近场景切换）
      let timestamps = await this.extractKeyframeTimestamps(videoPath);

      // 如果ffprobe失败或者数据过少，退回到均匀采样
      if (!timestamps || timestamps.length < 2) {
        const interval = 5;
        const frameCount = Math.ceil(duration / interval);
        timestamps = Array.from({ length: frameCount }, (_, i) => i * interval);
        console.log(`[VideoAnalyzer] 关键帧时间点不足，退回到均匀采样，每 ${interval} 秒一帧`);
      }

      // 限制最大帧数，避免发送给大模型太多图像
      const MAX_FRAMES = 30;
      if (timestamps.length > MAX_FRAMES) {
        const step = Math.ceil(timestamps.length / MAX_FRAMES);
        timestamps = timestamps.filter((_, idx) => idx % step === 0);
      }

      console.log(`[VideoAnalyzer] 将提取 ${timestamps.length} 张关键帧（基于场景/关键帧，间隔可变）`);

      // 提取关键帧截图，文件名包含时间戳（毫秒），便于后续排序和提示
      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const ms = Math.round(ts * 1000);
        const outputPath = path.join(framesDir, `frame_${String(i + 1).padStart(3, '0')}_${ms}.jpg`);
        const command = `"${ffmpegPath}" -ss ${ts} -i "${videoPath}" -frames:v 1 -q:v 2 -vf "scale=640:-1" "${outputPath}" -y`;
        await execPromise(command, { shell: true });
      }

      console.log(`[VideoAnalyzer] 关键帧提取完成，保存在: ${framesDir}`);
      return { framesDir, duration };
    } catch (error) {
      console.error('[VideoAnalyzer] 关键帧提取失败:', error);
      throw new Error(`关键帧提取失败: ${error.message}`);
    }
  }

  /**
   * 从视频中提取音频
   * @param {string} videoPath - 视频路径
   * @param {string} bvid - 视频BV号
   */
  async extractAudio(videoPath, bvid) {
    const audioPath = path.join(this.downloadDir, `${bvid}.wav`);

    // 检查是否已提取（同时检查旧的.mp3文件）
    const oldMp3Path = path.join(this.downloadDir, `${bvid}.mp3`);
    if (fs.existsSync(audioPath)) {
      console.log(`[VideoAnalyzer] 音频已存在: ${audioPath}`);
      return audioPath;
    } else if (fs.existsSync(oldMp3Path)) {
      console.log(`[VideoAnalyzer] 找到旧的MP3音频，将使用: ${oldMp3Path}`);
      return oldMp3Path;
    }

    console.log(`[VideoAnalyzer] 提取音频为WAV格式...`);

    try {
      // 使用ffmpeg提取音频，采样率16000Hz，单声道，使用WAV格式（更兼容paraformer-v2）
      const command = `"${ffmpegPath}" -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y`;
      await execPromise(command, { shell: true });

      console.log(`[VideoAnalyzer] 音频提取完成: ${audioPath}`);
      return audioPath;
    } catch (error) {
      console.error('[VideoAnalyzer] 音频提取失败:', error);
      throw new Error(`音频提取失败: ${error.message}`);
    }
  }

  /**
   * 使用通义千问语音识别进行音频转录（paraformer-v2异步API）
   * @param {string} audioPath - 音频文件路径
   * @param {string} bvid - 视频BV号
   */
  async transcribeAudio(audioPath, bvid) {
    console.log('[VideoAnalyzer] 开始语音识别...');

    try {
      if (!ossClient) {
        console.warn('[VideoAnalyzer] OSS client unavailable, skip transcription.');
        return null;
      }

      // 检查文件大小
      const stats = fs.statSync(audioPath);
      const fileSizeMB = stats.size / (1024 * 1024);

      // WAV文件较大，限制100MB（大约对应5-10分钟视频）
      if (fileSizeMB > 100) {
        console.warn(`[VideoAnalyzer] 音频文件过大(${fileSizeMB.toFixed(2)}MB)，跳过语音识别`);
        return null;
      }

      console.log(`[VideoAnalyzer] 音频文件大小: ${fileSizeMB.toFixed(2)}MB`);

      // 1. 上传音频到阿里云OSS
      console.log('[VideoAnalyzer] 上传音频到OSS...');
      const ossObjectName = `audio/${bvid}/${path.basename(audioPath)}`;

      try {
        const result = await ossClient.put(ossObjectName, audioPath);
        console.log('[VideoAnalyzer] 音频已上传到OSS:', result.url);
      } catch (error) {
        console.error('[VideoAnalyzer] OSS上传失败:', error.message);
        throw new Error(`音频上传OSS失败: ${error.message}`);
      }

      // 2. 使用paraformer-v2异步API进行语音识别
      console.log('[VideoAnalyzer] 使用 paraformer-v2 异步API 进行语音识别...');

      const audioUrl = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossObjectName}`;

      // Step 1: 提交异步任务
      console.log('[VideoAnalyzer] 提交语音识别任务...');
      const submitResponse = await axios.post(
        'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
        {
          model: 'paraformer-v2',
          input: {
            file_urls: [audioUrl]
          },
          parameters: {
            text_mode: 'sentence',  // 使用sentence模式以获取时间戳
            language_hints: ['zh', 'en'],
            disfluency_removal: false,  // 保留语气词和停顿
            timestamp_alignment: true  // 启用时间戳对齐
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${QWEN_API_KEY}`,
            'Content-Type': 'application/json',
            'X-DashScope-Async': 'enable'  // 启用异步模式
          }
        }
      );

      if (!submitResponse.data.output || !submitResponse.data.output.task_id) {
        throw new Error('提交任务失败，未获取到task_id');
      }

      const taskId = submitResponse.data.output.task_id;
      console.log('[VideoAnalyzer] 任务已提交，task_id:', taskId);

      // Step 2: 轮询任务结果
      console.log('[VideoAnalyzer] 等待任务完成...');
      const maxAttempts = 60; // 最多等待60次（每次2秒，共2分钟）
      let attempts = 0;

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 等待2秒
        attempts++;

        try {
          const resultResponse = await axios.get(
            `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
            {
              headers: {
                'Authorization': `Bearer ${QWEN_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );

          const taskStatus = resultResponse.data.output?.task_status;

          console.log(`[VideoAnalyzer] 任务状态: ${taskStatus} (${attempts}/${maxAttempts})`);

          if (taskStatus === 'SUCCEEDED') {
            // 任务成功完成
            console.log('[VideoAnalyzer] paraformer-v2返回完整数据结构:');
            console.log(JSON.stringify(resultResponse.data.output, null, 2));

            // 检查是否有 transcription_url 需要下载
            if (resultResponse.data.output?.results && resultResponse.data.output.results.length > 0) {
              const firstResult = resultResponse.data.output.results[0];

              // 如果有 transcription_url，需要下载实际的转录结果
              if (firstResult.transcription_url) {
                console.log('[VideoAnalyzer] 检测到 transcription_url，正在下载转录结果...');
                try {
                  const transcriptionResponse = await axios.get(firstResult.transcription_url);
                  const transcriptionData = transcriptionResponse.data;

                  console.log('[VideoAnalyzer] 转录结果数据结构:');
                  console.log(JSON.stringify(transcriptionData, null, 2));

                  // 根据实际的数据结构提取转录文本
                  let transcriptText = '';

                  // 辅助函数：按逗号分割句子并分配时间戳
                  function splitByCommas(sentences) {
                    const result = [];
                    sentences.forEach(sentence => {
                      const beginTime = (sentence.begin_time || 0) / 1000; // 毫秒转秒
                      const text = sentence.text || '';

                      // 按逗号分割
                      const parts = text.split('，');
                      const endTime = (sentence.end_time || sentence.begin_time || 0) / 1000;
                      const duration = endTime - beginTime;

                      parts.forEach((part, index) => {
                        if (part.trim()) {
                          // 按比例分配时间戳
                          const partTime = beginTime + (duration * index / parts.length);
                          const minutes = Math.floor(partTime / 60);
                          const seconds = Math.floor(partTime % 60);
                          const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                          result.push(`[${timeStr}] ${part.trim()}`);
                        }
                      });
                    });
                    return result.join('\n');
                  }

                  // 格式1: {transcripts: [{sentences: [{begin_time, text}, ...]}]}
                  if (transcriptionData.transcripts && transcriptionData.transcripts.length > 0) {
                    console.log('[VideoAnalyzer] 使用 transcripts 数据结构（逗号分割模式）');
                    const allSentences = transcriptionData.transcripts.flatMap(t => t.sentences || []);
                    transcriptText = splitByCommas(allSentences);
                  }
                  // 格式2: {transcription_lines: [{text: "...", begin_time: 1000}, ...]}
                  else if (transcriptionData.transcription_lines) {
                    console.log('[VideoAnalyzer] 使用 transcription_lines 数据结构（逗号分割模式）');
                    transcriptText = splitByCommas(transcriptionData.transcription_lines);
                  } else if (Array.isArray(transcriptionData)) {
                    // 格式3: 直接是数组 [{text: "...", begin_time: 1000}, ...]
                    console.log('[VideoAnalyzer] 使用数组数据结构（逗号分割模式）');
                    transcriptText = splitByCommas(transcriptionData);
                  } else if (typeof transcriptionData === 'string') {
                    // 格式4: 直接是文本（无时间戳，不处理）
                    console.log('[VideoAnalyzer] 使用字符串数据结构');
                    transcriptText = transcriptionData;
                  }

                  if (!transcriptText) {
                    console.warn('[VideoAnalyzer] 无法解析转录数据结构');
                  }

                  console.log('[VideoAnalyzer] 语音识别完成（从transcription_url下载）');
                  console.log('[VideoAnalyzer] 转录内容预览:', transcriptText.substring(0, 500).replace(/\n/g, ' '));
                  return transcriptText;
                } catch (error) {
                  console.error('[VideoAnalyzer] 下载转录结果失败:', error.message);
                  return null;
                }
              } else if (firstResult.transcription_text) {
                // 直接包含转录文本
                const transcript = resultResponse.data.output.results
                  .map(result => {
                    const time = (result.begin_time || result.timestamp || result.start_time || result.time || 0) / 1000;
                    const minutes = Math.floor(time / 60);
                    const seconds = Math.floor(time % 60);
                    const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                    return `[${timeStr}] ${result.transcription_text}`;
                  })
                  .join('\n');

                console.log('[VideoAnalyzer] 语音识别完成');
                console.log('[VideoAnalyzer] 转录内容预览:', transcript.substring(0, 500).replace(/\n/g, ' '));
                return transcript;
              }
            }
            console.warn('[VideoAnalyzer] 任务成功但没有返回转录结果');
            return null;
          } else if (taskStatus === 'FAILED') {
            throw new Error('语音识别任务失败: ' + JSON.stringify(resultResponse.data.output?.message));
          } else if (taskStatus === 'RUNNING' || taskStatus === 'PENDING') {
            // 继续等待
            continue;
          } else {
            throw new Error('未知任务状态: ' + taskStatus);
          }
        } catch (error) {
          if (error.response) {
            throw new Error(`查询任务状态失败: ${JSON.stringify(error.response.data)}`);
          }
          throw error;
        }
      }

      throw new Error('语音识别任务超时');
    } catch (error) {
      console.error('[VideoAnalyzer] 语音识别失败:', error.response?.data || error.message);
      // 如果识别失败，返回null，继续使用画面分析
      return null;
    }
  }

  /**
   * 从音频中提取知识点
   * @param {string} transcript - 音频转录文本
   */
  async extractKnowledgePoints(transcript) {
    if (!transcript) return null;

    console.log('[VideoAnalyzer] 提取知识点...');

    try {
      const response = await openaiClient.chat.completions.create({
        model: 'qwen-turbo',
        messages: [
          {
            role: 'user',
            content: `请从以下文本中提取重要的知识点、概念和术语，进行学霸提示和百科解读：

文本内容（可能包含[MM:SS]时间标记）：
${transcript}

请以JSON格式返回：
{
  "knowledge_points": [
    {
      "term": "术语/概念名称",
      "explanation": "详细解释说明",
      "type": "知识点类型（如：技术概念/历史知识/科学原理等）",
      "timestamp": "出现时间点(格式必须为MM:SS)。如果文本中有[MM:SS]标记，请直接使用该标记；否则请根据上下文推算。"
    }
  ]
}

提取3-8个最重要的知识点。请务必标注每个知识点在文本中大致出现的时间点（根据文本顺序或[MM:SS]标记推测）。`
          }
        ],
        max_tokens: 2000
      });

      if (response && response.choices && response.choices[0]) {
        const result = response.choices[0].message.content;
        // 尝试解析JSON
        const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/) || result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const jsonStr = jsonMatch[1] || jsonMatch[0];
          return JSON.parse(jsonStr);
        }
      }
      return null;
    } catch (error) {
      console.error('[VideoAnalyzer] 知识点提取失败:', error.message);
      return null;
    }
  }

  /**
   * 识别热词和网络梗（仅提取转录文本中原有的词）
   * @param {string} transcript - 音频转录文本
   */
  async extractHotWords(transcript) {
    if (!transcript) return null;

    console.log('[VideoAnalyzer] 识别热词和梗...');

    try {
      const response = await openaiClient.chat.completions.create({
        model: 'qwen-turbo',
        messages: [
          {
            role: 'user',
            content: `请从以下转录文本中提取网络热词、流行梗和饭圈用语。

**重要要求：只能提取转录文本中原有的词汇，不能自己编造或解释新的词！**

转录文本内容（格式：[MM:SS] 文本内容）：
${transcript}

请以JSON格式返回：
{
  "hot_words": [
    {
      "word": "从转录文本中直接提取的热词（必须是原文中出现的词）",
      "meaning": "简要解释这个词的含义",
      "explanation": "简要解释这个词的含义",
      "category": "分类（如：网络梗/流行语/饭圈用语等）",
      "timestamp": "出现时间点(格式必须为MM:SS)。必须直接使用转录文本中的[MM:SS]标记。"
    }
  ]
}

**注意**：
1. 只能提取转录文本中实际出现的词
2. 不要创造或添加文本中没有的词
3. 必须使用转录文本中的[MM:SS]时间戳
4. 如果某个词在转录文本中没有明确的时间戳，就不要提取它
5. 提取3-5个最热门的词`
          }
        ],
        max_tokens: 2000
      });

      if (response && response.choices && response.choices[0]) {
        const result = response.choices[0].message.content;
        // 尝试解析JSON
        const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/) || result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const jsonStr = jsonMatch[1] || jsonMatch[0];
          return JSON.parse(jsonStr);
        }
      }
      return null;
    } catch (error) {
      console.error('[VideoAnalyzer] 热词识别失败:', error.message);
      return null;
    }
  }

  /**
   * 调用通义千问Qwen3-VL进行视频分析
   * @param {string} videoPath - 视频路径
   * @param {string} framesDir - 关键帧目录
   * @param {number} duration - 视频时长（秒）
   * @param {string} transcript - 音频转录文本（可选）
   */
  async analyzeWithQwen(videoPath, framesDir, duration, transcript = null) {
    console.log('[VideoAnalyzer] 调用通义千问API进行视频分析...');

    // 获取所有帧图片，并从文件名中解析时间戳（毫秒）
    const frames = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .map(f => {
        const match = f.match(/frame_\d+_(\d+)\.jpg$/);
        return {
          file: f,
          timestampMs: match ? parseInt(match[1], 10) : 0
        };
      })
      .sort((a, b) => a.timestampMs - b.timestampMs);

    if (frames.length === 0) {
      throw new Error('没有找到关键帧图片');
    }

    console.log(`[VideoAnalyzer] 共有 ${frames.length} 张关键帧`);

    // 生成时间戳（秒）列表，供提示词使用
    const frameTimestamps = frames.map(f => f.timestampMs / 1000);
    const frameTimesText = frameTimestamps
      .slice(0, 10)
      .map(t => formatTime(t))
      .join(', ');

    // 构建提示词 - 结合音视频进行综合分析
    const promptText = `请作为一个资深B站用户和百科全书，对这段视频内容进行深度分析。

ASR语音转录内容（格式：[MM:SS] 文本内容）：
${transcript || '无语音内容'}

**注意**：上述转录文本中的 [MM:SS] 是精确的时间戳，例如 [0:15] 表示该内容在视频第15秒出现。

关键帧分析（仅用于分段和视觉理解）：
我已上传 ${frames.length} 张关键帧截图，按时间顺序排列。它们对应的视频时间点会根据场景/画面内容变化（不固定长度）。示例时间点（仅供参考）：${frameTimesText}。

请输出JSON格式报告：
{
  "title": "视频标题（若未知可根据内容生成）",
  "tags": ["标签1", "标签2"],
  "summary": "300字以内的视频精彩总结，包含核心看点",
  "segments": [
    {
      "start_time": "MM:SS",
      "end_time": "MM:SS",
      "description": "该片段的核心内容概要",
      "highlight": true/false (是否高能片段)
    }
  ],
  "knowledge_points": [
    {
      "term": "知识点名称",
      "explanation": "通俗易懂的解释",
      "timestamp": "MM:SS (必须直接使用语音转录文本中的[MM:SS]标记，不允许推测)"
    }
  ],
  "hot_words": [
    {
      "word": "从转录文本中直接提取的热词（必须是原文中出现的词）",
      "explanation": "简要解释该热词或梗的含义",
      "timestamp": "MM:SS (必须直接使用语音转录文本中的[MM:SS]标记)"
    }
  ]
}

**重要要求**：
1. **热词必须严格从转录文本中提取，不能自己创造或解释新的词**。只提取文本中原有的词汇、短语或梗
2. **知识点和热词的timestamp必须直接使用ASR语音转录文本中的[MM:SS]标记**，不允许推测或根据关键帧推算
3. 如果某个知识点/热词在转录文本中没有对应的时间戳标记，就不要提取它
4. 只提取那些在转录文本中能明确找到时间戳的知识点和热词
5. 分段的start_time和end_time由关键帧画面分析决定
6. 知识点要硬核且有趣，适合B站用户口味
7. 只有真正有价值的内容才提取，不要凑数`;

    // 构建多模态消息
    const content = [
      {
        type: 'text',
        text: promptText
      }
    ];

    // 添加图片（使用base64编码）
    for (const frame of frames) {
      const framePath = path.join(framesDir, frame.file);
      const imageBuffer = fs.readFileSync(framePath);
      const base64Image = imageBuffer.toString('base64');

      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${base64Image}`
        }
      });
    }

    try {
      // 使用OpenAI兼容模式调用通义千问
      const completion = await openaiClient.chat.completions.create({
        model: 'qwen-vl-max',
        messages: [
          {
            role: 'user',
            content: content
          }
        ],
        max_tokens: 3000,
        timeout: 300000 // 5分钟超时
      });

      if (completion && completion.choices && completion.choices[0]) {
        const aiResponse = completion.choices[0].message.content;
        console.log('[VideoAnalyzer] AI分析完成');
        console.log('[VideoAnalyzer] AI完整返回内容:\n', aiResponse);

        // 尝试解析JSON
        try {
          // 提取JSON部分（AI可能返回markdown格式的json）
          const jsonMatch = aiResponse.match(/```json\n([\s\S]*?)\n```/) ||
                           aiResponse.match(/\{[\s\S]*\}/);

          if (jsonMatch) {
            const jsonStr = jsonMatch[1] || jsonMatch[0];
            const parsed = JSON.parse(jsonStr);

            // 确保所有必需字段都存在
            const result = {
              title: parsed.title || '未知标题',
              tags: parsed.tags || [],
              summary: parsed.summary || '',
              segments: parsed.segments || [],
              knowledge_points: parsed.knowledge_points || [],
              hot_words: parsed.hot_words || [],
              raw_response: aiResponse // 包含原始响应以便前端调试
            };

            console.log('[VideoAnalyzer] JSON解析成功');
            console.log('[VideoAnalyzer] - segments:', result.segments.length);
            console.log('[VideoAnalyzer] - knowledge_points:', result.knowledge_points.length);
            console.log('[VideoAnalyzer] - hot_words:', result.hot_words.length);

            // 打印知识点和热词的详细时间戳信息
            if (result.knowledge_points.length > 0) {
              console.log('[VideoAnalyzer] 知识点时间戳详情:');
              result.knowledge_points.forEach((kp, i) => {
                console.log(`  [${i+1}] "${kp.term}" -> timestamp: "${kp.timestamp}"`);
              });

              // 验证时间戳是否在转录文本中
              console.log('[VideoAnalyzer] 验证知识点时间戳...');
              const transcriptLines = (transcript || '').split('\n');
              result.knowledge_points.forEach((kp, i) => {
                const timestampPattern = new RegExp(`\\[${kp.timestamp}\\]`);
                const foundInTranscript = transcriptLines.some(line => timestampPattern.test(line));
                console.log(`  [${i+1}] "${kp.term}" (${kp.timestamp}) ${foundInTranscript ? '✓ 在转录文本中找到' : '✗ 未在转录文本中找到'}`);
              });
            }
            if (result.hot_words.length > 0) {
              console.log('[VideoAnalyzer] 热词时间戳详情:');
              result.hot_words.forEach((hw, i) => {
                console.log(`  [${i+1}] "${hw.word}" -> timestamp: "${hw.timestamp}"`);
              });

              // 验证时间戳是否在转录文本中
              console.log('[VideoAnalyzer] 验证热词时间戳...');
              const transcriptLines = (transcript || '').split('\n');
              result.hot_words.forEach((hw, i) => {
                const timestampPattern = new RegExp(`\\[${hw.timestamp}\\]`);
                const foundInTranscript = transcriptLines.some(line => timestampPattern.test(line));
                console.log(`  [${i+1}] "${hw.word}" (${hw.timestamp}) ${foundInTranscript ? '✓ 在转录文本中找到' : '✗ 未在转录文本中找到'}`);
              });
            }

            return result;
          }

          // 如果没有找到JSON，返回原始文本
          console.warn('[VideoAnalyzer] 未找到JSON格式，返回原始响应');
          return {
            title: '解析失败',
            tags: [],
            summary: aiResponse.substring(0, 200),
            segments: [],
            knowledge_points: [],
            hot_words: [],
            raw_response: aiResponse,
            parse_error: '无法提取JSON格式的分析结果'
          };
        } catch (parseError) {
          console.error('[VideoAnalyzer] JSON解析失败:', parseError);
          return {
            title: '解析失败',
            tags: [],
            summary: aiResponse ? aiResponse.substring(0, 200) : '解析错误',
            segments: [],
            knowledge_points: [],
            hot_words: [],
            raw_response: aiResponse,
            parse_error: parseError.message
          };
        }
      } else {
        throw new Error('API返回数据格式错误');
      }
    } catch (error) {
      console.error('[VideoAnalyzer] API调用失败:', error.response?.data || error.message);
      throw new Error(`AI分析失败: ${error.message}`);
    }
  }

  /**
   * 完整的视频分析流程（支持音视频结合分析）
   */
  async analyzeVideo(url, useAudio = true) {
    try {
      // 1. 提取视频信息
      const { bvid } = this.extractBilibiliInfo(url);
      console.log(`[VideoAnalyzer] 开始分析视频: ${bvid}`);

      // 2. 下载视频
      const videoPath = await this.downloadVideo(bvid, url);

      // 3. 提取关键帧（用于视觉理解）
      const { framesDir, duration } = await this.extractFrames(videoPath, bvid);

      // 4. 提取音频并进行语音识别（可选）
      let transcript = null;

      if (useAudio) {
        try {
          const audioPath = await this.extractAudio(videoPath, bvid);
          transcript = await this.transcribeAudio(audioPath, bvid);
        } catch (error) {
          console.warn('[VideoAnalyzer] 音频处理失败，继续使用画面分析:', error.message);
        }
      }

      // 5. AI分析（基于关键帧、时长和音频转录），知识点和热词从分析结果中获取
      const analysisResult = await this.analyzeWithQwen(videoPath, framesDir, duration, transcript);

      // 6. 整合所有分析结果
      const finalResult = {
        ...analysisResult,
        // 添加音频转录文本（如果有）
        transcript: transcript
      };

      // 7. 返回结果
      return {
        bvid,
        video_path: videoPath,
        analysis: finalResult,
        analyzed_at: new Date().toISOString()
      };
    } catch (error) {
      console.error('[VideoAnalyzer] 视频分析失败:', error);
      throw error;
    }
  }

  /**
   * 清理下载的视频文件
   */
  cleanup(bvid) {
    try {
      // 查找并删除视频文件（可能有不同的格式后缀）
      const files = fs.readdirSync(this.downloadDir);
      const videoFiles = files.filter(f => f.startsWith(bvid) && (f.endsWith('.mp4') || f.endsWith('.mp3') || f.endsWith('.m4a')));

      videoFiles.forEach(file => {
        const filePath = path.join(this.downloadDir, file);
        fs.unlinkSync(filePath);
        console.log(`[VideoAnalyzer] 已删除文件: ${filePath}`);
      });

      // 删除关键帧目录
      const framesDir = path.join(this.downloadDir, `${bvid}_frames`);
      if (fs.existsSync(framesDir)) {
        fs.rmSync(framesDir, { recursive: true, force: true });
        console.log(`[VideoAnalyzer] 已删除关键帧: ${framesDir}`);
      }
    } catch (error) {
      console.error('[VideoAnalyzer] 清理文件失败:', error);
    }
  }
}

module.exports = VideoAnalyzer;