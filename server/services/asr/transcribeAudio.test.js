/**
 * ASR 转写服务测试
 * 
 * 运行方式: node server/services/asr/transcribeAudio.test.js
 * 
 * 测试内容:
 * 1. DashScope 转写（需要 OSS 和 API Key 配置）
 * 2. Whisper 本地转写（需要安装 openai-whisper）
 * 3. 统一入口 fallback 逻辑
 */

const path = require('path');
const fs = require('fs');

// 加载环境变量
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { transcribe } = require('./index');
const { transcribeWithDashScope, parseTranscriptionData } = require('./transcribeAudio');
const { isWhisperAvailable } = require('./whisperFallback');

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

  // 单元测试
  await testParseTranscriptionData();

  // 环境检查
  await testWhisperAvailability();

  // 集成测试
  await testTranscribe();

  console.log('\n========== 测试完成 ==========');
}

main().catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
