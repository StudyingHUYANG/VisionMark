const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken, checkContributor } = require('../middlewares/auth');
const { ApiError } = require('../middlewares/errors');
const validate = require('../middlewares/validation');
router.use(authenticateToken);
function safeParseContent(contentJson) {
  try {
    return contentJson ? (JSON.parse(contentJson) || {}) : {};
  } catch (error) {
    return {};
  }
}

function extractLegacyAdSegments(content) {
  if (!content) return [];

  // 新结构：content_analysis.ad_segments
  if (
    content.content_analysis &&
    Array.isArray(content.content_analysis.ad_segments)
  ) {
    return content.content_analysis.ad_segments;
  }

  // 兼容旧结构：ad_marks
  if (Array.isArray(content.ad_marks)) {
    return content.ad_marks;
  }

  // 更旧结构：ad_segments 直接挂在根上
  if (Array.isArray(content.ad_segments)) {
    return content.ad_segments;
  }

  // 更旧结构：segments
  if (Array.isArray(content.segments)) {
    return content.segments;
  }

  return [];
}

function inferPopupAction(segment) {
  if (!segment || typeof segment !== 'object') return false;

  if (typeof segment.action === 'string') {
    const action = segment.action.trim().toLowerCase();
    if (action === 'popup') return true;
    if (action === 'skip') return false;
  }

  const highlightValue = typeof segment.highlight === 'string'
    ? segment.highlight.trim().toLowerCase()
    : segment.highlight;

  if (
    highlightValue === true ||
    highlightValue === 1 ||
    highlightValue === '1' ||
    highlightValue === 'true' ||
    highlightValue === 'yes' ||
    highlightValue === 'y' ||
    highlightValue === 'popup' ||
    highlightValue === 'high-energy' ||
    highlightValue === 'high_energy'
  ) {
    return true;
  }

  return false;
}

function pickText(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }

    if (value && typeof value === 'object') {
      const nestedText = pickText(
        value.text,
        value.content,
        value.description,
        value.desc,
        value.explanation,
        value.reason,
        value.note,
        value.summary,
        value.title
      );
      if (nestedText) return nestedText;
    }
  }

  return null;
}

function resolveSegmentContent(segment, annotationRow) {
  return pickText(
    segment?.content,
    segment?.description,
    segment?.desc,
    segment?.explanation,
    segment?.reason,
    segment?.note,
    segment?.text
  );
}

router.get('/', (req, res) => {
  const bvid = validate.bvid(req.query.bvid);


  if (!bvid) return res.json({ segments: [] });

  const video = db.prepare(`
    SELECT * FROM videos WHERE bvid = ?
  `).get(bvid);

  if (!video) return res.json({ segments: [] });

  const allAnnotations = db.prepare(`
    SELECT *
    FROM annotations
    WHERE video_id = ?
    ORDER BY id DESC
  `).all(video.id);

  let ai_title = '';
  let ai_summary = '';
  let knowledge_points = [];
  let hot_words = [];
  let visual_cuts = [];
  let visual_cut_stats = null;
  let keyword_cuts = [];
  let candidateCuts = [];
  let segmentPipeline = null;
  let final_segments = [];
  let material_extraction = null;
  let material_clips = [];

  const aiAnnotation = allAnnotations.find(row => row.source_type === 'AI' && row.annotation_type === 'full_analysis');
  if (aiAnnotation) {
    const content = safeParseContent(aiAnnotation.content_json);
    if (content.meta) {
      ai_title = content.meta.title || aiAnnotation.title || '';
    }
    if (content.content_analysis) {
      ai_summary = content.content_analysis.summary || aiAnnotation.summary || '';
      knowledge_points = content.content_analysis.knowledge_points || [];
      hot_words = content.content_analysis.hot_words || [];
      visual_cuts = content.content_analysis.visual_cuts || [];
      visual_cut_stats = content.content_analysis.visual_cut_stats || null;
      keyword_cuts = content.content_analysis.keyword_cuts || [];
      candidateCuts = content.content_analysis.candidateCuts || [];
      segmentPipeline = content.content_analysis.segmentPipeline || null;
      final_segments = content.content_analysis.segments || [];
      material_extraction = content.content_analysis.material_extraction || null;
      material_clips = content.content_analysis.material_clips || material_extraction?.clips || [];
    }
  }

  // 只保留最新的一条完整AI分析，或者人工标注
  const validAnnotations = allAnnotations.filter(row => {
    if (row.source_type === 'AI' && row.annotation_type === 'full_analysis') {
      return aiAnnotation && row.id === aiAnnotation.id;
    }
    return true; // 保留所有 HUMAN/手工标注
  });

  // 🔥 从 validAnnotations 提取所有广告段，避免同个视频的多次AI分析产生大重负片段
  const segments = validAnnotations
    .flatMap(row => {
      const content = safeParseContent(row.content_json);
      return extractLegacyAdSegments(content).map((seg) => {
        const shouldPopup = inferPopupAction(seg);
        const segmentContent = resolveSegmentContent(seg, row);
        return {
          ...seg,
          action: shouldPopup ? 'popup' : 'skip',
          is_ai_segment: row.source_type === 'AI',
          content: segmentContent,
          description: segmentContent
        };
      });
    })
    .sort((a, b) => a.start_time - b.start_time);

    res.json({
      segments,
      ai_title,
      ai_summary,
      knowledge_points,
      hot_words,
      visual_cuts,
      visual_cut_stats,
      keyword_cuts,
      candidateCuts,
      segmentPipeline,
      final_segments,
      material_extraction,
      material_clips
    });
  });

router.post('/', authenticateToken, (req, res) => {
  const { bvid, cid, start_time, end_time, ad_type = 'soft_ad' } = req.body;
  validate.bvid(bvid);
  if (cid !== undefined && cid !== null) validate.integer(cid, 'cid', undefined, Number.MAX_SAFE_INTEGER);
  if (typeof start_time !== 'number' || typeof end_time !== 'number' || !Number.isFinite(start_time) || !Number.isFinite(end_time) || start_time < 0 || end_time <= start_time || !['soft_ad', 'hard_ad'].includes(ad_type))
    throw new ApiError(400, 'INVALID_SEGMENT', '片段时间必须满足 0 <= start_time < end_time，ad_type 必须合法');
  const userId = req.user.userId;

  const annotationId = db.transaction(() => {
  let video = db.prepare("SELECT id FROM videos WHERE bvid = ?").get(bvid);
  if (!video) {
    const r = db.prepare("INSERT INTO videos (bvid, cid) VALUES (?, ?)").run(bvid, cid || null);
    video = { id: r.lastInsertRowid };
  }

  const username = req.user.username || 'Unknown';

  const result = db.prepare(`
    INSERT INTO annotations (
      video_id,
      source_type,
      submitter_id,
      submitter_name,
      parent_id,
      annotation_type,
      title,
      summary,
      transcript,
      score,
      content_json,
      model_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    video.id,
    'HUMAN',
    userId,
    username,
    null,
    'ad',
    null,
    null,
    null,
    null,
    JSON.stringify({
      meta: {
        bvid,
        title: null
      },
      content_analysis: {
        summary: null,
        transcript: null,
        knowledge_points: [],
        hot_words: [],
        tags: [],
        ad_segments: [
          {
            start_time,
            end_time,
            ad_type
          }
        ]
      }
    }),
    null
  );

  // Award points
  db.prepare("UPDATE user_points SET total_points = total_points + 10 WHERE user_id = ?").run(userId);

  return result.lastInsertRowid;
  })();
  res.json({ id: annotationId, message: '提交成功' });
});

router.get('/user', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const annotations = db.prepare(`
    SELECT * FROM annotations WHERE submitter_id = ? ORDER BY id DESC
  `).all(userId);

  const segments = annotations.flatMap(row => {
    const content = safeParseContent(row.content_json);
    return extractLegacyAdSegments(content).map(seg => ({
      start_time: seg.start_time || 0,
      end_time: seg.end_time || 0,
      description: seg.description || null,
      highlight: !!seg.highlight,
      ad_type: seg.ad_type || 'soft_ad'
    }));
  }).sort((a,b) => a.start_time - b.start_time);

  res.json({ segments });
});


router.get('/video-view', authenticateToken, (req, res) => {
  try {
    const bvid = validate.bvid(req.query.bvid);

    if (!bvid) {
      return res.status(400).json({ error: '缺少bvid参数' });
    }

    const video = db.prepare(`
      SELECT * FROM videos WHERE bvid = ?
    `).get(bvid);

    if (!video) {
      return res.json({
        success: true,
        data: {
          bvid,
          title: null,
          tags: [],
          summary: null,
          transcript: null,
          ad_segments: [],
          visual_cuts: [],
          visual_cut_stats: null,
          knowledge_points: [],
          hot_words: [],
          analyzed_at: null
        }
      });
    }

    const allAnnotations = db.prepare(`
      SELECT *
      FROM annotations
      WHERE video_id = ?
      ORDER BY id DESC
    `).all(video.id);

    const latestAI = allAnnotations.find(row => row.source_type === 'AI') || null;

    const aiContent = latestAI ? safeParseContent(latestAI.content_json) : null;
    const aiAnalysis = aiContent?.content_analysis || {};

    const validAnnotations = allAnnotations.filter(row => {
      if (row.source_type === 'AI' && row.annotation_type === 'full_analysis') {
        return latestAI && row.id === latestAI.id;
      }
      return true;
    });

    // 收集所有广告段，按时间顺序返回
    const allAdSegments = validAnnotations
      .flatMap(row => {
        const content = safeParseContent(row.content_json);
        const segments = extractLegacyAdSegments(content);

        return segments.map(seg => ({
          start_time: typeof seg.start_time === 'number' ? seg.start_time : 0,
          end_time: typeof seg.end_time === 'number' ? seg.end_time : 0,
          description: resolveSegmentContent(seg, row),
          highlight: !!seg.highlight,
          ad_type: seg.ad_type || 'soft_ad',
          is_ai_segment: row.source_type === 'AI'
        }));
      })
      .sort((a, b) => a.start_time - b.start_time);

    const viewData = {
      bvid,
      title: aiContent?.meta?.title || latestAI?.title || null,
      tags: aiAnalysis.tags || [],
      summary: aiAnalysis.summary || latestAI?.summary || null,
      transcript: aiAnalysis.transcript || latestAI?.transcript || null,
      ad_segments: allAdSegments,
      visual_cuts: aiAnalysis.visual_cuts || [],
      visual_cut_stats: aiAnalysis.visual_cut_stats || null,
      knowledge_points: aiAnalysis.knowledge_points || [],
      hot_words: aiAnalysis.hot_words || [],
      analyzed_at: aiAnalysis.analyzed_at || null
    };

    res.json({
      success: true,
      data: viewData
    });
  } catch (error) {
    throw error;
  }
});


router.delete('/:id', checkContributor, (req, res) => {
  db.prepare('DELETE FROM annotations WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: '标注删除成功' });
});
router.post('/batch', (req, res) => {
  const { bvids } = req.body;
  if (!Array.isArray(bvids) || !bvids.length || bvids.length > 50) throw new ApiError(400, 'INVALID_PARAMETER', 'bvids 必须包含 1 至 50 个 BV 号');
  bvids.forEach(validate.bvid);
  const data = {};
  for (const bvid of new Set(bvids)) {
    const rows = db.prepare(`SELECT a.* FROM annotations a JOIN videos v ON v.id=a.video_id WHERE v.bvid=? ORDER BY a.id DESC`).all(bvid);
    const latest = rows.find(r => r.source_type === 'AI' && r.annotation_type === 'full_analysis');
    data[bvid] = rows.filter(r => r.source_type !== 'AI' || r.annotation_type !== 'full_analysis' || r.id === latest?.id)
      .flatMap(r => extractLegacyAdSegments(safeParseContent(r.content_json)).map(segment => ({ ...segment, id: r.id, bvid })));
  }
  res.json({ success: true, data });
});
module.exports = router;
