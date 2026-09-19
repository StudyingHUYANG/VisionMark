<template>
  <section class="vm-local-clips">
    <button class="vm-local-clips__toggle" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <strong>我的片段收藏</strong><span>{{ records.length }} {{ expanded ? '⌃' : '⌄' }}</span>
    </button>
    <div v-if="expanded" class="vm-local-clips__content">
      <p>保存在当前浏览器，尚未同步素材库。</p>
      <input v-model="query" aria-label="搜索本地收藏" placeholder="搜索标题、片段介绍、看点或标签" />
      <button type="button" :disabled="!filtered.length" @click="downloadCollection(filtered)">导出当前结果（{{ filtered.length }}）</button>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="!records.length">在精彩片段卡片中点击“收藏片段”，即可在这里跨视频查找。</p>
      <p v-else-if="!filtered.length">没有匹配的收藏，试试其他关键词。</p>
      <article v-for="record in filtered" :key="record.id">
        <a :href="record.source.url" target="_blank" rel="noopener noreferrer">{{ record.title }} ↗</a>
        <small>{{ record.source.title || record.source.bvid }} · {{ formatTime(record.range.start) }}–{{ formatTime(record.range.end) }}</small>
        <p v-if="record.analysis.description">{{ record.analysis.description }}</p>
        <p v-if="record.analysis.highlight"><strong>看点：</strong>{{ record.analysis.highlight }}</p>
        <div class="vm-local-clips__tags"><span v-for="tag in record.tags" :key="tag">{{ tag }}</span></div>
        <small v-if="record.folder">分类：{{ record.folder }}</small>
        <p v-if="record.note">备注：{{ record.note }}</p>
        <button type="button" @click="edit(record)">编辑标签与备注</button>
        <form v-if="editing === record.id" @submit.prevent="commit(record)">
          <label>标题<input v-model="draft.title" maxlength="100" required /></label>
          <label>分类<input v-model="draft.folder" maxlength="60" /></label>
          <label>标签（逗号分隔）<input v-model="draft.tags" maxlength="400" /></label>
          <label>创作备注<textarea v-model="draft.note" maxlength="1000" /></label>
          <button type="submit" :disabled="busy">保存</button>
          <button type="button" @click="editing = null">取消</button>
        </form>
        <div v-if="removing === record.id">
          <span>从本地收藏移除？</span>
          <button type="button" :disabled="busy" @click="remove(record.id)">确认</button>
          <button type="button" @click="removing = null">取消</button>
        </div>
        <button v-else type="button" @click="removing = record.id">移除收藏</button>
      </article>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { listClips, saveClip, removeClip, matchesClip, downloadCollection, COLLECTION_PREFIX } from '../materialCollection.mjs';
const records = ref([]);
const expanded = ref(false);
const query = ref('');
const error = ref('');
const removing = ref(null);
const busy = ref(false);
const editing = ref(null);
const draft = ref({});
let generation = 0;
const filtered = computed(() => records.value.filter(record => matchesClip(record, query.value)));
const formatTime = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
async function reload() {
  const current = ++generation;
  try {
    const next = await listClips();
    if (current === generation) { records.value = next; error.value = ''; }
  } catch (failure) { if (current === generation) error.value = failure.message; }
}
async function remove(id) {
  busy.value = true;
  try { await removeClip(id); removing.value = null; await reload(); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
function edit(record) {
  editing.value = record.id;
  draft.value = { title: record.title, folder: record.folder, tags: record.tags.join('，'), note: record.note };
}
async function commit(record) {
  busy.value = true;
  try { await saveClip(record, draft.value); editing.value = null; await reload(); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
function onStorage(changes, area) {
  if (area === 'local' && Object.keys(changes).some(key => key.startsWith(COLLECTION_PREFIX))) reload();
}
onMounted(() => { reload(); chrome.storage.onChanged.addListener(onStorage); });
onUnmounted(() => { generation += 1; chrome.storage.onChanged.removeListener(onStorage); });
</script>

<style scoped>
.vm-local-clips { margin: 0 16px 12px; border: 1px solid #d6e9ef; border-radius: 12px; background: white; color: #444; font-size: 12px; overflow: hidden; }
.vm-local-clips__toggle { width: 100%; display: flex; justify-content: space-between; padding: 14px; border: 0; background: transparent; color: #0087b3; cursor: pointer; }
.vm-local-clips__content { padding: 0 12px 12px; max-height: 550px; overflow-y: auto; }
.vm-local-clips__content > p { color: #777; }
input { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #ddd; border-radius: 5px; margin-bottom: 8px; font-size: 12px; }
label { display: block; margin-top: 6px; }
textarea { width: 100%; box-sizing: border-box; min-height: 55px; padding: 6px; border: 1px solid #ddd; border-radius: 5px; font: inherit; resize: vertical; }
article { border-top: 1px solid #eee; padding: 12px 0; }
article a { color: #007fa6; text-decoration: none; font-weight: 600; }
small { display: block; color: #888; margin-top: 5px; }
p { line-height: 1.6; overflow-wrap: anywhere; }
button { cursor: pointer; }
.vm-local-clips__content button { padding: 4px 7px; margin-top: 5px; border: 1px solid #cde7ef; border-radius: 4px; background: #f2fafc; color: #007fa6; font-size: 11px; }
button:disabled { opacity: .5; cursor: default; }
.vm-local-clips__tags { display: flex; flex-wrap: wrap; gap: 4px; }
.vm-local-clips__tags span { background: #f1f8fa; border-radius: 5px; padding: 3px 6px; color: #007fa6; }
</style>
