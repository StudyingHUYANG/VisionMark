const axios = require('axios');
const fs = require('fs');
const path = require('path');
const searchConfig = require('../config/search');

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  async use(fn) {
    if (this.active >= this.limit) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function imageToDataUri(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
}

/**
 * 封装 DashScope 的 Text Embedding 接口 (text-embedding-v2)
 */
class EmbeddingService {
  constructor(options = {}) {
    if (typeof options === 'string') options = { apiKey: options };
    this.apiKey = options.apiKey || searchConfig.apiKey;
    this.dimension = Number(options.dimension || searchConfig.dimension);
    this.visualModel = options.visualModel || searchConfig.visualModel;
    this.textModel = options.textModel || searchConfig.textModel;
    this.rerankModel = options.rerankModel || searchConfig.rerankModel;
    this.enableRerank = options.enableRerank ?? searchConfig.enableRerank;
    this.http = options.httpClient || axios;
    this.timeoutMs = options.timeoutMs || searchConfig.requestTimeoutMs;
    this.semaphore = new Semaphore(options.concurrency || searchConfig.requestConcurrency);
    this.textApiUrl = `${searchConfig.apiBaseUrl}/services/embeddings/text-embedding/text-embedding`;
    this.multimodalApiUrl = `${searchConfig.apiBaseUrl}/services/embeddings/multimodal-embedding/multimodal-embedding`;
    this.rerankApiUrl = `${searchConfig.apiBaseUrl}/services/rerank/text-rerank/text-rerank`;
  }

  isReady() {
    return !!this.apiKey;
  }

  /**
   * 将文本转为向量
   * @param {string} text 
   * @returns {number[]}
   */
  validateVector(vector, label = '向量') {
    if (!Array.isArray(vector) || vector.length !== this.dimension) {
      throw new Error(`${label}维度异常，期望 ${this.dimension}，实际 ${Array.isArray(vector) ? vector.length : '非数组'}`);
    }
    if (vector.some(value => !Number.isFinite(value))) {
      throw new Error(`${label}包含非有限数值`);
    }
    return vector;
  }

  async requestWithRetry(url, payload) {
    if (!this.isReady()) throw new Error('DASHSCOPE_API_KEY 未配置');
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.semaphore.use(() => this.http.post(url, payload, {
          timeout: this.timeoutMs,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }));
      } catch (error) {
        lastError = error;
        if (attempt < 2) await wait(500 * (2 ** attempt));
      }
    }
    throw lastError;
  }

  async embedVisualText(text) {
    if (!this.isReady()) throw new Error('DASHSCOPE_API_KEY 未配置');
    try {
      const response = await this.requestWithRetry(this.multimodalApiUrl, {
        model: this.visualModel,
        input: { contents: [{ text }] },
        parameters: { dimension: this.dimension }
      });
      const embeddings = response.data?.output?.embeddings || [];
      if (!embeddings.length) throw new Error('未返回多模态文本向量');
      return this.validateVector(embeddings[0].embedding, '多模态文本向量');
    } catch (error) {
      console.error('[Embedding] embedVisualText 失败:', error.response?.data || error.message);
      throw error;
    }
  }

  async embedImages(imagePaths) {
    if (!Array.isArray(imagePaths) || imagePaths.length === 0) return [];
    if (imagePaths.length > 10) throw new Error('单次最多向量化 10 张图片');
    try {
      const response = await this.requestWithRetry(this.multimodalApiUrl, {
        model: this.visualModel,
        input: { contents: imagePaths.map(imagePath => ({ image: imageToDataUri(imagePath) })) },
        parameters: { dimension: this.dimension }
      });
      const embeddings = response.data?.output?.embeddings || [];
      if (embeddings.length !== imagePaths.length) {
        throw new Error(`图片向量数量异常，期望 ${imagePaths.length}，实际 ${embeddings.length}`);
      }
      return [...embeddings]
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
        .map((item, index) => this.validateVector(item.embedding, `图片向量[${index}]`));
    } catch (error) {
      console.error('[Embedding] embedImages 失败:', error.response?.data || error.message);
      throw error;
    }
  }

  async embedTextBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const response = await this.requestWithRetry(this.textApiUrl, {
      model: this.textModel,
      input: { texts },
      parameters: { dimension: this.dimension }
    });
    const embeddings = response.data?.output?.embeddings || [];
    if (embeddings.length !== texts.length) {
      throw new Error(`文本向量数量异常，期望 ${texts.length}，实际 ${embeddings.length}`);
    }
    return [...embeddings]
      .sort((a, b) => Number(a.text_index ?? a.index ?? 0) - Number(b.text_index ?? b.index ?? 0))
      .map((item, index) => this.validateVector(item.embedding, `文本向量[${index}]`));
  }

  async embedTextQuery(text) {
    const [vector] = await this.embedTextBatch([text]);
    return vector;
  }

  async embedText(text) {
    return this.embedVisualText(text);
  }

  async embedLocalImage(_bvid, _timestamp, imagePath) {
    const [vector] = await this.embedImages([imagePath]);
    return vector;
  }

  async rerank(query, candidates, topN = 5) {
    if (!this.enableRerank) return null;
    const documents = [];
    const mapping = [];
    for (const candidate of candidates) {
      if (candidate.transcript) {
        documents.push({ text: candidate.transcript });
        mapping.push(candidate.id);
      }
      if (candidate.thumbnailPath && fs.existsSync(candidate.thumbnailPath)) {
        documents.push({ image: imageToDataUri(candidate.thumbnailPath) });
        mapping.push(candidate.id);
      }
    }
    if (!documents.length) return null;

    const response = await this.requestWithRetry(this.rerankApiUrl, {
      model: this.rerankModel,
      input: { query: { text: query }, documents },
      parameters: {
        return_documents: false,
        top_n: documents.length,
        instruct: 'Retrieve video moments that are semantically relevant to the user query.'
      }
    });
    const results = response.data?.output?.results || [];
    const scores = new Map();
    for (const result of results) {
      const candidateId = mapping[Number(result.index)];
      if (!candidateId) continue;
      const score = Number(result.relevance_score ?? result.score ?? 0);
      if (!Number.isFinite(score)) continue;
      const previous = scores.get(candidateId);
      scores.set(candidateId, previous === undefined ? score : Math.max(previous, score));
    }
    return scores;
  }
}

EmbeddingService.imageToDataUri = imageToDataUri;
module.exports = EmbeddingService;
