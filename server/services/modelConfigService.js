const db = require('../database/db');

const DEFAULT_MODEL_CONFIG = Object.freeze({
  provider: 'qwen',
  apiKey: process.env.QWEN_API_KEY || 'sk-df7f07a45dee431fb8cc9b6453df5f34',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  textModel: 'qwen-turbo',
  visionModel: 'qwen-vl-max',
  asrModel: 'paraformer-v2'
});

function normalizeBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function getSystemDefaultModelConfig() {
  return { ...DEFAULT_MODEL_CONFIG };
}

function hasSystemDefaultApiKey() {
  return Boolean(DEFAULT_MODEL_CONFIG.apiKey);
}

function normalizeUserModelConfig(row) {
  if (!row) return null;

  return {
    provider: row.provider || DEFAULT_MODEL_CONFIG.provider,
    apiKey: row.api_key || row.apiKey || '',
    baseUrl: row.base_url || row.baseUrl || DEFAULT_MODEL_CONFIG.baseUrl,
    modelName: row.model_name || row.modelName || DEFAULT_MODEL_CONFIG.visionModel,
    isEnabled: normalizeBoolean(row.is_enabled ?? row.isEnabled, true)
  };
}

function buildEffectiveModelConfig(userConfig = null) {
  const defaults = getSystemDefaultModelConfig();

  if (!userConfig) {
    return defaults;
  }

  return {
    provider: userConfig.provider || defaults.provider,
    apiKey: userConfig.apiKey || defaults.apiKey,
    baseUrl: userConfig.baseUrl || defaults.baseUrl,
    textModel: userConfig.textModel || userConfig.modelName || defaults.textModel,
    visionModel: userConfig.visionModel || userConfig.modelName || defaults.visionModel,
    asrModel: userConfig.asrModel || defaults.asrModel
  };
}

function getLatestUserModelConfig(userId) {
  const row = db.prepare(`
    SELECT provider, api_key, base_url, model_name, is_enabled
    FROM user_api_configs
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(userId);

  return normalizeUserModelConfig(row);
}

function getLatestEnabledUserModelConfig(userId) {
  const row = db.prepare(`
    SELECT provider, api_key, base_url, model_name, is_enabled
    FROM user_api_configs
    WHERE user_id = ? AND is_enabled = 1
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(userId);

  return normalizeUserModelConfig(row);
}

function toClientModelConfigData(config, hasApiKey) {
  return {
    provider: config.provider || DEFAULT_MODEL_CONFIG.provider,
    baseUrl: config.baseUrl || DEFAULT_MODEL_CONFIG.baseUrl,
    modelName: config.modelName || config.visionModel || DEFAULT_MODEL_CONFIG.visionModel,
    isEnabled: normalizeBoolean(config.isEnabled, true),
    hasApiKey: Boolean(hasApiKey)
  };
}

function getModelConfigState(userId) {
  const userConfig = getLatestUserModelConfig(userId);
  const hasCustomConfig = Boolean(userConfig);
  const hasDefaultKey = hasSystemDefaultApiKey();

  let effectiveSource = 'none';
  if (userConfig?.isEnabled && userConfig.apiKey) {
    effectiveSource = 'user_custom';
  } else if (hasDefaultKey) {
    effectiveSource = 'system_default';
  }

  const configured = effectiveSource !== 'none';
  const defaults = getSystemDefaultModelConfig();
  const data = hasCustomConfig
    ? toClientModelConfigData(userConfig, Boolean(userConfig.apiKey))
    : toClientModelConfigData({
        provider: defaults.provider,
        baseUrl: defaults.baseUrl,
        modelName: defaults.visionModel,
        isEnabled: true
      }, hasDefaultKey);

  return {
    configured,
    effectiveSource,
    hasCustomConfig,
    data
  };
}

module.exports = {
  DEFAULT_MODEL_CONFIG,
  buildEffectiveModelConfig,
  getLatestEnabledUserModelConfig,
  getLatestUserModelConfig,
  getModelConfigState,
  getSystemDefaultModelConfig,
  hasSystemDefaultApiKey,
  normalizeUserModelConfig
};
