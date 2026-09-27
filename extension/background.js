chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'visionmark:bilibili-cookies') return false;

  let url;
  try {
    url = new URL(sender.url || '');
  } catch {
    sendResponse({ error: 'Invalid sender' });
    return false;
  }
  if (!sender.tab || url.origin !== 'https://www.bilibili.com' || !url.pathname.startsWith('/video/')) {
    sendResponse({ error: 'Sender is not a Bilibili video page' });
    return false;
  }

  chrome.cookies.getAll({ domain: 'bilibili.com' })
    .then(cookies => sendResponse({ cookies: cookies.filter(cookie =>
      cookie.domain === 'bilibili.com' || cookie.domain.endsWith('.bilibili.com')) }))
    .catch(() => sendResponse({ error: 'Cookie access unavailable' }));
  return true;
});
