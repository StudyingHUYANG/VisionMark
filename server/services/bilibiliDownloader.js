const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { downloadError } = require('./downloadErrors');

// Only forward unexpired cookies whose Netscape domain/path cover the API host.
function apiCookieHeader(contents, now = Date.now() / 1000) {
  const cookies = new Map();
  for (let line of String(contents || '').split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.slice(10);
    if (!line || line.startsWith('#')) continue;
    const [domain, subdomains, cookiePath, secure, expiry, name, value] = line.split('\t');
    const host = String(domain).replace(/^\./, '').toLowerCase();
    if (!(host === 'api.bilibili.com' || host === 'bilibili.com' && subdomains === 'TRUE')) continue;
    if (cookiePath !== '/' || !Number.isFinite(Number(expiry)) || Number(expiry) !== 0 && Number(expiry) <= now) continue;
    if (!name || !value || !/^[A-Za-z0-9_\-]+$/.test(name) || /[\r\n;\x00-\x20]/.test(value)) continue;
    cookies.set(name,value);
  }
  return [...cookies].map(([name,value])=>`${name}=${value}`).join('; ');
}
class BilibiliDownloader {
  constructor(options = {}) {
    this.downloadDir = options.downloadDir || path.join(__dirname,'../../downloads');
    this.http = options.httpClient || axios;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve,ms)));
    this.cookie = options.cookiesPath ? apiCookieHeader(fs.readFileSync(options.cookiesPath,'utf8')) : '';
    fs.mkdirSync(this.downloadDir,{recursive:true});
  }
  extractBvid(url) {
    const match = String(url).match(/\bBV[A-Za-z0-9]{10}\b/);
    if (!match) throw new Error('无效 BV 号');
    return match[0];
  }
  async api(endpoint, params) {
    for (let attempt=0; attempt<2; attempt++) {
      try {
        const response = await this.http.get(`https://api.bilibili.com${endpoint}`,{
          params, timeout:15000, maxRedirects:0,
          headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.bilibili.com/',...(this.cookie?{Cookie:this.cookie}:{})}
        });
        if (response.data.code !== 0) {
          const code = Number(response.data.code);
          throw {status: [-412,-352].includes(code)?412:code===-101?401:code===-404?404:500};
        }
        return response.data;
      } catch (error) {
        // Retry only transient transport errors, never access/rate-limit denials.
        if (attempt === 0 && ['ECONNRESET','ETIMEDOUT','ECONNABORTED','EAI_AGAIN'].includes(error.code)) {
          await this.sleep(1000); continue;
        }
        throw downloadError(error);
      }
    }
  }
  async getVideoInfo(bvid) { return (await this.api('/x/web-interface/view',{bvid})).data; }
  async getPlayUrl(bvid,cid) { return this.api('/x/player/playurl',{bvid,cid,qn:64,fnval:0,fnver:0,fourk:0}); }
  async downloadFile(url,outputPath,onProgress) {
    const partial = outputPath + '.part';
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),300000);
    let bytes=0;
    try {
      // Account cookies must never be forwarded to media/CDN hosts.
      const response = await this.http.get(url,{responseType:'stream',timeout:30000,signal:controller.signal,
        headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.bilibili.com/'}});
      const length = Number(response.headers['content-length']);
      response.data.on('data',chunk=>{
        bytes+=chunk.length;
        if(onProgress && length>0) onProgress({stage:'download',percent:5+Math.min(14,bytes/length*14),message:'正在下载视频'});
      });
      await pipeline(response.data,fs.createWriteStream(partial),{signal:controller.signal});
      if(bytes===0 || length>0 && bytes!==length) throw new Error('Incomplete video');
      fs.renameSync(partial,outputPath);
    } catch(error) {
      fs.rmSync(partial,{force:true});
      throw downloadError(controller.signal.aborted?{code:'ETIMEDOUT'}:error);
    } finally {clearTimeout(timer);}
  }
  async downloadVideo(url,onProgress) {
    const bvid=this.extractBvid(url),output=path.join(this.downloadDir,`${bvid}.mp4`);
    if(fs.existsSync(output) && fs.statSync(output).size>0) {
      onProgress?.({stage:'download',percent:20,message:'使用已下载视频'}); return output;
    }
    onProgress?.({stage:'prepare',percent:5,message:'获取视频信息'});
    const info=await this.getVideoInfo(bvid);
    const cid=info?.pages?.[0]?.cid;
    if(!cid)throw downloadError(new Error('Missing cid'));
    const result=await this.getPlayUrl(bvid,cid);
    // Multi-part/DASH needs yt-dlp; never silently return only the first part.
    if(result.data?.durl?.length!==1)throw downloadError(new Error('Unsupported stream layout'));
    await this.downloadFile(result.data.durl[0].url,output,onProgress);
    onProgress?.({stage:'download',percent:20,message:'视频下载完成'});
    return output;
  }
}
module.exports=BilibiliDownloader;
module.exports.apiCookieHeader=apiCookieHeader;
