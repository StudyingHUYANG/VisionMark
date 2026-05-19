/**
 * 关键词检测系统 - 临时文件
 * 用于从视频转录文本中检测广告、总结等关键切割点
 */

/**
 * 关键词规则库
 * 包含三类关键词：广告关键词、结构性关键词、边界提示词
 */
const KEYWORD_RULES = [
  // ========== 广告关键词 ==========
  // 广告开始标志
  {
    keyword: "本期视频由",
    type: "ad_start",
    weight: 0.95,
    category: "广告"
  },
  {
    keyword: "本视频由",
    type: "ad_start",
    weight: 0.95,
    category: "广告"
  },
  {
    keyword: "感谢赞助",
    type: "ad_start",
    weight: 0.9,
    category: "广告"
  },
  {
    keyword: "感谢",
    type: "ad_start",
    weight: 0.7,
    category: "广告"
  },
  {
    keyword: "赞助",
    type: "ad_start",
    weight: 0.85,
    category: "广告"
  },
  {
    keyword: "推广",
    type: "ad_start",
    weight: 0.85,
    category: "广告"
  },
  {
    keyword: "广告",
    type: "ad_start",
    weight: 0.9,
    category: "广告"
  },

  // 广告结束标志
  {
    keyword: "好了，回到",
    type: "ad_end",
    weight: 0.95,
    category: "广告"
  },
  {
    keyword: "回到正题",
    type: "ad_end",
    weight: 0.95,
    category: "广告"
  },
  {
    keyword: "回到我们",
    type: "ad_end",
    weight: 0.9,
    category: "广告"
  },
  {
    keyword: "好了，我们",
    type: "ad_end",
    weight: 0.85,
    category: "广告"
  },

  // ========== 结构性关键词 ==========
  // 总结/概括
  {
    keyword: "总结一下",
    type: "summary_start",
    weight: 0.9,
    category: "结构"
  },
  {
    keyword: "总结",
    type: "summary_start",
    weight: 0.8,
    category: "结构"
  },
  {
    keyword: "概括一下",
    type: "summary_start",
    weight: 0.85,
    category: "结构"
  },
  {
    keyword: "最后总结",
    type: "summary_start",
    weight: 0.9,
    category: "结构"
  },

  // 结尾标志
  {
    keyword: "感谢观看",
    type: "outro",
    weight: 0.95,
    category: "结构"
  },
  {
    keyword: "谢谢观看",
    type: "outro",
    weight: 0.95,
    category: "结构"
  },
  {
    keyword: "再见",
    type: "outro",
    weight: 0.85,
    category: "结构"
  },
  {
    keyword: "点赞分享",
    type: "outro",
    weight: 0.8,
    category: "结构"
  },
  {
    keyword: "一键三连",
    type: "outro",
    weight: 0.85,
    category: "结构"
  },

  // ========== 边界提示词 ==========
  // 话题转换
  {
    keyword: "下面我们讨论",
    type: "topic_transition",
    weight: 0.8,
    category: "边界"
  },
  {
    keyword: "接下来",
    type: "topic_transition",
    weight: 0.7,
    category: "边界"
  },
  {
    keyword: "现在让我们",
    type: "topic_transition",
    weight: 0.75,
    category: "边界"
  },
  {
    keyword: "那么",
    type: "topic_transition",
    weight: 0.6,
    category: "边界"
  },

  // 强调/过渡
  {
    keyword: "特别提醒",
    type: "important_mark",
    weight: 0.85,
    category: "边界"
  },
  {
    keyword: "注意",
    type: "important_mark",
    weight: 0.7,
    category: "边界"
  },
  {
    keyword: "重点",
    type: "important_mark",
    weight: 0.75,
    category: "边界"
  }
];

/**
 * 从转录文本中提取时间戳信息
 * 转录格式：[m:ss] 文本内容
 * @param {string} transcript - 转录文本
 * @returns {Array} [{text, time}, ...]
 */
function parseTranscriptWithTimestamps(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return [];
  }

  const segments = [];
  const lines = transcript.split('\n');

  for (const line of lines) {
    // 匹配 [m:ss] 或 [mm:ss] 格式
    const timeMatch = line.match(/^\[(\d{1,2}):(\d{2})\]\s+(.+)$/);
    if (timeMatch) {
      const minutes = parseInt(timeMatch[1], 10);
      const seconds = parseInt(timeMatch[2], 10);
      const time = minutes * 60 + seconds;
      const text = timeMatch[3];

      segments.push({ text, time });
    }
  }

  return segments;
}

/**
 * 计算关键词匹配分数
 * 基于编辑距离进行模糊匹配
 * @param {string} text - 要检测的文本
 * @param {string} keyword - 关键词
 * @returns {number} 匹配分数 0-1
 */
function calculateMatchScore(text, keyword) {
  if (!text || !keyword) return 0;

  const textLower = text.toLowerCase();
  const keywordLower = keyword.toLowerCase();

  // 完全匹配
  if (textLower.includes(keywordLower)) {
    return 1.0;
  }

  // 模糊匹配：检查关键词中的每个字是否都在文本中出现（顺序相同）
  let keywordIndex = 0;
  let textIndex = 0;
  let matches = 0;

  while (textIndex < textLower.length && keywordIndex < keywordLower.length) {
    if (textLower[textIndex] === keywordLower[keywordIndex]) {
      matches++;
      keywordIndex++;
    }
    textIndex++;
  }

  // 如果至少匹配了关键词的 60%，返回相应分数
  const matchRatio = matches / keywordLower.length;
  return matchRatio >= 0.6 ? matchRatio * 0.8 : 0; // 模糊匹配最多 0.8 分
}

/**
 * 检测转录文本中的关键词切割点
 * @param {string} transcript - 带时间戳的转录文本
 * @param {Array} customRules - 自定义规则库（可选，默认使用内置规则）
 * @returns {Array} 检测结果
 */
function detectKeywordCuts(transcript, customRules = null) {
  const rules = customRules || KEYWORD_RULES;
  const segments = parseTranscriptWithTimestamps(transcript);
  const detections = [];

  if (segments.length === 0) {
    return [];
  }

  // 对每个转录段进行关键词匹配
  for (const segment of segments) {
    const { text, time } = segment;

    for (const rule of rules) {
      // 计算匹配分数
      const matchScore = calculateMatchScore(text, rule.keyword);

      // 只有匹配分数 > 0.5 才认为是有效匹配
      if (matchScore > 0.5) {
        // 综合分数 = 匹配分数 * 规则权重
        const finalScore = matchScore * rule.weight;

        detections.push({
          time,
          score: Number(finalScore.toFixed(3)),
          reasons: [`keyword:${rule.keyword}`, `match:${(matchScore * 100).toFixed(0)}%`],
          type: rule.type,
          category: rule.category || "未分类",
          confidence: Number((finalScore * 100).toFixed(1)) // 置信度百分比
        });
      }
    }
  }

  // 按时间排序
  detections.sort((a, b) => a.time - b.time);

  return detections;
}

/**
 * 合并相邻的相同类型检测结果
 * 避免在同一时间附近出现重复检测
 * @param {Array} detections - 检测结果
 * @param {number} timeWindow - 时间窗口（秒）
 * @returns {Array} 合并后的检测结果
 */
function mergeNearbyDetections(detections, timeWindow = 5) {
  if (detections.length === 0) return [];

  const merged = [];
  let currentGroup = [detections[0]];

  for (let i = 1; i < detections.length; i++) {
    const current = detections[i];
    const lastInGroup = currentGroup[currentGroup.length - 1];

    // 如果在时间窗口内且类型相同，加入当前组
    if (
      Math.abs(current.time - lastInGroup.time) <= timeWindow &&
      current.type === lastInGroup.type
    ) {
      currentGroup.push(current);
    } else {
      // 输出当前组中得分最高的
      const best = currentGroup.reduce((a, b) => a.score > b.score ? a : b);
      merged.push(best);
      currentGroup = [current];
    }
  }

  // 处理最后一组
  if (currentGroup.length > 0) {
    const best = currentGroup.reduce((a, b) => a.score > b.score ? a : b);
    merged.push(best);
  }

  return merged;
}

/**
 * 按类型和得分过滤检测结果
 * @param {Array} detections - 检测结果
 * @param {string} typeFilter - 按类型过滤（可选）
 * @param {number} minScore - 最低分数阈值（0-1）
 * @returns {Array} 过滤后的结果
 */
function filterDetections(detections, typeFilter = null, minScore = 0.5) {
  return detections.filter(d => {
    if (typeFilter && d.type !== typeFilter) return false;
    if (d.score < minScore) return false;
    return true;
  });
}

module.exports = {
  KEYWORD_RULES,
  detectKeywordCuts,
  mergeNearbyDetections,
  filterDetections,
  parseTranscriptWithTimestamps,
  calculateMatchScore
};
