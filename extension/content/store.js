import { reactive } from 'vue';

// 导出一个全局/单例的 Vue reactive 状态对象
export const videoState = reactive({
    currentTime: 0,
    bvid: null,
    cid: null,
    segments: [], // 分段评价数据
});

// 或者可以导出一个 EventBus（暂不必要，用状态足以触发响应式渲染）
