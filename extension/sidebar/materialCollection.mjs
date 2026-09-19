export const COLLECTION_PREFIX = 'visionmark.clip.v1:';

export function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,，、\n]/);
  return [...new Set(values.map(item => String(item).trim().slice(0, 30)).filter(Boolean))].slice(0, 12);
}

export function createClipRecord(clip, { bvid, page = 1, videoTitle = '', apiBase = '' } = {}) {
  const start = Number(clip.startTime);
  const end = Number(clip.endTime);
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid || '') || !Number.isFinite(start) ||
      !Number.isFinite(end) || start < 0 || end <= start) throw new Error('片段来源或时间范围无效');
  page = Math.max(1, Number.parseInt(page, 10) || 1);
  const startMs = Math.round(start * 1000);
  const endMs = Math.round(end * 1000);
  const id = `bilibili:${bvid}:p${page}:${startMs}-${endMs}`;
  const insight = clip.insight?.status === 'ready' && clip.insight?.source === 'model_analysis'
    ? clip.insight : null;
  const now = new Date().toISOString();
  const frames = (clip.representativeFrames || []).slice(0, 3).flatMap(frame => {
    const time = Number(frame.time);
    if (!Number.isFinite(time) || time < start || time > end) return [];
    try {
      const base = new URL(apiBase);
      const url = new URL(frame.url, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin ||
          url.username || url.password || url.search || url.hash ||
          !url.pathname.startsWith(`/video-analysis/material-frames/${bvid}/`)) return [];
      return [{ time, url: url.href, access: 'analysis_backend_auth_required' }];
    } catch (_) { return []; }
  });
  return {
    schemaVersion: 1, id, kind: 'video_clip_reference',
    source: { platform: 'bilibili', bvid, page, title: String(videoTitle).slice(0, 200),
      url: `https://www.bilibili.com/video/${bvid}?p=${page}&t=${Math.floor(start)}` },
    range: { start: startMs / 1000, end: endMs / 1000, unit: 'seconds' },
    title: String(insight?.title || clip.title || '精彩片段').slice(0, 100),
    analysis: { status: insight ? 'ready' : 'unavailable',
      description: String(insight?.description || '').slice(0, 1000),
      highlight: String(insight?.highlight || '').slice(0, 500) },
    tags: [], note: '', folder: '', representativeFrames: frames,
    media: { status: 'reference_only' },
    createdAt: now, updatedAt: now
  };
}

function storageCall(method, argument, chromeApi = globalThis.chrome) {
  return new Promise((resolve, reject) => {
    chromeApi.storage.local[method](argument, result => {
      const error = chromeApi.runtime.lastError;
      if (error) reject(new Error(error.message || '本地收藏保存失败'));
      else resolve(result);
    });
  });
}

export async function readClip(id, chromeApi) {
  const key = COLLECTION_PREFIX + id;
  const data = await storageCall('get', key, chromeApi);
  return data[key] || null;
}

export async function listClips(chromeApi) {
  const data = await storageCall('get', null, chromeApi);
  return Object.entries(data).filter(([key, value]) => key.startsWith(COLLECTION_PREFIX) && value?.schemaVersion === 1)
    .map(([, value]) => value).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveClip(record, edits = {}, chromeApi) {
  const existing = await readClip(record.id, chromeApi);
  // Re-analysis must not overwrite a user's corrections or annotations.
  const saved = { ...record, ...(existing || {}),
    title: String(edits.title ?? existing?.title ?? record.title).trim().slice(0, 100) || '精彩片段',
    tags: normalizeTags(edits.tags ?? existing?.tags ?? record.tags),
    note: String(edits.note ?? existing?.note ?? '').trim().slice(0, 1000),
    folder: String(edits.folder ?? existing?.folder ?? '').trim().slice(0, 60),
    updatedAt: new Date().toISOString()
  };
  await storageCall('set', { [COLLECTION_PREFIX + record.id]: saved }, chromeApi);
  return saved;
}

export function removeClip(id, chromeApi) {
  return storageCall('remove', COLLECTION_PREFIX + id, chromeApi);
}

export function matchesClip(record, query) {
  const haystack = [record.title, record.source.title, record.analysis.description,
    record.analysis.highlight, ...record.tags, record.note, record.folder].join(' ').toLocaleLowerCase();
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

export function serializeCollection(records) {
  // Explicit public fields only: never export Chrome storage, tokens, cookies, or blob URLs.
  return JSON.stringify({ schema: 'visionmark.clip-collection', version: 1,
    exportedAt: new Date().toISOString(), clips: records.map(record => ({
      schemaVersion: record.schemaVersion, id: record.id, kind: record.kind,
      source: record.source, range: record.range, title: record.title,
      analysis: record.analysis, tags: record.tags, note: record.note, folder: record.folder,
      representativeFrames: record.representativeFrames, media: record.media,
      createdAt: record.createdAt, updatedAt: record.updatedAt
    })) }, null, 2);
}

export function downloadCollection(records) {
  const url = URL.createObjectURL(new Blob([serializeCollection(records)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `VisionMark-片段收藏-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
