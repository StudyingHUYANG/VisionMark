/**
 * 统一的子进程收尾：超时/失败时杀掉整棵进程树。
 *
 * 为什么不能只 child.kill()：exec/spawn 起的是 shell 或启动器进程，
 * Windows 下杀启动器不会带走真正干活的进程——python 启动器背后还有解释器，
 * ffmpeg 也会继续跑完。每次超时就泄漏一个孤儿进程，所以按 pid 杀整棵树。
 *
 * spawnImpl / platform 只用于单测注入，调用方不传时行为与原来完全一致。
 */
const { spawnSync } = require('child_process');

function killProcessTree(child, { spawnImpl = spawnSync, platform = process.platform } = {}) {
  if (!child) return;
  try {
    if (platform === 'win32' && child.pid) {
      spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    child.kill('SIGKILL');
  } catch (_) {
    try {
      child.kill();
    } catch (__) {
      // 进程可能已自行退出
    }
  }
}

module.exports = { killProcessTree };
