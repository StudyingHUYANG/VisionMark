/** Request cookies from the privileged extension worker, never from page JS. */
async function getBilibiliSession() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({type:'VISIONMARK_BILIBILI_COOKIES'});
  } catch {
    throw new Error('无法连接扩展后台。请在扩展管理页重新加载 VisionMark，然后刷新 B 站页面。');
  }
  if (!response?.ok) {
    throw new Error('无法读取 B 站登录信息。请确认扩展有 B 站网站访问权限，重新加载扩展并刷新页面。');
  }
  return response;
}
async function getBilibiliCookiesForYtDlp() {
  const session = await getBilibiliSession();
  console.log('[VisionMark] B站会话状态:', session.hasSession ? '已获取登录凭据' : '未检测到登录凭据');
  return session.cookies;
}
async function isUserLoggedInToBilibili() {
  return (await getBilibiliSession()).hasSession;
}
window.VisionMarkCookieUtils = {getBilibiliCookiesForYtDlp,isUserLoggedInToBilibili};
