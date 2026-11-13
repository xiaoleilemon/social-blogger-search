import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = process.env.VITE_DEV_PROXY_TARGET || env.VITE_DEV_PROXY_TARGET || 'https://test-lotto.weiyoubot.cn'

  const feishuProxyTarget = process.env.VITE_FEISHU_DEV_PROXY_TARGET || env.VITE_FEISHU_DEV_PROXY_TARGET || 'https://test-lotto.weiyoubot.cn'

  return {
    server: {
      host: true,
      proxy: {
        '/socialdatax/api': {
          target: feishuProxyTarget,
          changeOrigin: true,
        },
        '/social/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
    base: './',
    plugins: [
      vue(),
      AutoImport({
        resolvers: [ElementPlusResolver()],
      }),
      Components({
        resolvers: [ElementPlusResolver()],
      }),],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    }
  }
})
