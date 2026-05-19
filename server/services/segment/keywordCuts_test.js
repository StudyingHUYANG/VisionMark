// 导入 keywordCuts 模块
const keywordCuts = require('./keywordCuts.js');

// 测试数据：模拟转录文本
const testTranscript = `[0:05] 大家好，我是科技主播
[0:30] 今天要聊的是新产品发布
[1:45] 本期视频由某某公司赞助
[2:30] 这个产品的特点是...
[5:00] 总结一下，这款产品很不错
[5:45] 感谢观看，一键三连`;

console.log('=== 关键词检测系统测试 ===\n');

// 测试1：基础检测
console.log('【测试1】基础关键词检测：');
const results = keywordCuts.detectKeywordCuts(testTranscript);
console.log(JSON.stringify(results, null, 2));

// 测试2：按类型过滤
console.log('\n【测试2】过滤广告相关检测：');
const adResults = keywordCuts.filterDetections(results, 'ad_start', 0.8);
console.log(JSON.stringify(adResults, null, 2));

// 测试3：合并相邻检测
console.log('\n【测试3】合并相邻检测：');
const merged = keywordCuts.mergeNearbyDetections(results, 5);
console.log(JSON.stringify(merged, null, 2));

// 测试4：展示规则库
console.log('\n【测试4】规则库摘要：');
const rulesByType = {};
keywordCuts.KEYWORD_RULES.forEach(rule => {
  if (!rulesByType[rule.type]) {
    rulesByType[rule.type] = [];
  }
  rulesByType[rule.type].push({
    keyword: rule.keyword,
    weight: rule.weight,
    category: rule.category
  });
});
console.log(JSON.stringify(rulesByType, null, 2));

module.exports = {};
