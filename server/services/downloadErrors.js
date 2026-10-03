const messages = Object.freeze({
  VIDEO_ACCESS_RESTRICTED: '视频下载被 B 站限制（412/风控）。请确认网页能播放，刷新登录状态后稍后重试。',
  VIDEO_LOGIN_REQUIRED: '视频源拒绝访问，请确认 B 站登录状态和该视频的观看权限。',
  VIDEO_NOT_FOUND: '视频不存在或已不可用，请先在网页确认能否播放。',
  DOWNLOAD_TIMEOUT: '视频下载超时，请检查网络后重试。',
  DOWNLOAD_DEPENDENCY_MISSING: '下载器不可用，请检查项目 Python 环境及 yt-dlp 安装。',
  DOWNLOAD_FAILED: '视频下载失败，请检查网络或稍后重试。'
});
function downloadError(error) {
  if (messages[error?.code]) return error;
  const status = Number(error?.status || error?.response?.status);
  const text = String(error?.message || '');
  let code = 'DOWNLOAD_FAILED';
  if ([412,429].includes(status) || /HTTP(?: Error)?[ :]+(?:412|429)\b|Precondition Failed/i.test(text)) code = 'VIDEO_ACCESS_RESTRICTED';
  else if ([401,403].includes(status) || /HTTP(?: Error)?[ :]+(?:401|403)\b/i.test(text)) code = 'VIDEO_LOGIN_REQUIRED';
  else if (status === 404) code = 'VIDEO_NOT_FOUND';
  else if (['ETIMEDOUT','ECONNABORTED'].includes(error?.code) || /timed out/i.test(text)) code = 'DOWNLOAD_TIMEOUT';
  else if (error?.code === 'ENOENT' || /No module named yt_dlp|Unable to create process|not recognized as/i.test(text)) code = 'DOWNLOAD_DEPENDENCY_MISSING';
  return Object.assign(new Error(messages[code]), {code});
}
module.exports = {messages, downloadError};
