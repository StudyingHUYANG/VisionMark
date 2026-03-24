const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middlewares/auth.js');

// 获取当前用户模型配置
router.get('/', authenticateToken, (req, res) => {
  try {
    const userId = req.user.userId;

    const row = db.prepare(`
      SELECT provider, base_url, model_name, is_enabled, api_key
      FROM user_api_configs
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(userId);

    if (!row) {
      return res.json({
        configured: false,
        data: null
      });
    }

    res.json({
      configured: true,
      data: {
        provider: row.provider,
        baseUrl: row.base_url,
        modelName: row.model_name,
        isEnabled: !!row.is_enabled,
        hasApiKey: !!row.api_key
      }
    });
  } catch (error) {
    console.error('[ModelConfig] 获取配置失败:', error);
    res.status(500).json({ error: '获取配置失败', message: error.message });
  }
});

// 保存/更新当前用户模型配置
router.post('/', authenticateToken, (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      provider = 'qwen',
      apiKey,
      baseUrl,
      modelName,
      isEnabled = true
    } = req.body;

    if (!provider || !baseUrl || !modelName) {
      return res.status(400).json({ error: '缺少必要字段' });
    }

    const existing = db.prepare(`
      SELECT id FROM user_api_configs
      WHERE user_id = ? AND provider = ?
    `).get(userId, provider);

    if (existing) {
      if (apiKey) {
        db.prepare(`
          UPDATE user_api_configs
          SET api_key = ?, base_url = ?, model_name = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND provider = ?
        `).run(apiKey, baseUrl, modelName, isEnabled ? 1 : 0, userId, provider);
      } else {
        db.prepare(`
          UPDATE user_api_configs
          SET base_url = ?, model_name = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND provider = ?
        `).run(baseUrl, modelName, isEnabled ? 1 : 0, userId, provider);
      }
    } else {
      if (!apiKey) {
        return res.status(400).json({ error: '新建配置时必须提供 apiKey' });
      }

      db.prepare(`
        INSERT INTO user_api_configs (
          user_id, provider, api_key, base_url, model_name, is_enabled
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, provider, apiKey, baseUrl, modelName, isEnabled ? 1 : 0);
    }

    res.json({ success: true, message: '配置保存成功' });
  } catch (error) {
    console.error('[ModelConfig] 保存配置失败:', error);
    res.status(500).json({ error: '保存配置失败', message: error.message });
  }
});

router.post('/test', authenticateToken, async (req, res) => {
  try {
    const {
      provider = 'qwen',
      apiKey,
      baseUrl,
      modelName
    } = req.body;

    const systemDefaultKey = process.env.QWEN_API_KEY || 'sk-df7f07a45dee431fb8cc9b6453df5f34';
    const finalApiKey = apiKey || systemDefaultKey;

    if (!provider || !baseUrl || !modelName) {
      return res.status(400).json({ error: '缺少必要字段' });
    }

    if (!finalApiKey) {
      return res.status(400).json({ error: '缺少 apiKey，且系统默认 key 不存在' });
    }

    if (provider !== 'qwen') {
      return res.status(400).json({ error: '当前仅支持 qwen' });
    }

    const OpenAI = require('openai');

    const client = new OpenAI({
      apiKey: finalApiKey,
      baseURL: baseUrl
    });

    const result = await client.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'user', content: '请只回复：连接成功' }
      ],
      max_tokens: 20
    });

    res.json({
      success: true,
      message: '连接成功',
      reply: result.choices?.[0]?.message?.content || ''
    });
  } catch (error) {
    console.error('[ModelConfig] 测试连接失败:', error);
    res.status(500).json({
      success: false,
      error: '测试连接失败',
      message: error.message
    });
  }
});

module.exports = router;