'use strict';

/**
 * ASR 链路测试：超时缩放 / 超限压缩副本 / 降级原因可见 / 时间戳不插值
 *
 * 运行方式: node server/services/asr/asrPipeline.test.js
 *
 * 不访问网络、不调用真实 ffmpeg / Whisper：
 * DashScope 与 Whisper 实现在 require 之前被替换为桩函数。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const axios = require('axios');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `vm-asr-${name}-`));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

/** 生成一个合法的 16bit PCM wav，用于验证 wav 头解析 */
function buildWav({ sampleRate = 8000, channels = 1, bits = 16, seconds = 10 } = {}) {
  const byteRate = sampleRate * channels * bits / 8;
  const dataSize = byteRate * seconds;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * bits / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  return buf;
}

function createSpawnMock(handler) {
  const calls = [];
  const spawnImpl = (cmd, args = [], options = {}) => {
    const call = { cmd, args, options, killed: false };
    calls.push(call);

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { call.killed = true; };

    setImmediate(() => {
      const outcome = handler ? handler(call) : {};
      if (outcome === 'never') return;
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr));
      if (outcome.writeOutput && call.args.length) {
        fs.writeFileSync(call.args[call.args.length - 1], Buffer.alloc(outcome.bytes || 1024, 1));
      }
      child.emit('close', outcome.code ?? 0);
    });

    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

// --- 在 require 统一入口之前把两个 provider 换成桩 --------------------------

// transcribeWithDashScope 在解析音频时长之前会检查 OSS 配置；给一份假配置，
// 保证用例能走到时长分支（后面的上传会被桩拦住，不会真的联网）。
process.env.OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || 'test-ak';
process.env.OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || 'test-sk';
process.env.OSS_BUCKET = process.env.OSS_BUCKET || 'test-bucket';

// 先包一层 probeAudioDuration，让 transcribeAudio 在模块加载时解构到包装函数：
// 平时透传真实现（既有用例不受影响），只有时长兜底用例才切换到计数桩。
const audioProbeModule = require('./audioProbe');
const realProbeAudioDuration = audioProbeModule.probeAudioDuration;
let probeOverride = null;
audioProbeModule.probeAudioDuration = (...args) => (
  probeOverride ? probeOverride(...args) : realProbeAudioDuration(...args)
);

const dashscopeModule = require('./transcribeAudio');
const whisperModule = require('./whisperFallback');

// 保留真实实现：统一入口用例要把它替换成桩，时长兜底用例则直接调真实函数
const realTranscribeWithDashScope = dashscopeModule.transcribeWithDashScope;

let dashscopeImpl = async () => ({ transcript: [], degradations: [] });
let whisperAvailableImpl = async () => false;
let whisperImpl = async () => ({ transcript: [] });

dashscopeModule.transcribeWithDashScope = (...args) => dashscopeImpl(...args);
whisperModule.isWhisperAvailable = (...args) => whisperAvailableImpl(...args);
whisperModule.transcribeWithWhisper = (...args) => whisperImpl(...args);

const { transcribe } = require('./index');
const { prepareUploadAudio, resolvePollTimeoutMs, resolveCompressTimeoutMs, MAX_UPLOAD_BYTES } = dashscopeModule;
const { resolveWhisperTimeoutMs } = whisperModule;
const { probeAudioDuration, readWavDuration } = require('./audioProbe');
const { buildAudioObjectName } = require('../../utils/oss');

/**
 * OSS 回收用例的桩：只替换 ossClient 上的方法，保持 client 对象本身不变
 * （transcribeAudio 在模块加载时解构了 client，换整个对象它看不到）。
 */
function patchOssClientMethods({ put, deleteMethod } = {}) {
  const client = require('../../utils/oss').ossClient;
  const originals = { put: client.put, delete: client.delete };
  if (put) client.put = put;
  if (deleteMethod) client.delete = deleteMethod;
  return {
    restore() {
      client.put = originals.put;
      client.delete = originals.delete;
    }
  };
}

function patchAxiosMethods({ post, get } = {}) {
  const originals = { post: axios.post, get: axios.get };
  if (post) axios.post = post;
  if (get) axios.get = get;
  return {
    restore() {
      axios.post = originals.post;
      axios.get = originals.get;
    }
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  console.log('========== ASR 链路测试 ==========');

  // --- 超时缩放 ---
  await test('轮询超时：按音频时长缩放，不低于 2 分钟', async () => {
    equal(resolvePollTimeoutMs(60), 120000, '短片用下限');
    equal(resolvePollTimeoutMs(3600), 1800000, '1 小时视频 = 时长*0.5');
    equal(resolvePollTimeoutMs(null), 120000, '时长未知用下限');
    check(resolvePollTimeoutMs(3600) > 120000, '长视频不再固定 2 分钟超时');
  });

  await test('压缩超时：同样按时长缩放', async () => {
    equal(resolveCompressTimeoutMs(60), 120000, '短片用下限');
    equal(resolveCompressTimeoutMs(1200), 600000, '20 分钟音频 = 时长*0.5');
  });

  await test('Whisper 超时：按时长放大且不低于 10 分钟', async () => {
    equal(resolveWhisperTimeoutMs(60), 600000, '短片保留下限');
    equal(resolveWhisperTimeoutMs(3600), 3600000, '1 小时音频放大到 1 小时');
  });

  // --- wav 头解析 ---
  await test('时长探测：ffprobe 不可用时按 wav 头算时长', async () => {
    const dir = makeTempDir('wav-header');
    const wavPath = path.join(dir, 'a.wav');
    fs.writeFileSync(wavPath, buildWav({ seconds: 10 }));

    const duration = readWavDuration(wavPath);
    check(Math.abs(duration - 10) < 0.01, 'wav 头解析出 10 秒', String(duration));

    const notWav = path.join(dir, 'a.mp3');
    fs.writeFileSync(notWav, Buffer.alloc(1024, 3));
    equal(readWavDuration(notWav), null, '非 wav 返回 null');

    cleanupDir(dir);
  });

  await test('时长探测：文件不存在时返回 unknown 而不是抛错', async () => {
    const result = probeAudioDuration(path.join(os.tmpdir(), 'definitely-missing-audio.wav'));
    equal(result.duration, null, 'duration 为 null');
    equal(result.source, 'unknown', '来源为 unknown');
  });

  // --- 时长兜底：null 不能被当成 0 秒 ---
  await test('时长兜底：audioDuration=null 时真的调用 probeAudioDuration，而不是当成 0 秒', async () => {
    const dir = makeTempDir('duration-fallback');
    const audioPath = path.join(dir, 'BV1.wav');
    fs.writeFileSync(audioPath, Buffer.alloc(2048, 1));

    // 上传发生在时长解析之后：无论走哪条分支都不联网，先拦住 OSS 上传
    const ossModule = require('../../utils/oss');
    const realPut = ossModule.ossClient.put;
    ossModule.ossClient.put = () => { throw new Error('OSS_PUT_STUB'); };

    try {
      // 1) null：必须回退到现场探测（旧实现 Number(null) === 0 会跳过探测直接当成 0 秒）
      const probeCalls = [];
      probeOverride = (p) => {
        probeCalls.push(p);
        throw new Error('PROBE_STUB');
      };

      let caught = null;
      try {
        await realTranscribeWithDashScope(audioPath, { apiKey: 'test-key', bvid: 'BV1', audioDuration: null });
      } catch (error) {
        caught = error;
      }

      equal(probeCalls.length, 1, 'null 触发了现场时长探测');
      equal(probeCalls[0], audioPath, '探测的是当前音频文件');
      check(/PROBE_STUB/.test(caught?.message || ''), '执行流确实进了探测兜底分支', caught?.message);

      // 2) 对照：显式传入有效时长时不做探测，直接走到上传步骤（被 OSS 桩拦住）
      probeCalls.length = 0;
      let caught2 = null;
      try {
        await realTranscribeWithDashScope(audioPath, { apiKey: 'test-key', bvid: 'BV1', audioDuration: 120 });
      } catch (error) {
        caught2 = error;
      }

      equal(probeCalls.length, 0, '显式传入有效时长时不做现场探测');
      check(/OSS_PUT_STUB/.test(caught2?.message || ''), '有效时长直接进入上传步骤（被 OSS 桩拦住）', caught2?.message);
    } finally {
      probeOverride = null;
      ossModule.ossClient.put = realPut;
      cleanupDir(dir);
    }
  });

  // --- 超限压缩副本 ---
  await test('超限音频：生成压缩副本用于上传，并记录降级原因', async () => {
    const dir = makeTempDir('compress');
    const audioPath = path.join(dir, 'BV1.wav');
    fs.writeFileSync(audioPath, '');
    fs.truncateSync(audioPath, MAX_UPLOAD_BYTES + 5 * 1024 * 1024); // 稀疏文件，秒建

    const spawnImpl = createSpawnMock(() => ({ writeOutput: true, bytes: 2 * 1024 * 1024 }));
    const degradations = [];

    const result = await prepareUploadAudio(audioPath, { bvid: 'BV1', audioDuration: 3600, degradations, spawnImpl });

    equal(result.compressed, true, '标记为压缩副本');
    equal(path.basename(result.uploadPath), 'BV1.asr.mp3', '压缩副本命名可辨识');
    check(result.uploadSize <= MAX_UPLOAD_BYTES, '压缩后低于上传上限');
    equal(spawnImpl.calls.length, 1, '调用了一次 ffmpeg 压缩');
    check(
      spawnImpl.calls[0].args.includes('-ar') && spawnImpl.calls[0].args.includes('16000'),
      '压缩为 16kHz 单声道 mp3'
    );
    equal(degradations.length, 1, '记录了降级原因');
    check(/压缩副本/.test(degradations[0]), '降级原因说明改用了压缩副本', degradations[0]);

    cleanupDir(dir);
  });

  await test('超限音频：小文件不压缩，也不产生降级原因', async () => {
    const dir = makeTempDir('no-compress');
    const audioPath = path.join(dir, 'BV2.wav');
    fs.writeFileSync(audioPath, Buffer.alloc(1024, 1));

    const spawnImpl = createSpawnMock(() => ({}));
    const degradations = [];

    const result = await prepareUploadAudio(audioPath, { bvid: 'BV2', degradations, spawnImpl });

    equal(result.compressed, false, '未压缩');
    equal(result.uploadPath, audioPath, '直接上传原音频');
    equal(degradations.length, 0, '没有降级');
    equal(spawnImpl.calls.length, 0, '没有调用 ffmpeg');
  });

  await test('超限音频：压缩失败会删掉半成品并抛错', async () => {
    const dir = makeTempDir('compress-fail');
    const audioPath = path.join(dir, 'BV3.wav');
    fs.writeFileSync(audioPath, '');
    fs.truncateSync(audioPath, MAX_UPLOAD_BYTES + 1024);

    const compressedPath = path.join(dir, 'BV3.asr.mp3');
    const spawnImpl = createSpawnMock(() => {
      fs.writeFileSync(compressedPath, Buffer.alloc(512, 1)); // 半成品
      return { code: 1, stderr: 'libmp3lame not found' };
    });

    let caught = null;
    try {
      await prepareUploadAudio(audioPath, { bvid: 'BV3', degradations: [], spawnImpl });
    } catch (error) {
      caught = error;
    }

    check(Boolean(caught), '压缩失败时抛错');
    check(/音频压缩失败/.test(caught?.message || ''), '错误信息可读', caught?.message);
    check(!fs.existsSync(compressedPath), '半成品已删除，不会污染下次上传');

    cleanupDir(dir);
  });

  // --- 降级原因可见 ---
  await test('统一入口：DashScope 成功时直接返回，不触发 Whisper', async () => {
    dashscopeImpl = async () => ({
      transcript: [{ start: 0, end: 3, text: '你好' }, { start: 4, end: 8, text: '世界' }],
      degradations: []
    });
    whisperAvailableImpl = async () => {
      throw new Error('不该走到 Whisper');
    };

    const result = await transcribe(path.join(os.tmpdir(), 'no-such-audio.wav'), { bvid: 'test' });

    equal(result.provider, 'dashscope', 'provider 为 dashscope');
    equal(result.transcript.length, 2, '返回全部结果');
    equal(result.degradations.length, 0, '没有降级');
  });

  await test('统一入口：DashScope 的空结果与压缩降级原因都保留下来', async () => {
    dashscopeImpl = async () => ({
      transcript: [],
      degradations: ['音频 120.0MB 超过上传上限，已改用压缩副本']
    });
    whisperAvailableImpl = async () => true;
    whisperImpl = async () => ({ transcript: [{ start: 1, end: 2, text: '本地兜底' }] });

    const result = await transcribe(path.join(os.tmpdir(), 'no-such-audio.wav'), { bvid: 'test' });

    equal(result.provider, 'whisper', '降级到 whisper');
    equal(result.transcript.length, 1, '拿到 whisper 结果');
    check(
      result.degradations.some(note => note.includes('压缩副本')),
      '压缩降级原因没有消失',
      JSON.stringify(result.degradations)
    );
    check(
      result.degradations.some(note => note.includes('DashScope 返回空结果')),
      '空结果原因没有消失',
      JSON.stringify(result.degradations)
    );
  });

  await test('统一入口：DashScope 超时 + Whisper 不可用时原因可追溯', async () => {
    dashscopeImpl = async () => {
      throw new Error('语音识别任务超时（等待 1800s，音频时长 3600s，轮询 900 次）');
    };
    whisperAvailableImpl = async () => false;

    const result = await transcribe(path.join(os.tmpdir(), 'no-such-audio.wav'), { bvid: 'test' });

    equal(result.provider, 'none', '无可用的 provider');
    equal(result.transcript.length, 0, '没有转写结果');
    check(/超时/.test(result.error || ''), 'error 里能看到超时原因', result.error);
    check(
      result.degradations.some(note => note.includes('DashScope 失败') && note.includes('超时')),
      'degradations 里保留超时原因',
      JSON.stringify(result.degradations)
    );
    check(
      result.degradations.some(note => note.includes('Whisper 不可用')),
      'Whisper 不可用也记录在案',
      JSON.stringify(result.degradations)
    );
  });

  // --- 时间戳不插值 ---
  await test('解析结果：含逗号的句子不切分、不造时间戳', async () => {
    const { parseTranscriptionData } = dashscopeModule;
    const result = parseTranscriptionData({
      transcripts: [{
        sentences: [
          { begin_time: 0, end_time: 8000, text: '前半句，后半句' }
        ]
      }]
    });

    equal(result.length, 1, '一句话仍是一条记录');
    equal(result[0].start, 0, 'start 取自 begin_time');
    equal(result[0].end, 8, 'end 取自 end_time');
    equal(result[0].text, '前半句，后半句', '文本保持原样');
  });

  await test('解析结果：时间戳全部来自识别结果本身', async () => {
    const { parseTranscriptionData } = dashscopeModule;
    const result = parseTranscriptionData([
      { begin_time: 12500, end_time: 20000, text: 'A' },
      { begin_time: 61000, end_time: 63000, text: 'B' }
    ]);

    equal(result[0].start, 12.5, '毫秒转秒');
    equal(result[1].start, 61, '毫秒转秒');
    check(!result.some(item => item.start === (12.5 + 61) / 2), '没有插入任何中间时间戳');
  });

  // --- OSS 临时对象用完即删 ---
  await test('OSS 回收：转写成功后删除本次上传的对象', async () => {
    const dir = makeTempDir('oss-reclaim-success');
    const audioPath = path.join(dir, 'BVOSS1.wav');
    fs.writeFileSync(audioPath, buildWav({ seconds: 2 }));

    const putCalls = [];
    const deleteCalls = [];
    const ossPatch = patchOssClientMethods({
      put: async (name) => { putCalls.push(name); return {}; },
      deleteMethod: async (name) => { deleteCalls.push(name); return {}; }
    });
    const axiosPatch = patchAxiosMethods({
      post: async () => ({ data: { output: { task_id: 'task-reclaim-1' } } }),
      get: async () => ({
        data: {
          output: {
            task_status: 'SUCCEEDED',
            results: [{ begin_time: 0, end_time: 1000, transcription_text: '你好' }]
          }
        }
      })
    });

    try {
      const result = await realTranscribeWithDashScope(audioPath, {
        apiKey: 'test-key',
        bvid: 'BVOSS1',
        audioDuration: 120,
        pollIntervalMs: 1
      });

      equal(result.transcript.length, 1, '转写成功返回结果');
      equal(putCalls.length, 1, '只上传一次');
      equal(putCalls[0], buildAudioObjectName('BVOSS1', 'BVOSS1.wav'), '对象名来自统一命名规则');
      equal(deleteCalls.length, 1, '成功路径删除了本次上传的对象');
      equal(deleteCalls[0], putCalls[0], '删除的是精确对象名');
    } finally {
      ossPatch.restore();
      axiosPatch.restore();
      cleanupDir(dir);
    }
  });

  await test('OSS 回收：提交任务失败也删除已上传对象', async () => {
    const dir = makeTempDir('oss-reclaim-submit-fail');
    const audioPath = path.join(dir, 'BVOSS2.wav');
    fs.writeFileSync(audioPath, buildWav({ seconds: 2 }));

    const putCalls = [];
    const deleteCalls = [];
    const ossPatch = patchOssClientMethods({
      put: async (name) => { putCalls.push(name); return {}; },
      deleteMethod: async (name) => { deleteCalls.push(name); return {}; }
    });
    const axiosPatch = patchAxiosMethods({
      post: async () => { throw new Error('SUBMIT_BOOM'); },
      get: async () => { throw new Error('提交都失败了，不该走到轮询'); }
    });

    try {
      let caught = null;
      try {
        await realTranscribeWithDashScope(audioPath, {
          apiKey: 'test-key',
          bvid: 'BVOSS2',
          audioDuration: 120,
          pollIntervalMs: 1
        });
      } catch (error) {
        caught = error;
      }

      check(/SUBMIT_BOOM/.test(caught?.message || ''), '提交失败的原始错误向上传递', caught?.message);
      equal(putCalls.length, 1, '上传已完成');
      equal(deleteCalls.length, 1, '提交失败后仍然删除了对象');
      equal(deleteCalls[0], putCalls[0], '删除的是刚上传的那个对象');
    } finally {
      ossPatch.restore();
      axiosPatch.restore();
      cleanupDir(dir);
    }
  });

  await test('OSS 回收：我们自己超时放弃时也删除已上传对象', async () => {
    const dir = makeTempDir('oss-reclaim-timeout');
    const audioPath = path.join(dir, 'BVOSS3.wav');
    fs.writeFileSync(audioPath, buildWav({ seconds: 2 }));

    const putCalls = [];
    const deleteCalls = [];
    const ossPatch = patchOssClientMethods({
      put: async (name) => { putCalls.push(name); return {}; },
      deleteMethod: async (name) => { deleteCalls.push(name); return {}; }
    });
    const axiosPatch = patchAxiosMethods({
      post: async () => ({ data: { output: { task_id: 'task-reclaim-timeout' } } }),
      get: async () => ({ data: { output: { task_status: 'RUNNING' } } })
    });

    try {
      let caught = null;
      try {
        await realTranscribeWithDashScope(audioPath, {
          apiKey: 'test-key',
          bvid: 'BVOSS3',
          audioDuration: 120,
          pollIntervalMs: 1,
          timeoutMs: 5
        });
      } catch (error) {
        caught = error;
      }

      check(/超时/.test(caught?.message || ''), '超时放弃会抛错', caught?.message);
      equal(deleteCalls.length, 1, '放弃等待后删除了对象，不会留在 OSS 上计费');
      equal(deleteCalls[0], putCalls[0], '删除的是本次上传的对象');
    } finally {
      ossPatch.restore();
      axiosPatch.restore();
      cleanupDir(dir);
    }
  });

  await test('OSS 回收：删除失败只 warn，不影响转写结果', async () => {
    const dir = makeTempDir('oss-reclaim-delete-fail');
    const audioPath = path.join(dir, 'BVOSS4.wav');
    fs.writeFileSync(audioPath, buildWav({ seconds: 2 }));

    const putCalls = [];
    const deleteCalls = [];
    const ossPatch = patchOssClientMethods({
      put: async (name) => { putCalls.push(name); return {}; },
      deleteMethod: async (name) => { deleteCalls.push(name); throw new Error('DELETE_BOOM'); }
    });
    const axiosPatch = patchAxiosMethods({
      post: async () => ({ data: { output: { task_id: 'task-reclaim-4' } } }),
      get: async () => ({
        data: {
          output: {
            task_status: 'SUCCEEDED',
            results: [{ begin_time: 0, end_time: 1000, transcription_text: '你好' }]
          }
        }
      })
    });

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

    try {
      const result = await realTranscribeWithDashScope(audioPath, {
        apiKey: 'test-key',
        bvid: 'BVOSS4',
        audioDuration: 120,
        pollIntervalMs: 1
      });

      equal(result.transcript.length, 1, '删除失败不影响 transcribe 返回结果');
      equal(deleteCalls.length, 1, '确实尝试过删除');
      check(
        warnings.some(line => line.includes('DELETE_BOOM')),
        '删除失败被 warn 记录',
        JSON.stringify(warnings)
      );
    } finally {
      console.warn = originalWarn;
      ossPatch.restore();
      axiosPatch.restore();
      cleanupDir(dir);
    }
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
