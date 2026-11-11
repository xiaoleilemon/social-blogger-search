<script setup>
import { ref } from 'vue';
import { ElConfigProvider } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import ApiKeySettings from './components/ApiKeySettings.vue';
import BloggerSearch from './components/BloggerSearch.vue';

const apiKey = ref('');
const ready = ref(false);
const running = ref(false);
const apiKeySaving = ref(false);
const searchPage = ref(null);
const applyApiKey = value => { apiKey.value = value; ready.value = true; };
const handleApiKeySaved = value => {
  const sameKey = apiKey.value === value;
  applyApiKey(value);
  if (sameKey && value) return searchPage.value?.refreshSavedTask();
};
</script>

<template>
  <el-config-provider :locale="zhCn">
    <main class="app-page">
      <div class="banner-top"></div>
      <section class="banner-section" aria-labelledby="community-title">
        <div class="banner-deco-dot"></div>
        <div class="banner-deco-ring"></div>
        <a
          class="banner-help"
          href="https://congxin.feishu.cn/docx/IKK4drqhdo5WkqxbJMCcHpeWnHe?from=from_copylink"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg class="help-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <span class="help-text">帮助文档</span>
        </a>
        <h1 id="community-title" class="banner-title">加入交流群</h1>
        <p class="banner-subtitle">
          <span>使用插件遇问题可进群答疑，</span><span class="highlight">新版本更新群内抢先通知</span>
        </p>
        <a class="banner-btn" href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=688icbad-0387-420e-a6e6-1ba184ac6e9a" target="_blank" rel="noopener noreferrer">
          <span>立即进群</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 16 16 12 12 8"></polyline>
            <line x1="8" y1="12" x2="16" y2="12"></line>
          </svg>
        </a>
      </section>
      <ApiKeySettings :locked="running" @ready="applyApiKey" @saved="handleApiKeySaved" @saving-state="apiKeySaving = $event" />
      <BloggerSearch v-if="ready && apiKey" ref="searchPage" :api_key="apiKey" :api-key-saving="apiKeySaving" @task-state="running = $event" />
      <section v-else-if="ready" class="empty-state">
        <h2>开始搜索作者</h2>
        <p>保存 API Key 后，选择平台和作者关键词，将搜索结果写入多维表格。</p>
      </section>
    </main>
  </el-config-provider>
</template>

<style scoped>
.app-page { min-height: 100vh; background: #fffcfc; color: #1d2129; font-family: var(--app-font-family); }
.banner-top { padding: 10px; }
.banner-section { box-sizing: border-box; position: relative; overflow: hidden; margin: 0 20px 20px; padding: 20px; border-radius: 8px; background: linear-gradient(135deg, #fff0f2 0%, #ffe6e9 100%); }
.banner-section::before { position: absolute; top: -24px; right: -24px; z-index: 0; width: 120px; height: 120px; border-radius: 50%; background: #ffb3bb; opacity: .15; filter: blur(24px); content: ''; pointer-events: none; }
.banner-section::after { position: absolute; right: 12px; bottom: 12px; z-index: 0; width: 64px; height: 64px; border: 2px solid #fff0f2; border-radius: 12px; opacity: .12; content: ''; pointer-events: none; }
.banner-deco-dot { position: absolute; right: 28px; bottom: 28px; z-index: 0; width: 8px; height: 8px; border-radius: 50%; background: #ffb3bb; opacity: .18; pointer-events: none; }
.banner-deco-ring { position: absolute; top: 16px; right: 56px; z-index: 0; width: 32px; height: 32px; border: 1.5px solid #fff0f2; border-radius: 50%; opacity: .14; pointer-events: none; }
.banner-title { position: relative; z-index: 1; margin: 0 0 8px; color: #1d2129; font-size: var(--app-font-size-hero); font-weight: var(--app-font-weight-semibold); line-height: 28px; }
.banner-subtitle { position: relative; z-index: 1; margin: 0 0 16px; color: #4e5969; font-size: var(--app-font-size-body); font-weight: var(--app-font-weight-regular); line-height: 22px; }
.banner-subtitle .highlight { color: #a8071a; font-weight: var(--app-font-weight-medium); }
.banner-btn { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 16px; border: 0; border-radius: 6px; background: #a8071a; color: #fff; font-family: inherit; font-size: var(--app-font-size-body); font-weight: var(--app-font-weight-medium); text-decoration: none; cursor: pointer; transition: all .2s ease; }
.banner-btn:hover { background: #c11126; }
.banner-btn:active { background: #8a0515; }
.banner-btn svg { width: 14px; height: 14px; color: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.banner-help { position: absolute; top: 16px; right: 16px; z-index: 2; display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; text-decoration: none; cursor: pointer; transition: all .2s ease; }
.banner-help:hover { background: rgba(168, 7, 26, .06); }
.banner-help:hover .help-icon { stroke: #a8071a; }
.banner-help:hover .help-text { color: #a8071a; }
.banner-help .help-icon { flex-shrink: 0; width: 16px; height: 16px; stroke: #86909c; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: stroke .2s ease; }
.banner-help .help-text { color: #86909c; font-size: var(--app-font-size-caption); font-weight: var(--app-font-weight-regular); line-height: 20px; transition: color .2s ease; }
.empty-state { margin: 16px; padding: 24px 20px; border: 1px solid #e5e6eb; border-radius: 8px; background: #fff; }
.empty-state h2 { margin: 0 0 8px; font-size: 16px; font-weight: 500; }
.empty-state p { margin: 0; color: #86909c; font-size: 14px; line-height: 22px; }
</style>
