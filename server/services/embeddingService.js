const axios = require('axios');

const { ossClient } = require('../utils/oss');
const path = require('path');
const fs = require('fs');

/**
 * 封装 DashScope 的 Text Embedding 接口 (text-embedding-v2)
 */
class EmbeddingService {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.DASHSCOPE_API_KEY;
    this.textApiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
    this.multimodalApiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding';
  }

  isReady() {
    return !!this.apiKey;
  }

  /**
   * 将文本转为向量
   * @param {string} text 
   * @returns {number[]}
   */
  async embedText(text) {
    if (!this.isReady()) throw new Error('DASHSCOPE_API_KEY 未配置');
    
    try {
      const response = await axios.post(
        this.textApiUrl,
        {
          model: 'text-embedding-v2',
          input: {
            texts: [text]
          },
          parameters: {}
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const embeddings = response.data?.output?.embeddings || [];
      if (embeddings.length === 0) throw new Error('未返回文本向量数据');
      return embeddings[0].embedding;
      
    } catch (error) {
      console.error('[Embedding] embedText 失败:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * 将图片经过 OSS 暂存后转为向量（使用多模态模型）
   * @param {string} bvid
   * @param {number} timestamp
   * @param {string} imagePath 本地图片绝对路径
   * @returns {number[]}
   */
  async embedLocalImage(bvid, timestamp, imagePath) {
    if (!this.isReady()) throw new Error('DASHSCOPE_API_KEY 未配置');
    if (!ossClient) throw new Error('OSS 未配置，无法上传临时图片');
    
    const ext = path.extname(imagePath);
    const ossObjectName = `embedding_tmp/${bvid}_${timestamp}_${Date.now()}${ext}`;
    let temporaryOssUrl = '';
    
    try {
      // 1. 上传到 OSS
      const uploadResult = await ossClient.put(ossObjectName, path.normalize(imagePath));
      temporaryOssUrl = uploadResult.url;
      
      // 2. 调用多模态 Embedding API（需要同时提供文本和图像）
      const response = await axios.post(
        this.multimodalApiUrl,
        {
          model: 'multimodal-embedding-v1',
          input: {
            texts: [""], // 多模态模型需要文本字段，即使为空
            images: [temporaryOssUrl]
          },
          parameters: {}
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const embeddings = response.data?.output?.embeddings || [];
      if (embeddings.length === 0) throw new Error('未返回图像向量数据');
      return embeddings[0].embedding;
      
    } catch (error) {
      console.error(`[Embedding] embedLocalImage 失败: ${imagePath}`, error.response?.data || error.message);
      throw error;
    } finally {
      // 3. 清理 OSS 上的临时文件
      if (temporaryOssUrl && ossClient) {
        try {
          await ossClient.delete(ossObjectName);
        } catch (cleanupError) {
          console.error(`[Embedding] 清理OSS文件失败 ${ossObjectName}:`, cleanupError.message);
        }
      }
    }
  }
}

module.exports = EmbeddingService;