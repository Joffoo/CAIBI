import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '传彩笔 CAIBI',
    description: '看图反推提示词',
    permissions: ['storage', 'contextMenus'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: '传彩笔 CAIBI — 点击打开视觉逆向 HUD',
    },
    icons: {
      '16': '/icon-16.png',
      '48': '/icon-48.png',
      '128': '/icon-128.png',
    },
  },
});
