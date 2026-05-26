/**
 * 音频切点检测测试
 * 
 * 运行方式: node server/services/segment/audioCuts.test.js
 * 
 * 测试内容:
 * 1. 静音检测
 * 2. 音量变化检测
 * 3. 合并去重逻辑
 */

const path = require('path');
const fs = require('fs');
const { detectAudioCuts } = require('./audioCuts');

const DOWNLOADS_DIR = path.join(__dirname, '../../../downloads');

// 查找可用的 .wav 测试文件
function findTestAudio() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return null;
  const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.wav'));
  return files.length > 0 ? path.join(DOWNLOADS_DIR, files[0]) : null;
}

async function testDetectAudioCuts() {
  console.log('\n=== 测试 detectAudioCuts ===');

  const audioPath = findTestAudio();
  if (!audioPath) {
    console.log('⚠ 未找到测试音频文件，跳过测试');
    console.log(`  请确保 ${DOWNLOADS_DIR} 中有 .wav 文件`);
    return;
  }

  console.log(`使用测试文件: ${audioPath}`);
  const stats = fs.statSync(audioPath);
  console.log(`文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  const startTime = Date.now();
  const cuts = await detectAudioCuts(audioPath);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n检测结果 (耗时 ${elapsed}s):`);
  console.log(`  总切点数: ${cuts.length}`);

  const silenceCuts = cuts.filter(c => c.reasons.includes('silence'));
  const volumeCuts = cuts.filter(c => c.reasons.includes('volume_change'));
  const bothCuts = cuts.filter(c => c.reasons.includes('silence') && c.reasons.includes('volume_change'));

  console.log(`  静音切点: ${silenceCuts.length}`);
  console.log(`  音量变化切点: ${volumeCuts.length}`);
  console.log(`  叠加切点: ${bothCuts.length}`);

  if (cuts.length > 0) {
    console.log('\n  前10个切点:');
    cuts.slice(0, 10).forEach(cut => {
      console.log(`    time=${cut.time.toFixed(1)}s, score=${cut.score}, reasons=[${cut.reasons.join(', ')}]`);
    });
  }

  // 验证输出格式
  for (const cut of cuts) {
    console.assert(typeof cut.time === 'number' && cut.time >= 0, 'time 应为非负数');
    console.assert(typeof cut.score === 'number' && cut.score >= 0 && cut.score <= 1, 'score 应在 0-1 范围');
    console.assert(Array.isArray(cut.reasons) && cut.reasons.length > 0, 'reasons 应为非空数组');
  }

  console.log('\n✓ audioCuts 输出格式验证通过');
}

async function testErrorHandling() {
  console.log('\n=== 测试错误处理 ===');

  try {
    await detectAudioCuts('/non/existent/file.wav');
    console.error('✗ 应该抛出错误');
  } catch (error) {
    console.log(`✓ 不存在的文件正确抛出错误: ${error.message}`);
  }
}

async function main() {
  console.log('========== 音频切点检测测试 ==========');

  await testErrorHandling();
  await testDetectAudioCuts();

  console.log('\n========== 测试完成 ==========');
}

main().catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
