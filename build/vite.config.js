import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
    plugins: [
        vue()
    ],
    resolve: {
        alias: {
            '@': resolve(__dirname, './extension'),
        },
    },
    build: {
        outDir: 'extension/dist',
        emptyOutDir: true,
        lib: {
            // 我们的目标是 content script
            entry: resolve(__dirname, 'extension/content/main.js'),
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
