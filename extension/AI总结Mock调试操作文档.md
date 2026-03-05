# AI 总结 Mock 调试操作文档（前端本地）

## 1. 目的
在不依赖后端大模型和接口返回的情况下，仅前端本地调试：
- AI 总结展示
- 侧边栏 AI 标题与分析数据渲染

## 2. 相关文件
- `extension/content/config.local.js`：开关配置
- `extension/content/mockAnalysis.js`：Mock 数据内容
- `extension/content/main.js`：触发分析与刷新逻辑

## 3. 首次配置
1. 打开 `extension/content/config.local.js`，确认：

```js
window.LOCAL_CONFIG = {
  API_BASE: 'http://localhost:8080',
  API_VERSION: 'api/v1',
  MOCK_ANALYSIS: true,
  MOCK_ANALYSIS_DELAY_MS: 400,
  MOCK_ANALYSIS_SCENARIO: 'default'
};
```

2. 在项目根目录执行构建：

```powershell
npm run build
```

3. 打开 `chrome://extensions`，找到插件后点击 `Reload`。

## 4. 如何修改 AI 总结内容
打开 `extension/content/mockAnalysis.js`，在 `buildMockAnalysisData` 返回值中修改：
- `title`：侧边栏标题
- `summary`：AI 总结正文
- `tags`：标签（可选）

示例（只改总结最常用）：

```js
return {
  success: true,
  data: {
    bvid,
    title: `本地调试标题 - ${bvid}`,
    summary: '这是我本地前端调试用的 AI 总结文本。',
    ad_segments: segments,
    knowledge_points,
    hot_words,
    analyzed_at: new Date().toISOString()
  }
};
```

改完后必须重新执行 `npm run build`，然后重载扩展。

## 5. 如何触发刷新（只测 AI 总结）
推荐方式（不依赖 `adSkipperDebug`）：

1. 打开任意 B 站视频页（`https://www.bilibili.com/video/*`）。
2. 打开 DevTools Console，执行：

```js
window.dispatchEvent(new Event('visionmark:refresh-ai'));
```

3. 点击页面上的 AI 按钮打开侧边栏，查看 Summary 卡片。

## 6. 如何改不同测试场景
在 `config.local.js` 中切换：
- `MOCK_ANALYSIS_SCENARIO: 'default'`：数据较少
- `MOCK_ANALYSIS_SCENARIO: 'dense'`：数据较密集

## 7. 常见问题排查

### Q1: 看到“暂无总结”
按顺序检查：
1. `MOCK_ANALYSIS` 是否为 `true`。
2. 是否执行了 `npm run build`。
3. 是否在 `chrome://extensions` 里点击了 `Reload`。
4. 是否执行了 `window.dispatchEvent(new Event('visionmark:refresh-ai'))`。

### Q2: 控制台报 `adSkipperDebug is not defined`
这是扩展上下文隔离导致的常见现象。  
直接用事件触发方式即可：

```js
window.dispatchEvent(new Event('visionmark:refresh-ai'));
```

### Q3: 改了 `mockAnalysis.js` 但页面没变化
没有重新构建或未重载扩展。  
每次改 mock 数据后都要执行：
1. `npm run build`
2. `chrome://extensions` -> `Reload`

## 8. 推荐联调流程（固定模板）
1. 改 `mockAnalysis.js` 里的 `summary`
2. `npm run build`
3. 重载扩展
4. 视频页执行刷新事件
5. 打开侧边栏确认展示
