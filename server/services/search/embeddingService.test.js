const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EmbeddingService = require('../embeddingService');

function vector(size, value = 0.1) {
  return Array.from({ length: size }, () => value);
}

test('visual query and images use the same multimodal model and dimension', async () => {
  const calls = [];
  const httpClient = {
    post: async (url, payload) => {
      calls.push({ url, payload });
      const contents = payload.input.contents;
      return {
        data: {
          output: {
            embeddings: contents.map((_, index) => ({ index, embedding: vector(4, index + 0.1) }))
          }
        }
      };
    }
  };
  const service = new EmbeddingService({
    apiKey: 'test-key',
    dimension: 4,
    visualModel: 'same-vl-model',
    httpClient
  });
  const tempImage = path.join(os.tmpdir(), `visionmark-${process.pid}.jpg`);
  fs.writeFileSync(tempImage, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    await service.embedVisualText('测试查询');
    await service.embedImages([tempImage]);
  } finally {
    fs.rmSync(tempImage, { force: true });
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.model, 'same-vl-model');
  assert.equal(calls[1].payload.model, 'same-vl-model');
  assert.equal(calls[0].payload.parameters.dimension, 4);
  assert.match(calls[1].payload.input.contents[0].image, /^data:image\/jpeg;base64,/);
});

test('embedding validation rejects wrong dimensions and non-finite values', () => {
  const service = new EmbeddingService({ apiKey: 'test-key', dimension: 4 });
  assert.throws(() => service.validateVector([1, 2], 'test'), /维度异常/);
  assert.throws(() => service.validateVector([1, 2, 3, Number.NaN], 'test'), /非有限数值/);
});
