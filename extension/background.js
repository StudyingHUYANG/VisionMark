// Cookies API is only available in privileged extension contexts.
// This worker accepts requests only from this extension's Bilibili video tabs.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'VISIONMARK_BILIBILI_COOKIES') return false;
  let allowed = false;
  try {
    const url = new URL(sender.url);
    allowed = sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id)
      && sender.frameId === 0 && url.protocol === 'https:'
      && url.hostname === 'www.bilibili.com' && url.pathname.startsWith('/video/');
  } catch {}
  if (!allowed) {
    sendResponse({ok:false,code:'COOKIE_SOURCE_DENIED'});
    return false;
  }
  (async () => {
    try {
      const stores = await chrome.cookies.getAllCookieStores();
      const store = stores.find(item => item.tabIds.includes(sender.tab.id));
      if (!store) throw new Error('Cookie store unavailable');
      const now = Date.now()/1000;
      const cookies = (await chrome.cookies.getAll({domain:'bilibili.com',storeId:store.id}))
        .filter(cookie => {
          const domain = cookie.domain.replace(/^\./,'');
          return (domain === 'bilibili.com' || domain.endsWith('.bilibili.com'))
            && (!cookie.expirationDate || cookie.expirationDate > now)
            && !cookie.partitionKey
            && !/[\r\n\t]/.test(cookie.name + cookie.value + cookie.path);
        });
      const lines = cookies.map(cookie => {
        const domain = cookie.hostOnly ? cookie.domain.replace(/^\./,'') : '.'+cookie.domain.replace(/^\./,'');
        return [domain,cookie.hostOnly?'FALSE':'TRUE',cookie.path||'/',cookie.secure?'TRUE':'FALSE',
          cookie.expirationDate?Math.floor(cookie.expirationDate):0,cookie.name,cookie.value].join('\t');
      });
      sendResponse({ok:true,hasSession:cookies.some(cookie=>cookie.name==='SESSDATA' && cookie.value),
        cookies:lines.length?'# Netscape HTTP Cookie File\n'+lines.join('\n')+'\n':null});
    } catch {
      sendResponse({ok:false,code:'COOKIE_READ_FAILED'});
    }
  })();
  return true; // Keep the asynchronous response channel alive.
});
