// tsdown 配置（仿官方 DSH 客户端插件的构建方式：src → lib 产物）
// 说明：DSH 浏览器插件生产出产物 lib/client.js 必须是
//       window.__ModuleLoader__.load({ id, factory }) 单文件形态；
//       react / react/jsx-runtime / @deepseek-ai/* 保持外部 require（不打包）
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    client: 'src/client/index.ts',
    index: 'src/host/index.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'es2020',
  external: [/^@deepseek-ai\//, /^node:/],
  dts: false,
  outDir: 'lib',
  clean: false,
  outExtension: () => ({ js: '.js' }),
});
