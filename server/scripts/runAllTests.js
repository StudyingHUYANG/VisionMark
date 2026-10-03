#!/usr/bin/env node
'use strict';

/**
 * 一键全量测试入口（工作项 W2-ZHX-03「自动测试报告」）
 *
 * 背景：仓库里的测试都是纯 node 脚本（无 jest/mocha 等框架），直接
 *   node server/xxx.test.js
 * 运行，各自打印「通过断言: N / 失败项: M」并以退出码表明成败。
 * 本脚本负责：递归发现 -> 逐个执行 -> 汇总成表格 -> 落一份 Markdown 报告。
 *
 * 设计要点（为什么这么做）：
 *
 * 1. 发现规则：递归扫描仓库，只收 **.test.js；必须跳过 node_modules、
 *    dist、.git —— 尤其是 server/node_modules/pstree.remy/tests/index.test.js
 *    这种第三方包自带的测试，它不是本仓库的测试，跑它既没意义还可能污染结果。
 *
 * 2. 每个文件都必须有超时：测试是别人写的任意 node 脚本，可能因为等待网络、
 *    等待 stdin、死循环或未释放的定时器而永远不退出。若没有超时，一个挂住的
 *    文件就会把整轮测试拖死（CI 卡住直到外层超时、报告中什么都看不到）。
 *    所以每个子进程都有独立计时器（默认 180s，--timeout 可覆盖），
 *    超时即杀掉并记为 TIMEOUT（按失败处理）。这正是本项要防的头号问题。
 *
 * 3. 成败判定以退出码为准：各文件输出格式可能不同，但「失败时 exitCode != 0」
 *    是仓库内统一的约定；从输出里提取计数只是"尽力而为"（取不到显示 '-'），
 *    绝不因为提取不到计数就判失败（例如 transcribeAudio.test.js 就没有汇总行）。
 *
 * 4. 报告写盘是尽力而为：报告目录在 .gitignore 中，写不进去（权限/占用）也只
 *    warn，不影响退出码——测试结果本身比报告文件重要。
 *
 * 用法：
 *   node server/scripts/runAllTests.js
 *   node server/scripts/runAllTests.js --filter segmentPipeline/segmentContract
 *   node server/scripts/runAllTests.js --timeout 60000
 *
 * 退出码：全部 PASS 为 0；出现 FAIL / TIMEOUT（或未匹配到任何测试文件）为非 0。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killProcessTree } = require('../utils/killProcessTree');

// 仓库根目录：本文件位于 <repo>/server/scripts/ 下
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPORT_DIR = path.join(REPO_ROOT, 'server', 'debug');

const DEFAULT_TIMEOUT_MS = 180 * 1000;
// 超时后发出杀进程命令，再给一段宽限期等待 close 事件；如果连杀都杀不掉
// （例如子进程处于不可中断状态），宽限期到点也必须放行，否则 runner 自己挂住。
const KILL_GRACE_MS = 10 * 1000;

// 这些目录里的 *.test.js 一律不算本仓库测试（第三方依赖/构建产物/版本库元数据）
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.venv', 'venv', '__pycache__']);

const FAILURE_TAIL_LINES = 30;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`用法: node server/scripts/runAllTests.js [选项]

选项:
  --filter <子串>   只运行路径中包含该子串的测试文件（便于只跑某个子目录）
  --timeout <ms>    单个测试文件的超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）
  -h, --help        显示本帮助
`);
}

function parsePositiveInt(raw, label) {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 需要一个正整数，收到: ${raw}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = { filter: '', timeoutMs: DEFAULT_TIMEOUT_MS, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--filter') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--filter 需要跟一个子串参数');
      options.filter = value.replace(/\\/g, '/'); // Windows 路径反斜杠统一成正斜杠再比对
      i += 1;
    } else if (arg.startsWith('--filter=')) {
      options.filter = arg.slice('--filter='.length).replace(/\\/g, '/');
    } else if (arg === '--timeout') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--timeout 需要跟一个毫秒数');
      options.timeoutMs = parsePositiveInt(value, '--timeout');
      i += 1;
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = parsePositiveInt(arg.slice('--timeout='.length), '--timeout');
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// 测试文件发现
// ---------------------------------------------------------------------------

function discoverTestFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // 排序保证每次运行顺序稳定，报告可对比
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      discoverTestFiles(absPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      // 统一用正斜杠相对路径，便于 --filter 匹配与报告展示
      out.push(path.relative(REPO_ROOT, absPath).split(path.sep).join('/'));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 子进程执行（含超时与杀进程树）
// ---------------------------------------------------------------------------

// 杀进程树统一走 server/utils/killProcessTree（服务层也在用同一份实现）：
// runner 杀的是自己 spawn 的测试子进程，按 PID 定位，与共享工具的语义一致
// （Windows 下 taskkill /pid <pid> /T /F 会带上子孙进程）。
// 注意非 Windows 平台共享工具只杀直接子进程；杀不干净时靠下面的 KILL_GRACE_MS 宽限期兜底，
// runner 自身绝不会因此挂住。

function runOneTest(relPath, timeoutMs) {
  return new Promise((resolve) => {
    const absPath = path.join(REPO_ROOT, relPath);
    const startedAt = Date.now();

    const child = spawn(process.execPath, [absPath], {
      cwd: REPO_ROOT, // 统一以仓库根为工作目录，与手工运行方式一致
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 不再 detached：之前建独立进程组是为了按负 pid 整组杀，现在统一交给 killProcessTree
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killGraceTimer = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      stderr += `\n[runner] 无法启动子进程: ${error.message}\n`;
    });

    // 每个文件独立超时：这是整轮测试不被单个挂死文件拖垮的关键
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      // 宽限期内若 close 还没来（杀不掉），强制放行，runner 绝不能自己挂住
      killGraceTimer = setTimeout(() => finish(null, null), KILL_GRACE_MS);
    }, timeoutMs);

    function finish(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolve({
        relPath,
        code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        output: `${stdout}${stderr}`,
      });
    }

    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ---------------------------------------------------------------------------
// 输出解析：尽力提取「通过 / 失败」计数
// ---------------------------------------------------------------------------

function lastMatch(regex, text) {
  let result = null;
  for (const match of text.matchAll(regex)) result = match;
  return result;
}

/**
 * 仓库内没有统一测试框架，汇总行格式略有差异。
 * 这里做多模式兼容，并且取"最后一次出现"的匹配（结尾的汇总优先于过程日志）。
 * 提取不到返回 null —— 只影响展示，不影响成败判定。
 */
function extractCounts(output) {
  let passed = null;
  let failed = null;

  // 组合形式：「通过 12 / 失败 3」
  const combined = lastMatch(/通过\s*(\d+)\s*[/、,，]\s*失败\s*(\d+)/g, output);
  if (combined) {
    passed = Number(combined[1]);
    failed = Number(combined[2]);
    return { passed, failed };
  }

  const passedMatch =
    lastMatch(/通过断言[:：]\s*(\d+)/g, output) ||
    lastMatch(/通过[:：]?\s*(\d+)\s*(?:项|个|条)?/g, output) ||
    lastMatch(/(\d+)\s*(?:assertions?\s*)?(?:passed|passing)\b/gi, output) ||
    lastMatch(/passed[:：]\s*(\d+)/gi, output);
  if (passedMatch) passed = Number(passedMatch[1]);

  const failedMatch =
    lastMatch(/失败项[:：]\s*(\d+)/g, output) ||
    lastMatch(/失败[:：]?\s*(\d+)\s*(?:项|个|条)?/g, output) ||
    lastMatch(/(\d+)\s*(?:assertions?\s*)?(?:failed|failures?)\b/gi, output) ||
    lastMatch(/failed[:：]\s*(\d+)/gi, output);
  if (failedMatch) failed = Number(failedMatch[1]);

  return { passed, failed };
}

// ---------------------------------------------------------------------------
// 表格与报告
// ---------------------------------------------------------------------------

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    // CJK 汉字/全角标点在等宽终端里占两个字符宽
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  }
  return width;
}

function padCell(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function buildRows(results) {
  return results.map((result) => {
    const counts = extractCounts(result.output);
    let status = 'PASS';
    if (result.timedOut) status = 'TIMEOUT';
    else if (result.code !== 0) status = 'FAIL';

    return {
      file: result.relPath,
      status,
      passed: counts.passed === null ? '-' : String(counts.passed),
      failed: counts.failed === null ? '-' : String(counts.failed),
      duration: formatDuration(result.durationMs),
      result,
    };
  });
}

function renderTable(rows) {
  const headers = ['文件', '结果', '通过', '失败', '耗时'];
  const cells = rows.map((row) => [row.file, row.status, row.passed, row.failed, row.duration]);

  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...cells.map((line) => displayWidth(line[index])))
  );

  const renderLine = (line) => `| ${line.map((cell, i) => padCell(cell, widths[i])).join(' | ')} |`;
  const separator = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`;

  return [renderLine(headers), separator, ...cells.map(renderLine)].join('\n');
}

function tailLines(text, maxLines) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const tail = lines.slice(-maxLines);
  return tail.join('\n').trimEnd();
}

function buildReport({ rows, totals, options, startedAt, finishedAt }) {
  const lines = [];
  lines.push('# 自动测试报告');
  lines.push('');
  lines.push(`- 生成时间: ${finishedAt.toISOString()}`);
  lines.push(`- 仓库根目录: \`${REPO_ROOT}\``);
  lines.push(`- 运行命令: \`node server/scripts/runAllTests.js${options.filter ? ` --filter ${options.filter}` : ''}${options.timeoutMs !== DEFAULT_TIMEOUT_MS ? ` --timeout ${options.timeoutMs}` : ''}\``);
  lines.push(`- 单文件超时: ${options.timeoutMs} ms`);
  lines.push(`- 筛选条件: ${options.filter ? `\`${options.filter}\`` : '（无，全量运行）'}`);
  lines.push(`- 总耗时: ${formatDuration(finishedAt.getTime() - startedAt.getTime())}`);
  lines.push('');
  lines.push('## 结果表');
  lines.push('');
  lines.push(renderTable(rows));
  lines.push('');
  lines.push('## 总计');
  lines.push('');
  lines.push(`- 文件数: ${totals.files}`);
  lines.push(`- PASS: ${totals.pass} / FAIL: ${totals.fail} / TIMEOUT: ${totals.timeout}`);
  lines.push(`- 提取到的通过断言合计: ${totals.passed} / 失败断言合计: ${totals.failed}`);
  lines.push('');

  const failedRows = rows.filter((row) => row.status !== 'PASS');
  if (failedRows.length > 0) {
    lines.push('## 失败文件摘要');
    lines.push('');
    for (const row of failedRows) {
      lines.push(`### ${row.file}（${row.status}，退出码 ${row.result.code === null ? '无' : row.result.code}${row.result.signal ? `，信号 ${row.result.signal}` : ''}）`);
      lines.push('');
      lines.push('```');
      lines.push(tailLines(row.result.output, FAILURE_TAIL_LINES) || '（无输出）');
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function writeReport(content) {
  // 报告写盘是尽力而为：失败只 warn，不影响测试结论与退出码
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const stamp = formatTimestamp(new Date());
    const reportPath = path.join(REPORT_DIR, `test-report-${stamp}.md`);
    fs.writeFileSync(reportPath, content, 'utf8');
    return reportPath;
  } catch (error) {
    console.warn(`[runner] 警告: 写入报告失败（不影响测试结论）: ${error.message}`);
    return null;
  }
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[runner] 参数错误: ${error.message}`);
    return 2;
  }

  if (options.help) {
    printUsage();
    return 0;
  }

  const allFiles = discoverTestFiles(REPO_ROOT);
  const selected = options.filter
    ? allFiles.filter((file) => file.includes(options.filter))
    : allFiles;

  if (selected.length === 0) {
    // 没跑到任何测试不能算"通过"，否则 --filter 写错会静默变绿
    console.error(`[runner] 未匹配到任何 *.test.js 文件（共发现 ${allFiles.length} 个，filter=${options.filter || '无'}）`);
    return 1;
  }

  const startedAt = new Date();
  console.log(`[runner] 发现 ${allFiles.length} 个测试文件，本轮运行 ${selected.length} 个（单文件超时 ${options.timeoutMs} ms）`);
  if (options.filter) console.log(`[runner] 筛选条件: ${options.filter}`);
  console.log('');

  const results = [];
  for (const file of selected) {
    process.stdout.write(`[runner] 运行 ${file} ... `);
    const result = await runOneTest(file, options.timeoutMs);
    results.push(result);
    const counts = extractCounts(result.output);
    const status = result.timedOut ? 'TIMEOUT' : result.code === 0 ? 'PASS' : 'FAIL';
    const counters = `通过=${counts.passed === null ? '-' : counts.passed} 失败=${counts.failed === null ? '-' : counts.failed}`;
    console.log(`${status} (${counters}, ${formatDuration(result.durationMs)})`);
  }

  const rows = buildRows(results);
  const totals = {
    files: rows.length,
    pass: rows.filter((row) => row.status === 'PASS').length,
    fail: rows.filter((row) => row.status === 'FAIL').length,
    timeout: rows.filter((row) => row.status === 'TIMEOUT').length,
    passed: rows.reduce((sum, row) => sum + (row.passed === '-' ? 0 : Number(row.passed)), 0),
    failed: rows.reduce((sum, row) => sum + (row.failed === '-' ? 0 : Number(row.failed)), 0),
  };

  const finishedAt = new Date();

  console.log('');
  console.log('========== 测试汇总 ==========');
  console.log(renderTable(rows));
  console.log('');
  console.log(`文件数: ${totals.files}  通过: ${totals.pass}  失败: ${totals.fail}  超时: ${totals.timeout}`);
  console.log(`提取到的断言计数: 通过 ${totals.passed} / 失败 ${totals.failed}`);
  console.log(`总耗时: ${formatDuration(finishedAt.getTime() - startedAt.getTime())}`);

  const failedRows = rows.filter((row) => row.status !== 'PASS');
  if (failedRows.length > 0) {
    console.log('');
    console.log('========== 失败文件末尾输出 ==========');
    for (const row of failedRows) {
      console.log('');
      console.log(`--- ${row.file}（${row.status}）---`);
      console.log(tailLines(row.result.output, FAILURE_TAIL_LINES) || '（无输出）');
    }
  }

  const reportPath = writeReport(buildReport({ rows, totals, options, startedAt, finishedAt }));
  if (reportPath) {
    console.log('');
    console.log(`[runner] 报告已写入: ${reportPath}`);
  }

  return totals.fail === 0 && totals.timeout === 0 ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error('[runner] 运行器自身异常:', error);
    process.exitCode = 1;
  });
