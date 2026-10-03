'use strict';

/**
 * VideoAnalyzer 媒体链路测试：时长探测 / 抽帧容错 / 音频自愈 / 超时 / 帧缓存指纹 / 时长推导
 *
 * 运行方式: node server/services/videoAnalyzer.media.test.js
 *
 * 全程 mock 掉 child_process.exec（ffmpeg/ffprobe）：
 * 不跑真实 ffmpeg、不访问网络、只使用本机临时目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// oss.js 在 require 时就用环境变量算出 hasOssConfig，这里先清掉，
// 保证音频降级用例在「本机真的配了 OSS」时也能稳定复现未配置场景。
delete process.env.OSS_ACCESS_KEY_ID;
delete process.env.OSS_ACCESS_KEY_SECRET;
delete process.env.OSS_BUCKET;

// videoAnalyzer 在模块加载时就解构了 runSegmentPipeline，之后再改导出对象已经晚了，
// 所以必须在 require('./videoAnalyzer') 之前替换，才能观测到它实际收到的 duration。
const segmentPipelineModule = require('./segmentPipeline');
const pipelineDurations = [];
const realRunSegmentPipeline = segmentPipelineModule.runSegmentPipeline;
segmentPipelineModule.runSegmentPipeline = (input, options) => {
  pipelineDurations.push(input.duration);
  return realRunSegmentPipeline(input, options);
};

const VideoAnalyzer = require('./videoAnalyzer');
const {
  formatTranscriptSegments,
  resolveMediaTimeoutMs,
  parseDurationValue,
  isMediaToolTimeout,
  MEDIA_TIMEOUT_POLICIES,
  MIN_AUDIO_BYTES
} = VideoAnalyzer;

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(condition, label, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function equal(actual, expected, label) {
  check(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function test(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (error) {
    failures.push(`${name} 抛出异常: ${error.stack || error.message}`);
    console.error(`  ✗ 抛出异常: ${error.stack || error.message}`);
  }
}

function makeTempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vm-media-${name}-`));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

/** 从命令行里取最后一个引号参数（即输出文件路径） */
function lastQuotedArg(command) {
  const matches = [...String(command).matchAll(/"([^"]*)"/g)].map(m => m[1]);
  return matches.length ? matches[matches.length - 1] : null;
}

/**
 * exec mock。
 * handler(command, options) 返回：
 *   { stdout, stderr }      正常回调
 *   { error }               回调错误
 *   'never'                 永不回调（模拟挂死，用于超时）
 *   { writeBytes: n }       额外把 n 字节写到命令行最后一个引号参数指向的文件
 */
function createExecMock(handler) {
  const calls = [];
  const exec = (command, options, callback) => {
    const call = { command, options, killed: false };
    calls.push(call);
    const child = { pid: undefined, kill: () => { call.killed = true; } };

    const outcome = handler ? handler(command, options, call) : { stdout: '', stderr: '' };
    if (outcome === 'never') return child;

    setImmediate(() => {
      if (outcome && outcome.error) {
        callback(outcome.error, outcome.stdout || '', outcome.stderr || '');
        return;
      }
      if (outcome && outcome.writeBytes) {
        const target = lastQuotedArg(command);
        if (target) {
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, Buffer.alloc(outcome.writeBytes, 7));
          } catch (_) { /* 目录不存在等场景忽略 */ }
        }
      }
      callback(null, (outcome && outcome.stdout) || '', (outcome && outcome.stderr) || '');
    });

    return child;
  };
  exec.calls = calls;
  exec.countMatching = (needle) => calls.filter(call => call.command.includes(needle)).length;
  return exec;
}

function makeAnalyzer(dir, execImpl, options = {}) {
  return new VideoAnalyzer(dir, null, { execImpl, ...options });
}

/** 抽帧命令：带 -frames:v 1 的单帧抓取 */
function isFrameGrab(command) {
  return command.includes('-frames:v 1');
}

const BV = 'BV1MediaTest01';

/**
 * analyzeVideo 的实例桩：不下载、不抽帧、不跑 ffmpeg/ASR/大模型，只记录各步骤是否被调用。
 * 视觉探针返回空帧，analyzeVisualCuts 收到 < 2 帧会直接短路，不会起 python 进程；
 * createOpenAIClient 返回 null，分段主流程走本地 fallback，不会联网。
 *
 * options.useRealExtractFrames=true 时保留真实 extractFrames（配合桩掉 getVideoDuration /
 * extractKeyframeTimestamps 使用），用于观测时长推导；此时 calls.extractFrames 不计数。
 */
function stubAnalyzeVideoDeps(analyzer, dir, options = {}) {
  const calls = {
    downloadVideoHybrid: 0,
    extractFrames: 0,
    storeFrameVectors: 0,
    extractVisualProbeFrames: 0,
    analyzeWithQwen: 0,
    extractAudio: 0,
    transcribeAudio: 0,
    // 记录下游实际收到的 duration，用来钉住"用于后续流程的时长"到底是什么
    visualProbeDurations: [],
    audioDurations: []
  };
  const framesDir = path.join(dir, 'stub_frames');
  fs.mkdirSync(framesDir, { recursive: true });

  analyzer.downloadVideoHybrid = async () => {
    calls.downloadVideoHybrid += 1;
    return path.join(dir, `${BV}.mp4`);
  };
  if (!options.useRealExtractFrames) {
    analyzer.extractFrames = async () => {
      calls.extractFrames += 1;
      return { framesDir, duration: 10, durationSource: 'probe' };
    };
  }
  analyzer.storeFrameVectors = async () => { calls.storeFrameVectors += 1; };
  analyzer.extractVisualProbeFrames = async (videoPath, bvid, duration) => {
    calls.extractVisualProbeFrames += 1;
    calls.visualProbeDurations.push(duration);
    return { frames: [], meta: {} };
  };
  analyzer.analyzeWithQwen = async () => {
    calls.analyzeWithQwen += 1;
    return { knowledge_points: [], hot_words: [] };
  };
  // 返回 null 而不是假路径：analyzeVideo 里的 audioCuts 分支只处理真实存在的文件
  analyzer.extractAudio = async (videoPath, bvid, onProgress, audioOptions = {}) => {
    calls.extractAudio += 1;
    calls.audioDurations.push(audioOptions.duration);
    return null;
  };
  analyzer.transcribeAudio = async () => { calls.transcribeAudio += 1; return null; };
  analyzer.createOpenAIClient = () => null;

  return calls;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== VideoAnalyzer 媒体链路测试 ==========');

  // --- D1: 时长探测三级 ---
  await test('时长探测：ffprobe format=duration 命中', async () => {
    const dir = makeTempDir('dur-format');
    const execImpl = createExecMock((command) => {
      if (command.includes('format=duration')) return { stdout: '1234.567\n' };
      return { stdout: '' };
    });
    const analyzer = makeAnalyzer(dir, execImpl);

    const result = await analyzer.getVideoDuration(path.join(dir, 'v.mp4'));
    equal(result.duration, 1234.567, '解析出容器时长');
    equal(result.durationSource, 'probe', '来源为 probe');
    equal(result.detail, 'format=duration', '标注命中的探测方式');

    cleanupDir(dir);
  });

  await test('时长探测：容器无 duration 时退到视频流 duration', async () => {
    const dir = makeTempDir('dur-stream');
    const execImpl = createExecMock((command) => {
      if (command.includes('format=duration')) return { stdout: '\n' };
      if (command.includes('stream=duration')) return { stdout: 'N/A\n600.5\n' };
      return { stdout: '' };
    });
    const analyzer = makeAnalyzer(dir, execImpl);

    const result = await analyzer.getVideoDuration(path.join(dir, 'v.flv'));
    equal(result.duration, 600.5, 'N/A 被忽略，取到流时长');
    equal(result.durationSource, 'probe', '来源为 probe');
    equal(result.detail, 'stream=duration', '标注命中的探测方式');

    cleanupDir(dir);
  });

  await test('时长探测：ffprobe 都拿不到时解码取最大 pts_time', async () => {
    const dir = makeTempDir('dur-decode');
    const execImpl = createExecMock((command) => {
      if (command.includes('format=duration')) return { stdout: 'N/A\n' };
      if (command.includes('stream=duration')) return { stdout: '' };
      if (command.includes('showinfo')) {
        return { stderr: 'pts_time:0.000\npts_time:10.500\npts_time:2401.250\n' };
      }
      return { stdout: '' };
    });
    const analyzer = makeAnalyzer(dir, execImpl);

    const result = await analyzer.getVideoDuration(path.join(dir, 'v.mp4'));
    equal(result.duration, 2401.25, '取最大 pts_time');
    equal(result.durationSource, 'decoded', '来源为 decoded');
    check(execImpl.countMatching('showinfo') === 1, '确实做了解码探测');

    cleanupDir(dir);
  });

  await test('时长探测：三级全失败返回 null，不再兜底 300', async () => {
    const dir = makeTempDir('dur-unknown');
    const execImpl = createExecMock(() => ({ stdout: '', stderr: '' }));
    const analyzer = makeAnalyzer(dir, execImpl);

    const result = await analyzer.getVideoDuration(path.join(dir, 'broken.mp4'));
    equal(result.duration, null, 'duration 为 null');
    equal(result.durationSource, 'unknown', '来源为 unknown');
    check(result.duration !== 300, '没有回退到 300 秒');

    cleanupDir(dir);
  });

  // --- D2: 超时 ---
  await test('超时：挂死的命令抛 MediaToolTimeoutError 并杀进程', async () => {
    const dir = makeTempDir('timeout');
    const execImpl = createExecMock(() => 'never');
    const analyzer = makeAnalyzer(dir, execImpl, { mediaTimeoutMs: 50 });

    const startedAt = Date.now();
    let caught = null;
    try {
      await analyzer.runMediaCommand('"ffmpeg" -i x -f null -', { label: '测试命令' });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - startedAt;

    check(Boolean(caught), '确实抛错');
    check(isMediaToolTimeout(caught), '归类为超时', caught && caught.message);
    check(elapsed < 5000, '没有永久挂起', `${elapsed}ms`);
    check(execImpl.calls[0].killed === true, '超时后杀掉了子进程');

    cleanupDir(dir);
  });

  // --- D3: 不传 timeoutMs 的兜底（Number(null) === 0 回归） ---
  await test('超时：不传 timeoutMs 时走 probe 策略兜底（120s），而不是 1ms', async () => {
    const dir = makeTempDir('timeout-default-probe');
    const execImpl = createExecMock(() => ({ stdout: '', stderr: '' }));
    const analyzer = makeAnalyzer(dir, execImpl);

    // 捕获实际注册的超时定时器时长；命令正常返回后定时器会被清掉，不用真的等 120s
    const realSetTimeout = global.setTimeout;
    const delays = [];
    global.setTimeout = (fn, ms, ...args) => {
      delays.push(ms);
      return realSetTimeout(fn, ms, ...args);
    };

    try {
      await analyzer.runMediaCommand('"ffmpeg" -version', { label: '默认超时命令' });
    } finally {
      global.setTimeout = realSetTimeout;
    }

    equal(execImpl.calls.length, 1, '命令确实执行了一次');
    equal(delays.length, 1, '注册了一次超时定时器');
    equal(delays[0], MEDIA_TIMEOUT_POLICIES.probe.minMs, '实际超时预算为 probe 策略的 120s 兜底值');

    cleanupDir(dir);
  });

  await test('超时：不传 timeoutMs 时注入的 mediaTimeoutMs 生效，计时不是 1ms', async () => {
    const dir = makeTempDir('timeout-default-override');
    const execImpl = createExecMock(() => 'never');
    const analyzer = makeAnalyzer(dir, execImpl, { mediaTimeoutMs: 50 });

    const startedAt = Date.now();
    let caught = null;
    try {
      await analyzer.runMediaCommand('"ffmpeg" -i x -f null -', { label: '默认走兜底' });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - startedAt;

    check(isMediaToolTimeout(caught), '归类为超时', caught && caught.message);
    equal(caught?.timeoutMs, 50, '生效的超时是 50ms，而不是被 null 误判成的 1ms');
    check(elapsed >= 40, '至少等满了注入的超时时间，没有瞬时超时', `${elapsed}ms`);
    check(elapsed < 5000, '没有永久挂起', `${elapsed}ms`);

    cleanupDir(dir);
  });

  await test('超时：时长探测三级全超时仍返回 unknown 而不是挂死', async () => {
    const dir = makeTempDir('timeout-duration');
    const execImpl = createExecMock(() => 'never');
    const analyzer = makeAnalyzer(dir, execImpl, { mediaTimeoutMs: 30 });

    const startedAt = Date.now();
    const result = await analyzer.getVideoDuration(path.join(dir, 'v.mp4'));
    const elapsed = Date.now() - startedAt;

    equal(result.durationSource, 'unknown', '超时后判定为 unknown');
    equal(result.duration, null, 'duration 为 null');
    check(elapsed < 5000, '三级超时很快返回', `${elapsed}ms`);

    cleanupDir(dir);
  });

  await test('超时策略：按时长缩放且不低于下限', async () => {
    equal(
      resolveMediaTimeoutMs(2400, MEDIA_TIMEOUT_POLICIES.audio),
      1200000,
      '40 分钟视频的音频提取超时 = 时长*0.5'
    );
    equal(
      resolveMediaTimeoutMs(60, MEDIA_TIMEOUT_POLICIES.audio),
      MEDIA_TIMEOUT_POLICIES.audio.minMs,
      '短视频退回到下限'
    );
    equal(
      resolveMediaTimeoutMs(null, MEDIA_TIMEOUT_POLICIES.probe),
      MEDIA_TIMEOUT_POLICIES.probe.minMs,
      '时长未知退回到下限'
    );
  });

  // --- F1: 抽帧 ---
  await test('抽帧：清掉旧帧，单帧失败只跳过，不拖垮整轮', async () => {
    const dir = makeTempDir('frames');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));

    const framesDir = path.join(dir, `${BV}_frames`);
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(framesDir, 'frame_001_0.jpg'), Buffer.alloc(16, 9));
    fs.writeFileSync(path.join(framesDir, 'stale.png'), Buffer.alloc(16, 9));

    const timestamps = [1, 2, 3, 4, 5];
    const execImpl = createExecMock((command) => {
      if (command.includes('format=duration')) return { stdout: '600.0\n' };
      if (command.includes('-skip_frame nokey')) return { stdout: `${timestamps.join('\n')}\n` };
      if (isFrameGrab(command)) {
        // t=2s 那一帧模拟失败
        if (command.includes('-ss 2 ')) return { error: new Error('seek 失败') };
        return { writeBytes: 32 };
      }
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    const result = await analyzer.extractFrames(videoPath, BV, null);

    equal(result.duration, 600, '时长为探测值');
    equal(result.durationSource, 'probe', '时长来源标记为 probe');
    equal(result.frameCount, 4, '成功 4 帧');
    equal(result.failedFrameCount, 1, '失败 1 帧');
    check(!fs.existsSync(path.join(framesDir, 'stale.png')), '旧的 png 已清理');
    check(!fs.existsSync(path.join(framesDir, 'frame_001_0.jpg')), '旧的 jpg 已清理');
    check(
      fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).length === 4,
      '目录里只留成功帧',
      fs.readdirSync(framesDir).join(',')
    );
    check(!fs.existsSync(path.join(framesDir, 'frame_002_2000.jpg')), '失败帧没有留下半成品');

    cleanupDir(dir);
  });

  await test('抽帧：全部失败才抛错', async () => {
    const dir = makeTempDir('frames-all-fail');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));

    const execImpl = createExecMock((command) => {
      if (command.includes('format=duration')) return { stdout: '600.0\n' };
      if (command.includes('-skip_frame nokey')) return { stdout: '1\n2\n3\n' };
      if (isFrameGrab(command)) return { error: new Error('解码器炸了') };
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    let caught = null;
    try {
      await analyzer.extractFrames(videoPath, BV, null);
    } catch (error) {
      caught = error;
    }

    check(Boolean(caught), '全部失败时抛错');
    check(/关键帧提取失败/.test(caught?.message || ''), '错误信息可读', caught?.message);

    cleanupDir(dir);
  });

  await test('抽帧：时长未知且没有关键帧时明确报错，不静默用假时长', async () => {
    const dir = makeTempDir('frames-no-duration');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));

    const execImpl = createExecMock(() => ({ stdout: '' }));
    const analyzer = makeAnalyzer(dir, execImpl);

    let caught = null;
    try {
      await analyzer.extractFrames(videoPath, BV, null);
    } catch (error) {
      caught = error;
    }

    check(Boolean(caught), '拿不到时长也没有关键帧时抛错');
    check(/无法获取视频时长/.test(caught?.message || ''), '错误信息说明原因', caught?.message);

    cleanupDir(dir);
  });

  // --- A1: 音频自愈 ---
  await test('音频：0 字节坏 wav 不被当成缓存，删除后重新提取', async () => {
    const dir = makeTempDir('audio-empty');
    const videoPath = path.join(dir, 'v.mp4');
    const audioPath = path.join(dir, `${BV}.wav`);
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));
    fs.writeFileSync(audioPath, Buffer.alloc(0)); // 坏缓存

    const execImpl = createExecMock((command) => {
      if (command.includes('-select_streams a:0')) return { stdout: 'audio\n' };
      if (command.includes('format=duration') && command.includes('.wav')) return { stdout: '600.0\n' };
      if (command.includes('format=duration')) return { stdout: '600.0\n' };
      if (command.includes('-acodec pcm_s16le')) return { writeBytes: MIN_AUDIO_BYTES + 4096 };
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    const result = await analyzer.extractAudio(videoPath, BV, null, { duration: 600 });

    equal(result, audioPath, '返回 wav 路径');
    check(execImpl.countMatching('pcm_s16le') === 1, '确实重新提取了一次');
    check(fs.statSync(audioPath).size > MIN_AUDIO_BYTES, '回填了有效音频');

    cleanupDir(dir);
  });

  await test('音频：时长与视频对不上的缓存会被丢弃重提', async () => {
    const dir = makeTempDir('audio-stale');
    const videoPath = path.join(dir, 'v.mp4');
    const audioPath = path.join(dir, `${BV}.wav`);
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));
    fs.writeFileSync(audioPath, Buffer.alloc(MIN_AUDIO_BYTES + 1024, 3));

    const execImpl = createExecMock((command) => {
      if (command.includes('-select_streams a:0')) return { stdout: 'audio\n' };
      if (command.includes('format=duration') && command.includes('.wav') && execImpl.wavProbed) {
        return { stdout: '600.0\n' };
      }
      // 第一次探测缓存时给出错误的时长
      if (command.includes('format=duration') && command.includes('.wav')) {
        execImpl.wavProbed = true;
        return { stdout: '10.0\n' };
      }
      if (command.includes('-acodec pcm_s16le')) return { writeBytes: MIN_AUDIO_BYTES + 2048 };
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    await analyzer.extractAudio(videoPath, BV, null, { duration: 600 });

    check(execImpl.countMatching('pcm_s16le') === 1, '丢弃旧缓存后重新提取');

    cleanupDir(dir);
  });

  await test('音频：音轨时长优先于容器时长，避免误删有效缓存', async () => {
    const dir = makeTempDir('audio-track-ref');
    const videoPath = path.join(dir, 'v.mp4');
    const audioPath = path.join(dir, `${BV}.wav`);
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));
    fs.writeFileSync(audioPath, Buffer.alloc(MIN_AUDIO_BYTES + 1024, 3));

    const execImpl = createExecMock((command) => {
      if (command.includes('stream=codec_type')) return { stdout: 'audio\n' };
      // 视频容器 700s，但音轨只有 600.5s（尾部是纯画面）
      if (command.includes('stream=duration') && command.includes('.mp4')) return { stdout: '600.5\n' };
      if (command.includes('format=duration') && command.includes('.wav')) return { stdout: '600.0\n' };
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    const result = await analyzer.extractAudio(videoPath, BV, null, { duration: 700 });

    equal(result, audioPath, '复用已存在的 wav');
    equal(execImpl.countMatching('pcm_s16le'), 0, '没有误判为坏缓存而重新提取');

    cleanupDir(dir);
  });

  await test('音频：提取超时会删掉半成品并抛出', async () => {
    const dir = makeTempDir('audio-timeout');
    const videoPath = path.join(dir, 'v.mp4');
    const audioPath = path.join(dir, `${BV}.wav`);
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));

    const execImpl = createExecMock((command) => {
      if (command.includes('-acodec pcm_s16le')) {
        // 模拟 ffmpeg 已经写了半截文件然后挂死
        fs.writeFileSync(audioPath, Buffer.alloc(MIN_AUDIO_BYTES + 512, 1));
        return 'never';
      }
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl, { mediaTimeoutMs: 40 });
    let caught = null;
    try {
      await analyzer.extractAudio(videoPath, BV, null, { duration: 600 });
    } catch (error) {
      caught = error;
    }

    check(Boolean(caught), '超时抛错');
    check(!fs.existsSync(audioPath), '半成品 wav 已删除，下次不会命中坏缓存');

    cleanupDir(dir);
  });

  await test('音频：历史 mp3 通过校验时直接复用', async () => {
    const dir = makeTempDir('audio-legacy');
    const videoPath = path.join(dir, 'v.mp4');
    const legacyMp3 = path.join(dir, `${BV}.mp3`);
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));
    fs.writeFileSync(legacyMp3, Buffer.alloc(MIN_AUDIO_BYTES + 1024, 2));

    const execImpl = createExecMock((command) => {
      if (command.includes('-select_streams a:0')) return { stdout: 'audio\n' };
      if (command.includes('format=duration')) return { stdout: '600.0\n' };
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    const result = await analyzer.extractAudio(videoPath, BV, null, { duration: 600 });

    equal(result, legacyMp3, '返回 mp3 路径');
    equal(execImpl.countMatching('pcm_s16le'), 0, '没有重复提取 wav');

    cleanupDir(dir);
  });

  // --- V1: 视觉帧缓存指纹 ---
  await test('视觉帧缓存：老 manifest 缺 source_size 视为不匹配，重新抽帧', async () => {
    const dir = makeTempDir('visual-fingerprint');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(2048, 1));

    const framesDir = path.join(dir, `${BV}_visual_frames`);
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(framesDir, 'visual_000001.jpg'), Buffer.alloc(16, 1));
    fs.writeFileSync(path.join(framesDir, 'visual_000002.jpg'), Buffer.alloc(16, 1));
    // 老格式 manifest：没有 source_size / source_mtime_ms
    fs.writeFileSync(path.join(framesDir, 'manifest.json'), JSON.stringify({
      source_video: videoPath,
      duration: 600,
      sample_fps: 1,
      max_frames: 900,
      scale_width: 320,
      frames: [
        { file: 'visual_000001.jpg', time: 0 },
        { file: 'visual_000002.jpg', time: 1 }
      ]
    }), 'utf8');

    const execImpl = createExecMock((command) => {
      if (command.includes('visual_%06d.jpg')) {
        for (let i = 1; i <= 6; i += 1) {
          fs.writeFileSync(path.join(framesDir, `visual_${String(i).padStart(6, '0')}.jpg`), Buffer.alloc(16, 1));
        }
        return {};
      }
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    const first = await analyzer.extractVisualProbeFrames(videoPath, BV, 600, null, {});
    equal(first.meta.cached, false, '老 manifest 不复用');
    equal(execImpl.countMatching('visual_%06d.jpg'), 1, '重新抽了一次帧');
    equal(first.meta.effectiveFps, 1, '有效 fps 与采样设置一致');
    equal(first.meta.scaleWidth, 320, 'scale 宽度记录在 meta 里');

    // 第二次：manifest 已带指纹，应该命中缓存
    const second = await analyzer.extractVisualProbeFrames(videoPath, BV, 600, null, {});
    equal(second.meta.cached, true, '指纹一致时命中缓存');
    equal(execImpl.countMatching('visual_%06d.jpg'), 1, '缓存命中不再抽帧');

    // 源文件变化（同名不同内容）后必须重新抽帧
    fs.writeFileSync(videoPath, Buffer.alloc(4096, 2));
    const third = await analyzer.extractVisualProbeFrames(videoPath, BV, 600, null, {});
    equal(third.meta.cached, false, '源文件指纹变化后不复用缓存');
    equal(execImpl.countMatching('visual_%06d.jpg'), 2, '重新抽帧');

    cleanupDir(dir);
  });

  // --- T1: 转写文本时间戳 ---
  await test('转写文本：时间戳直接取识别结果，不按逗号插值', async () => {
    const transcript = formatTranscriptSegments([
      { start: 12.4, end: 40, text: '前半句，后半句' }
    ]);

    equal(transcript, '[0:12] 前半句，后半句', '整句一行，不切分也不插值');
    check(!transcript.includes('[0:26]'), '没有编造出中间时间戳');
  });

  await test('转写文本：按 start 排序并跳过空文本', async () => {
    const transcript = formatTranscriptSegments([
      { start: 65, end: 70, text: '第二句' },
      { start: 5, end: 10, text: '第一句' },
      { start: 30, end: 31, text: '   ' }
    ]);

    equal(transcript, '[0:05] 第一句\n[1:05] 第二句', '按时间升序排列且丢弃空文本');
  });

  await test('转写文本：空输入返回空串', async () => {
    equal(formatTranscriptSegments([]), '', '空数组');
    equal(formatTranscriptSegments(null), '', 'null');
  });

  await test('工具函数：parseDurationValue 只认有效正数', async () => {
    equal(parseDurationValue('12.5\n'), 12.5, '正常数值');
    equal(parseDurationValue('N/A'), null, 'N/A 视为无效');
    equal(parseDurationValue(''), null, '空输出视为无效');
    equal(parseDurationValue('0'), null, '0 视为无效');
  });

  // --- P1: analyzeVideo 音频支路不受 OSS 配置影响 ---
  await test('analyzeVideo：useAudio=true 时抽音频与转写都会执行（OSS 未配置也一样）', async () => {
    const dir = makeTempDir('analyze-audio-on');
    const analyzer = makeAnalyzer(dir, createExecMock(() => ({ stdout: '' })));
    const calls = stubAnalyzeVideoDeps(analyzer, dir);

    await analyzer.analyzeVideo('https://www.bilibili.com/video/BV1test00001', true);

    equal(calls.extractAudio, 1, 'extractAudio 被调用一次');
    equal(calls.transcribeAudio, 1, 'transcribeAudio 被调用一次');

    cleanupDir(dir);
  });

  await test('analyzeVideo：useAudio=false 时音频支路完全跳过', async () => {
    const dir = makeTempDir('analyze-audio-off');
    const analyzer = makeAnalyzer(dir, createExecMock(() => ({ stdout: '' })));
    const calls = stubAnalyzeVideoDeps(analyzer, dir);

    await analyzer.analyzeVideo('https://www.bilibili.com/video/BV1test00001', false);

    equal(calls.extractAudio, 0, 'extractAudio 没有被调用');
    equal(calls.transcribeAudio, 0, 'transcribeAudio 没有被调用');

    cleanupDir(dir);
  });

  await test('analyzeVideo：OSS 未配置时打出本地降级说明', async () => {
    const dir = makeTempDir('analyze-audio-warn');
    const analyzer = makeAnalyzer(dir, createExecMock(() => ({ stdout: '' })));
    stubAnalyzeVideoDeps(analyzer, dir);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    try {
      await analyzer.analyzeVideo('https://www.bilibili.com/video/BV1test00001', true);
    } finally {
      console.warn = originalWarn;
    }

    const hit = warnings.find(msg => msg.includes('未配置 OSS'));
    check(Boolean(hit), '出现了 OSS 未配置的告警', warnings.join('\n'));
    check(Boolean(hit) && hit.includes('DashScope'), '说明 DashScope 上传路径不可用', hit);
    check(Boolean(hit) && hit.includes('Whisper'), '说明将依赖本地 Whisper', hit);
    check(Boolean(hit) && hit.includes('本地音频切点'), '说明将依赖本地音频切点', hit);

    cleanupDir(dir);
  });

  // --- P2: 时长探测失败时用最大关键帧时间戳兜底 ---
  await test('抽帧：关键帧时间戳随返回值带出，供时长兜底使用', async () => {
    const dir = makeTempDir('frames-keyframe-ts');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));

    const execImpl = createExecMock((command) => {
      if (command.includes('format=duration')) return { stdout: '600.0\n' };
      if (command.includes('pkt_pts_time')) return { stdout: '0.000\n120.500\n300.000\n' };
      if (isFrameGrab(command)) return { writeBytes: 32 };
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    const result = await analyzer.extractFrames(videoPath, BV, null);

    equal(result.duration, 600, '时长仍取探测值');
    equal(result.durationSource, 'probe', '来源不受影响');
    check(Array.isArray(result.keyframeTimestamps), '返回值里带出了关键帧时间戳');
    equal(result.keyframeTimestamps?.length, 3, '时间戳个数与关键帧一致');
    equal(Math.max(...(result.keyframeTimestamps || [])), 300, '最大值就是最后一帧时间');

    cleanupDir(dir);
  });

  await test('时长推导：探测失败时改用最大关键帧时间戳，并如实标注来源', async () => {
    const dir = makeTempDir('duration-derived');
    const execImpl = createExecMock((command) => {
      if (isFrameGrab(command)) return { writeBytes: 32 };
      return { stdout: '' };
    });
    const analyzer = makeAnalyzer(dir, execImpl);
    const calls = stubAnalyzeVideoDeps(analyzer, dir, { useRealExtractFrames: true });
    analyzer.getVideoDuration = async () => ({ duration: null, durationSource: 'unknown', detail: '三级探测全失败' });
    analyzer.extractKeyframeTimestamps = async () => [0, 5, 10];
    pipelineDurations.length = 0;

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    let result;
    try {
      result = await analyzer.analyzeVideo('https://www.bilibili.com/video/BV1test00001', true);
    } finally {
      console.warn = originalWarn;
    }

    equal(calls.visualProbeDurations[0], 10, 'extractVisualProbeFrames 收到推导时长');
    equal(calls.audioDurations[0], 10, 'extractAudio 收到推导时长');
    equal(pipelineDurations[0], 10, 'runSegmentPipeline 收到推导时长');
    equal(result.analysis.duration, 10, '返回体 duration 为推导值');
    equal(result.analysis.duration_source, 'derived_from_keyframes', '返回体来源如实标注为推导');
    check(
      warnings.some(msg => msg.includes('时长探测失败') && msg.includes('10 秒')),
      '打出了可追溯的降级说明',
      warnings.join('\n')
    );

    cleanupDir(dir);
  });

  await test('时长推导：探测成功时原样使用，关键帧时间戳不参与', async () => {
    const dir = makeTempDir('duration-probe');
    const execImpl = createExecMock((command) => {
      if (isFrameGrab(command)) return { writeBytes: 32 };
      return { stdout: '' };
    });
    const analyzer = makeAnalyzer(dir, execImpl);
    const calls = stubAnalyzeVideoDeps(analyzer, dir, { useRealExtractFrames: true });
    analyzer.getVideoDuration = async () => ({ duration: 12.5, durationSource: 'probe', detail: 'format=duration' });
    analyzer.extractKeyframeTimestamps = async () => [0, 5, 10];
    pipelineDurations.length = 0;

    const result = await analyzer.analyzeVideo('https://www.bilibili.com/video/BV1test00001', true);

    equal(calls.visualProbeDurations[0], 12.5, 'extractVisualProbeFrames 收到探测时长');
    equal(calls.audioDurations[0], 12.5, 'extractAudio 收到探测时长');
    equal(pipelineDurations[0], 12.5, 'runSegmentPipeline 收到探测时长');
    equal(result.analysis.duration, 12.5, '返回体 duration 为探测值');
    equal(result.analysis.duration_source, 'probe', '返回体来源没有被换成推导来源');

    cleanupDir(dir);
  });

  await test('时长推导边界：只有 1 个关键帧时间戳且探测失败时仍然抛错，不臆造时长', async () => {
    const dir = makeTempDir('frames-single-ts');
    const videoPath = path.join(dir, 'v.mp4');
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 1));

    const execImpl = createExecMock((command) => {
      if (command.includes('format=duration')) return { stdout: 'N/A\n' };
      if (command.includes('stream=duration')) return { stdout: '\n' };
      if (command.includes('pkt_pts_time')) return { stdout: '42.000\n' };
      return { stdout: '' };
    });

    const analyzer = makeAnalyzer(dir, execImpl);
    let caught = null;
    try {
      await analyzer.extractFrames(videoPath, BV, null);
    } catch (error) {
      caught = error;
    }

    check(Boolean(caught), '只有 1 个时间戳时抛错，不静默拿它当时长');
    check(/无法获取视频时长/.test(caught?.message || ''), '错误信息说明时长缺失', caught?.message);

    cleanupDir(dir);
  });

  // --- 汇总 ---
  console.log('\n========== 测试结果 ==========');
  console.log(`通过断言: ${passed}`);
  console.log(`失败项: ${failures.length}`);
  if (failures.length > 0) {
    console.error('\n失败明细:');
    failures.forEach(item => console.error(`  - ${item}`));
    process.exitCode = 1;
    return;
  }
  console.log('全部通过 ✓');
}

main().catch(error => {
  console.error('测试运行失败:', error);
  process.exitCode = 1;
});
