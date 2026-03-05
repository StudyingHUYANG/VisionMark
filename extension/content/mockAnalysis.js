function formatMockTimestamp(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(sec / 60);
  const remainder = sec % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function getMockAnalysisConfig(localConfig = window.LOCAL_CONFIG) {
  const parsedDelay = Number(localConfig?.MOCK_ANALYSIS_DELAY_MS);
  return {
    enabled: Boolean(localConfig?.MOCK_ANALYSIS),
    scenario: String(localConfig?.MOCK_ANALYSIS_SCENARIO || 'default').toLowerCase(),
    delayMs: Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 400
  };
}

export function buildMockAnalysisData(bvid, scenario = 'default') {
  const dense = String(scenario || 'default').toLowerCase() === 'dense';
  const segments = dense
    ? [
      { start_time: 8, end_time: 18, description: '开场赞助片段', highlight: false, ad_type: 'soft_ad' },
      { start_time: 36, end_time: 52, description: '核心观点讲解', highlight: true, ad_type: 'hard_ad' },
      { start_time: 78, end_time: 90, description: '案例拆解片段', highlight: true, ad_type: 'hard_ad' },
      { start_time: 122, end_time: 136, description: '中段推广片段', highlight: false, ad_type: 'soft_ad' }
    ]
    : [
      { start_time: 12, end_time: 22, description: '开场赞助片段', highlight: false, ad_type: 'soft_ad' },
      { start_time: 46, end_time: 62, description: '主要结论片段', highlight: true, ad_type: 'hard_ad' },
      { start_time: 108, end_time: 120, description: '最终回顾片段', highlight: true, ad_type: 'hard_ad' }
    ];

  const knowledgeBase = dense
    ? [
      { t: 20, term: '问题拆解', explanation: '将复杂任务拆分为可执行的子问题。' },
      { t: 41, term: '最小可行方案', explanation: '用最小闭环验证方向是否正确。' },
      { t: 66, term: '反馈闭环', explanation: '通过短反馈循环快速修正执行。' },
      { t: 95, term: '约束条件', explanation: '时间和资源决定了可行边界。' },
      { t: 128, term: '复盘', explanation: '回顾结果并提炼可复用模式。' }
    ]
    : [
      { t: 24, term: '目标函数', explanation: '在选择方法前先定义成功指标。' },
      { t: 58, term: '路径依赖', explanation: '过去的决策会限制当前的选择空间。' },
      { t: 112, term: '边际收益', explanation: '额外投入通常会带来递减收益。' }
    ];

  const knowledge_points = knowledgeBase.map(item => ({
    term: item.term,
    explanation: item.explanation,
    timestamp: formatMockTimestamp(item.t)
  }));

  const hot_words = knowledgeBase.slice(0, 3).map(item => ({
    word: item.term,
    meaning: item.explanation,
    timestamp: formatMockTimestamp(item.t)
  }));

  return {
    success: true,
    data: {
      bvid,
      title: `本地模拟分析 - ${bvid}`,
      tags: ['本地模拟', 'AI', 'VisionMark'],
      summary: '用于测试侧边栏与知识弹幕渲染的本地模拟分析结果。',
      transcript: '',
      ad_segments: segments,
      knowledge_points,
      hot_words,
      analyzed_at: new Date().toISOString()
    }
  };
}

export async function resolveMockAnalysisData(bvid, localConfig = window.LOCAL_CONFIG) {
  const config = getMockAnalysisConfig(localConfig);
  if (!config.enabled) return null;
  await new Promise(resolve => setTimeout(resolve, config.delayMs));
  return buildMockAnalysisData(bvid, config.scenario);
}
