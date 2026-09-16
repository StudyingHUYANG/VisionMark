const SEGMENTS = [
  { videoId: 'BV_PHONE', segmentId: 'phone-design', start: 0, end: 30, title: '手机外观展示', summary: '主持人展示手机背面和摄像头模组', transcript: '这款手机采用圆形镜头设计' },
  { videoId: 'BV_PHONE', segmentId: 'gaming', start: 30, end: 60, title: '游戏性能测试', summary: '测试游戏帧率、功耗和机身温度', transcript: '连续游戏后帧率稳定' },
  { videoId: 'BV_CAMERA', segmentId: 'night-photo', start: 60, end: 90, title: '夜景拍摄效果', summary: '展示夜间照片和视频的画质', transcript: '暗光下细节清晰' },
  { videoId: 'BV_CAMERA', segmentId: 'day-photo', start: 0, end: 30, title: '白天拍摄效果', summary: '阳光下测试相机色彩', transcript: '白天成像自然' }
];

class FixtureEmbeddingService {
  isReady() { return true; }
  async embedTexts(texts) { return texts.map(text => this.vectorFor(text)); }
  vectorFor(text) {
    const value = String(text);
    const groups = [
      ['外观', '长什么样', '背面', '镜头设计'],
      ['游戏', '性能', '帧率', '温度', '功耗'],
      ['夜', '晚上', '暗光'],
      ['白天', '阳光', '色彩']
    ];
    const vector = groups.map(words => words.reduce((sum, word) => sum + (value.includes(word) ? 1 : 0), 0));
    vector.push(0.01);
    return vector;
  }
}

module.exports = { SEGMENTS, FixtureEmbeddingService };
