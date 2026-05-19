# 关键词检测系统 - 实现说明

## 📋 功能概述

关键词检测系统用于从视频转录文本中自动识别关键切割点，支持三类关键词：
- **广告关键词**：识别广告开始/结束
- **结构性关键词**：识别总结、结尾等结构标志
- **边界提示词**：识别话题转换、重要提醒等过渡点

## 📂 文件结构

```
server/
  services/
    segment/
      keywordCuts.js          ← 核心模块（需要创建此目录）
    keywordCuts_temp.js       ← 临时文件（创建完成后删除）
    keywordCuts_test.js       ← 测试示例（可选）
```

## 🚀 使用步骤

### 第一步：创建目录和移动文件

在项目根目录执行：

```bash
cd C:\git_project\VisionMark\server\services
mkdir segment
move keywordCuts_temp.js segment\keywordCuts.js
```

### 第二步：在代码中使用

```javascript
const keywordCuts = require('./services/segment/keywordCuts.js');

// 方式1：使用默认规则库
const detections = keywordCuts.detectKeywordCuts(transcript);

// 方式2：使用自定义规则库
const customRules = [
  { keyword: "自定义词汇", type: "custom_type", weight: 0.8 }
];
const detections = keywordCuts.detectKeywordCuts(transcript, customRules);

// 方式3：过滤结果
const adOnly = keywordCuts.filterDetections(detections, 'ad_start', 0.7);

// 方式4：合并相邻检测
const merged = keywordCuts.mergeNearbyDetections(detections, 5);
```

## 📊 API 文档

### 主函数：`detectKeywordCuts(transcript, customRules)`

**输入**：
- `transcript` (string): 带时间戳的转录文本，格式：`[m:ss] 文本内容`
- `customRules` (Array, 可选): 自定义规则库，默认使用 KEYWORD_RULES

**输出**：
```javascript
[
  {
    time: 103,                          // 时间戳（秒）
    score: 0.855,                       // 综合分数 (0-1)
    confidence: 85.5,                   // 置信度（百分比）
    type: "ad_start",                   // 检测类型
    category: "广告",                   // 规则类别
    reasons: [                          // 检测原因
      "keyword:本期视频由",
      "match:100%"
    ]
  }
]
```

### 辅助函数

#### `mergeNearbyDetections(detections, timeWindow = 5)`
- **功能**：合并时间窗口内的相同类型检测
- **参数**：
  - `detections`: 检测结果数组
  - `timeWindow`: 时间窗口（秒），默认5秒
- **返回**：合并后保留得分最高的检测结果

#### `filterDetections(detections, typeFilter, minScore = 0.5)`
- **功能**：按类型和最低分数过滤
- **参数**：
  - `detections`: 检测结果
  - `typeFilter`: 类型过滤（如 'ad_start'），null 表示不过滤
  - `minScore`: 最低分数阈值
- **返回**：过滤后的结果

#### `parseTranscriptWithTimestamps(transcript)`
- **功能**：解析带时间戳的转录文本
- **输入**：转录文本
- **输出**：`[{text, time}, ...]` 格式

#### `calculateMatchScore(text, keyword)`
- **功能**：计算文本与关键词的匹配分数
- **返回**：0-1 的分数

## 📝 规则库结构

每个规则包含以下字段：

```javascript
{
  keyword: "本期视频由",      // 关键词文本
  type: "ad_start",          // 检测类型（唯一标识）
  weight: 0.95,              // 权重系数 (0-1)
  category: "广告"           // 规则分类
}
```

**权重说明**：
- `0.9-1.0`：高可信度（如"本期视频由"、"感谢观看"）
- `0.7-0.85`：中可信度（如"赞助"、"推广"）
- `0.6-0.7`：低可信度（如"接下来"、"那么"）

## 🧪 测试

运行测试文件验证功能：

```bash
cd C:\git_project\VisionMark
node server/services/keywordCuts_test.js
```

## 📌 当前规则库包含

### 广告类 (ad_start / ad_end)
- 开始：本期视频由、感谢赞助、推广等
- 结束：回到正题、好了回到、回到我们等

### 结构类 (summary_start / outro)
- 总结：总结一下、概括一下等
- 结尾：感谢观看、谢谢观看、一键三连等

### 边界类 (topic_transition / important_mark)
- 转换：接下来、现在让我们、下面我们讨论等
- 强调：特别提醒、注意、重点等

## 🔄 集成到 videoAnalyzer.js

建议在 `server/services/videoAnalyzer.js` 中集成此模块：

```javascript
const keywordCuts = require('./segment/keywordCuts.js');

// 在视频分析流程中使用
async analyzeVideo(url, onProgress) {
  // ... 其他步骤 ...
  
  // 获取转录文本后
  const transcript = await this.extractAudioAndTranscribe(videoPath);
  
  // 运行关键词检测
  const keywordDetections = keywordCuts.detectKeywordCuts(transcript);
  const mergedDetections = keywordCuts.mergeNearbyDetections(keywordDetections);
  
  // 将结果合并到最终输出
  return {
    // ... 其他字段 ...
    keyword_detections: mergedDetections
  };
}
```

## 📈 性能优化建议

1. **缓存规则**：规则库可以预编译以提高查询速度
2. **并行处理**：大文本可分段并行检测
3. **动态权重**：根据视频类型动态调整规则权重
4. **黑名单**：对特定内容类型排除某些规则

## 🛠 未来扩展

- [ ] 支持正则表达式规则
- [ ] 支持上下文感知的权重调整
- [ ] 支持多语言规则库
- [ ] 支持机器学习模型融合
- [ ] 实时规则更新机制

