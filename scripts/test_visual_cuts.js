const path = require('path');
const {
  analyzeVisualCuts,
  framesFromTimestampedDirectory
} = require('../server/services/visualCutDetector');

const DEFAULT_DIRS = [
  'downloads/BV18u4y1379b_frames',
  'downloads/BV19JAuz3EyG_frames',
  'downloads/BV1tjDFBuEpV_frames',
  'downloads/BV1frwQzAE9Q_frames',
  'downloads/BV1M14y117yV_frames'
];

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minute = Math.floor(total / 60);
  const second = total % 60;
  return `${minute}:${String(second).padStart(2, '0')}`;
}

async function run() {
  const inputDirs = process.argv.slice(2);
  const dirs = inputDirs.length > 0 ? inputDirs : DEFAULT_DIRS;

  for (const dir of dirs) {
    const absoluteDir = path.resolve(dir);
    const frames = framesFromTimestampedDirectory(absoluteDir);
    const result = await analyzeVisualCuts(frames, { includeDebug: false });

    console.log(`\n${dir}`);
    console.log(`frames=${result.stats?.frameCount || 0} threshold=${result.stats?.threshold ?? 'n/a'} cuts=${result.visualCuts.length}`);

    if (result.visualCuts.length === 0) {
      console.log('  no visual cuts');
      continue;
    }

    for (const cut of result.visualCuts) {
      const metrics = cut.metrics || {};
      console.log(
        `  ${formatTime(cut.time)} score=${cut.score} method=${cut.method} ` +
        `ssim=${metrics.ssimDiff ?? '-'} hist=${metrics.histDiff ?? '-'} phash=${metrics.phashDiff ?? '-'} ` +
        `reasons=${(cut.reasons || []).join(',')}`
      );
    }
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
