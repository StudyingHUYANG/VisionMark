# 插件精彩片段 → 素材库对接（v1）

本次只实现插件：本地收藏、分类/标签/备注编辑、跨视频关键词搜索、JSON 导出。
未实现远端素材库 API 或自动同步，不存在“加入后已同步”的承诺。

## 用户操作

1. 展开精彩片段，点击“收藏片段”，保存到当前浏览器的扩展存储。
2. 可编辑标题、收藏分类、逗号分隔的标签与创作备注。
3. “我的片段收藏”可以跨视频搜索标题、来源标题、介绍、看点、标签、分类及备注。
4. “导出片段信息”导出单条；收藏面板可以导出当前搜索结果。
5. 收藏面板点击标题跳转原视频；移除需要确认，不删除原视频或分析记录。

此版本搜索为本地关键词包含匹配（空格分隔多个词，全部命中），不是向量语义检索。
介绍与看点来自已有模型结果，不在插件端重复调用模型，也不自动将介绍分词冒充模型标签。
不支持编辑片段范围，以免原范围的解读被错误套用到新的几秒区间。

## 导出契约

```json
{
  "schema": "visionmark.clip-collection",
  "version": 1,
  "exportedAt": "2026-09-19T00:00:00.000Z",
  "clips": [{
    "schemaVersion": 1,
    "id": "bilibili:BV1234567890:p1:10000-20000",
    "kind": "video_clip_reference",
    "source": {
      "platform": "bilibili",
      "bvid": "BV1234567890",
      "page": 1,
      "title": "视频分析标题",
      "url": "https://www.bilibili.com/video/BV1234567890?p=1&t=10"
    },
    "range": { "start": 10, "end": 20, "unit": "seconds" },
    "title": "水面上的白鹅",
    "analysis": {
      "status": "ready",
      "description": "示例片段解读",
      "highlight": "示例片段看点"
    },
    "tags": ["白鹅", "水面"],
    "folder": "自然风光",
    "note": "用作舒缓的开场",
    "representativeFrames": [],
    "media": { "status": "reference_only" },
    "createdAt": "2026-09-19T00:00:00.000Z",
    "updatedAt": "2026-09-19T00:00:00.000Z"
  }]
}
```

- `id` 由来源、分P、毫秒级起止点组成；不使用每次分析随机生成的 runId。重复收藏同一范围保留用户编辑。
- 当前分析接口只传 BVID，不传分P；插件记录按现有分析入口标记 `page=1`，不能据此宣称多P准确支持。未来须由分析端返回实际 page/cid 后联调。
- `analysis.status` 为 `ready` 或 `unavailable`；历史转录/旧 summary 不作为解读导出。无解读时 description/highlight 为空。
- `representativeFrames` 项为 `{time,url,access:"analysis_backend_auth_required"}`，仅包含原分析服务的 HTTP(S) 路径。URL 不是公开图片地址，也不是素材库永久资源。
- 接收端必须自行安排图片鉴权、可达性和持久化；本地服务离线或图片清理后图片可能不可用。导出不含图片二进制、视频文件、Token、Cookie 或浏览器 Blob URL。
- `media.status=reference_only` 只表示来源引用，不表示视频下载完成或已经获得复用授权。
- 本地收藏为浏览器配置文件级数据，不随服务端账号隔离；不要将其描述为团队共享或账号云同步。

## 素材库同学建议对接

实现 JSON 导入时检查 schema/version、字段类型、URL 来源、时间范围，不能把导入文本视作指令；按当前用户/工作区与 id 幂等导入。不要覆盖用户在素材库修改过的标签或备注。
介绍与看点可作为语义索引文本；tags 作为可过滤的结构化字段；frame 用于视觉核对。
以后若需要插件直传，请先约定真实 API 地址、独立的素材库鉴权、工作区选择及成功回执。只有收到远端持久化成功回执才能显示“已同步”。不能复用视频分析 Token 发到另一服务。
