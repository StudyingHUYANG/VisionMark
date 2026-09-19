<template>
  <div class="vm-collect">
    <div class="vm-collect__actions">
      <button type="button" :disabled="busy || !record" @click="collect">{{ saved ? '编辑收藏' : '＋ 收藏片段' }}</button>
      <button type="button" :disabled="!record || busy" @click="exportClip">导出片段信息</button>
      <a v-if="record" :href="record.source.url" target="_blank" rel="noopener noreferrer">原视频 ↗</a>
    </div>
    <span v-if="saved" class="vm-collect__status">已在本地收藏 · 尚未同步素材库</span>
    <form v-if="editing && saved" @submit.prevent="commit">
      <label>片段标题<input v-model="draft.title" maxlength="100" required /></label>
      <label>收藏分类<input v-model="draft.folder" maxlength="60" placeholder="例如：自然风光" /></label>
      <label>搜索标签<input v-model="draft.tags" maxlength="400" placeholder="用逗号分隔，例如：白鹅，水面，宁静" /></label>
      <label>创作备注<textarea v-model="draft.note" maxlength="1000" placeholder="记录你打算如何使用这个片段" /></label>
      <p>保存原片段范围与分析结果；介绍和看点也可在本地收藏中搜索。</p>
      <button type="submit" :disabled="busy">保存修改</button>
      <button type="button" @click="editing = false">收起</button>
    </form>
    <p v-if="message" role="status">{{ message }}</p>
  </div>
</template>

<script setup>
import { ref, watch, onUnmounted } from 'vue';
import { createClipRecord, readClip, saveClip, downloadCollection, COLLECTION_PREFIX } from '../materialCollection.mjs';

const props = defineProps({ clip: Object, bvid: String, videoTitle: String, page: Number });
const record = ref(null);
const saved = ref(null);
const busy = ref(false);
const editing = ref(false);
const message = ref('');
const draft = ref({});
let generation = 0;

watch(() => [props.clip.id, props.bvid, props.page], async () => {
  const current = ++generation;
  saved.value = null;
  record.value = null;
  editing.value = false;
  message.value = '';
  try {
    const next = createClipRecord(props.clip, { bvid: props.bvid, page: props.page,
      videoTitle: props.videoTitle, apiBase: window.LOCAL_CONFIG?.API_BASE || 'http://localhost:8080' });
    record.value = next;
    const existing = await readClip(next.id);
    if (generation === current) saved.value = existing;
  } catch (error) { if (generation === current) message.value = error.message; }
}, { immediate: true });

function openEditor() {
  draft.value = { title: saved.value.title, tags: saved.value.tags.join('，'), folder: saved.value.folder, note: saved.value.note };
  editing.value = true;
}

async function collect() {
  if (saved.value) return openEditor();
  busy.value = true;
  const current = generation;
  try {
    const result = await saveClip(record.value);
    if (current !== generation) return;
    saved.value = result;
    message.value = '已收藏。可补充标签和创作备注。';
    openEditor();
  } catch (error) { if (current === generation) message.value = error.message; }
  finally { busy.value = false; }
}

async function commit() {
  busy.value = true;
  const current = generation;
  try {
    const result = await saveClip(record.value, draft.value);
    if (current !== generation) return;
    saved.value = result;
    editing.value = false;
    message.value = '收藏信息已保存';
  } catch (error) { if (current === generation) message.value = error.message; }
  finally { busy.value = false; }
}

function exportClip() {
  downloadCollection([saved.value || record.value]);
  message.value = '已导出片段信息（不包含视频文件）；可交给素材库导入。';
}

function onStorage(changes, area) {
  const key = COLLECTION_PREFIX + record.value?.id;
  if (area === 'local' && changes[key]) saved.value = changes[key].newValue || null;
}
chrome.storage.onChanged.addListener(onStorage);
onUnmounted(() => { generation += 1; chrome.storage.onChanged.removeListener(onStorage); });
</script>

<style scoped>
.vm-collect { padding: 0 10px 12px; font-size: 11px; color: #666; }
.vm-collect__actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
button, a { border: 1px solid #cde7ef; border-radius: 5px; background: #f2fafc; color: #007fa6; padding: 5px 7px; cursor: pointer; text-decoration: none; font-size: 11px; }
button:disabled { opacity: .5; cursor: default; }
.vm-collect__status { display: block; margin-top: 7px; }
form { margin-top: 10px; }
label { display: block; margin: 7px 0; }
input, textarea { display: block; box-sizing: border-box; width: 100%; border: 1px solid #ddd; border-radius: 4px; padding: 6px; margin-top: 4px; font: inherit; background: white; color: #333; }
textarea { min-height: 56px; resize: vertical; }
p { margin: 6px 0; line-height: 1.5; }
</style>
