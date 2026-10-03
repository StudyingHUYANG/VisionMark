'use strict';

/**
 * ASR 转写服务测试
 *
 * 运行方式: node server/services/asr/transcribeAudio.test.js
 *
 * ⚠ 离线铁律：本文件必须在不产生任何真实网络调用的前提下通过。
 *   - 不加载任何 .env：测试绝不读取磁盘上的真实密钥文件；
 *   - 显式清空 OSS 配置，使 hasOssConfig 恒为 false，
 *     transcribeWithDashScope 会在发出任何 HTTP 请求之前以「OSS 未配置」失败；
 *   - 再外加断网铁闸拦截所有 Node http/https 请求：万一将来有人又把配置带进来，
 *     测试会以 NETWORK_BLOCKED / 网络请求计数 > 0 立刻失败，而不是静默联网。
 *
 * 测试内容:
 * 1. parseTranscriptionData 解析（纯函数）
 * 2. Whisper 可用性探测（spawn python 的本地子进程，不访问网络）
 * 3. 统一入口 fallback 逻辑（DashScope 因 OSS 未配置失败 → 尝试本地 Whisper）
 *
 * 已知事实（不在本轮改变测试意图）：若本机安装了 openai-whisper 且 downloads/ 下有
 * .wav，第 3 步会真的启动一次本地 Whisper 转写——耗时长，且 openai-whisper 首次
 * 使用可能自行下载模型权重；那属于 Python 子进程行为，Node 侧 http/https 铁闸拦不住。
 * 本机没有 whisper 时，该分支只会 spawn python、收到 ModuleNotFoundError 后立即返回。
 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 离线保障（必须在 require 被测模块之前执行）
// ---------------------------------------------------------------------------
// 为什么必须显式置空，而不是指望「环境干净」：
//   oss.js 在 require 的那一刻就用这些变量算出 hasOssConfig 并创建 ossClient。
//   只要它们存在（无论是 shell 里 export 的，还是有人把 server/.env 复制到仓库根
//   再被 dotenv 读进来），transcribeAudio 就会真的把音频 put 到 OSS、再请求
//   dashscope.aliyuncs.com：产生真实费用、往对方桶里写对象，而且是否联网取决于
//   跑测试的机器，结果完全不可复现。旧实现 dotenv.config 加载的是 ../../../.env
//   （仓库根），真实配置在 server/.env，根目录没有 .env 纯属巧合——这里不再赌运气。
for (const key of [
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_BUCKET',
  'OSS_REGION',
  // 下边两个不是当前链路的联网开关，但同样是真实密钥：一并清掉，
  // 保证这个测试进程里不存在任何可用的真实凭据。
  'QWEN_API_KEY',
  'DASHSCOPE_API_KEY'
]) {
  delete process.env[key];
}

// 断网铁闸：把所有 Node http/https 请求拦成同步异常并计数。
// 上面删掉 OSS_* 后 hasOssConfig 必然为 false，正常路径根本走不到网络；
// 这层是防未来回归：任何试图联网的改动都会让测试显式失败，而不是真的发请求。
const http = require('http');
const https = require('https');
let networkAttempts = 0;

function makeNetworkTripwire(moduleName, methodName) {
  return function blockedNetworkRequest() {
    networkAttempts += 1;
    const error = new Error(
      `NETWORK_BLOCKED: transcribeAudio.test.js 必须离线运行，`
      + `已拦截第 ${networkAttempts} 次 ${moduleName}.${methodName} 请求`
    );
    error.code = 'NETWORK_BLOCKED';
    throw error;
  };
}

for (const [moduleName, mod] of [['http', http], ['https', https]]) {
  for (const methodName of ['request', 'get']) {
    mod[methodName] = makeNetworkTripwire(moduleName, methodName);
  }
}

const { transcribe } = require('./index');
const { transcribeWithDashScope, parseTranscriptionData } = require('./transcribeAudio');
const { isWhisperAvailable } = require('./whisperFallback');
const { hasOssConfig } = require('../../utils/oss');

const DOWNLOADS_DIR = path.join(__dirname, '../../../downloads');

// 查找一个可用的 .wav 测试文件
function findTestAudio() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return null;
  const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.wav'));
  return files.length > 0 ? path.join(DOWNLOADS_DIR, files[0]) : null;
}

async function testParseTranscriptionData() {
  console.log('\n=== 测试 parseTranscriptionData ===');

  // 格式1测试
  const data1 = {
    transcripts: [{
      sentences: [
        { begin_time: 1000, end_time: 3000, text: '你好世界' },
        { begin_time: 5000, end_time: 8000, text: '这是一段测试' }
      ]
    }]
  };
  const result1 = parseTranscriptionData(data1);
  console.log('格式1:', JSON.stringify(result1, null, 2));
  console.assert(result1.length === 2, '应该有2条记录');
  console.assert(result1[0].start === 1, 'start 应为 1 秒');
  console.assert(result1[0].end === 3, 'end 应为 3 秒');
  console.assert(result1[0].text === '你好世界', 'text 应正确');

  // 格式2测试
  const data2 = {
    transcription_lines: [
      { begin_time: 0, end_time: 2500, text: '第一行' },
      { begin_time: 3000, end_time: 5000, text: '第二行' }
    ]
  };
  const result2 = parseTranscriptionData(data2);
  console.log('格式2:', JSON.stringify(result2, null, 2));
  console.assert(result2.length === 2, '应该有2条记录');

  // 格式3测试
  const data3 = [
    { begin_time: 10000, end_time: 12000, text: '数组格式' }
  ];
  const result3 = parseTranscriptionData(data3);
  console.log('格式3:', JSON.stringify(result3, null, 2));
  console.assert(result3.length === 1, '应该有1条记录');
  console.assert(result3[0].start === 10, 'start 应为 10 秒');

  console.log('✓ parseTranscriptionData 测试通过');
}

async function testWhisperAvailability() {
  console.log('\n=== 测试 Whisper 可用性 ===');
  const available = await isWhisperAvailable();
  console.log(`Whisper 是否可用: ${available}`);
  return available;
}

async function testTranscribe() {
  console.log('\n=== 测试统一转写接口 ===');

  const audioPath = findTestAudio();
  if (!audioPath) {
    console.log('⚠ 未找到测试音频文件，跳过实际转写测试');
    console.log(`  请确保 ${DOWNLOADS_DIR} 中有 .wav 文件`);
    return;
  }

  console.log(`使用测试文件: ${audioPath}`);
  const startTime = Date.now();

  const result = await transcribe(audioPath, {
    bvid: 'test',
    onProgress: (stage, percent) => {
      console.log(`  进度: ${stage} ${percent}%`);
    }
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n转写结果 (耗时 ${elapsed}s):`);
  console.log(`  provider: ${result.provider}`);
  console.log(`  transcript 条数: ${result.transcript.length}`);
  if (result.error) {
    console.log(`  error: ${result.error}`);
  }
  if (result.transcript.length > 0) {
    console.log('  前3条:');
    result.transcript.slice(0, 3).forEach(t => {
      console.log(`    [${t.start.toFixed(1)}s - ${t.end.toFixed(1)}s] ${t.text}`);
    });
  }
}

async function main() {
  console.log('========== ASR 转写服务测试 ==========');

  // 离线前提检查：hasOssConfig 必须为 false，否则 transcribeWithDashScope
  // 会真的上传 OSS / 请求 DashScope。把它钉成硬断言，而不是靠注释和巧合。
  console.log('\n=== 离线铁律检查 ===');
  if (hasOssConfig) {
    throw new Error('OSS 配置未被清空，测试可能联网，拒绝继续运行');
  }
  console.log('✓ hasOssConfig=false，DashScope 分支不可能发出网络请求');

  // 铁闸自检：故意碰一次被拦截的请求，确认铁闸真的生效，而不是一个永远为 0 的摆设。
  // 自检后把计数归零，之后任何计数增长都意味着真实代码路径试图联网。
  let tripwireWorks = false;
  try {
    https.get('https://offline-tripwire.invalid/');
  } catch (error) {
    tripwireWorks = error.code === 'NETWORK_BLOCKED';
  }
  networkAttempts = 0;
  if (!tripwireWorks) {
    throw new Error('断网铁闸未生效，无法保证离线，拒绝继续运行');
  }
  console.log('✓ 断网铁闸自检通过（http/https 请求会被拦截）');

  // 单元测试
  await testParseTranscriptionData();

  // 环境检查
  await testWhisperAvailability();

  // 集成测试
  await testTranscribe();

  // 全程没有 http/https 请求被拦截，才是真正的「离线跑过」
  console.log(`\n网络请求拦截计数: ${networkAttempts}（必须为 0）`);
  if (networkAttempts > 0) {
    throw new Error(`测试期间拦截到 ${networkAttempts} 次网络请求，违反离线铁律`);
  }

  console.log('\n========== 测试完成 ==========');
}

main().catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
