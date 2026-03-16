import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// 获取项目根目录路径
const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), '..');

export default defineConfig({
    plugins: [
        vue()
    ],
    resolve: {
        alias: {
            '@': resolve(projectRoot, './extension'),
        },
    },
    build: {
        outDir: resolve(projectRoot, 'extension/dist'),
        emptyOutDir: true,
        lib: {
            // 我们的目标是 content script
            entry: resolve(projectRoot, 'extension/content/main.js'),
            name: 'VisionMarkContent',
            formats: ['iife'],
            fileName: () => 'main.js'
        },
        cssCodeSplit: false
    },
    define: {
        'process.env.NODE_ENV': '"production"'
    }
});
