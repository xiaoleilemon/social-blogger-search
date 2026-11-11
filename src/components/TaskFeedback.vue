<script setup>
defineProps({ visible: Boolean, text: { type: String, default: '' }, kind: { type: String, default: 'loading' } });
</script>

<template>
  <div v-if="visible" class="task-feedback-wrap" :role="kind === 'error' ? 'alert' : 'status'" :aria-live="kind === 'error' ? 'assertive' : 'polite'" aria-atomic="true">
    <div class="task-feedback" :class="`task-feedback-${kind}`">
      <span class="task-feedback-icon" aria-hidden="true">
        <svg v-if="kind === 'loading'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10" /></svg>
        <svg v-else viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" :fill="kind === 'success' ? '#00B42A' : kind === 'warning' ? '#FF7D00' : kind === 'error' ? '#F53F3F' : '#86909C'" />
          <path v-if="kind === 'success'" d="M8 12l2.5 2.5L16 9" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          <path v-else-if="kind === 'error'" d="m9 9 6 6m0-6-6 6" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" />
          <template v-else-if="kind === 'warning'"><path d="M12 7v6" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" /><circle cx="12" cy="16.5" r="1" fill="#FFFFFF" /></template>
          <template v-else><circle cx="12" cy="7.5" r="1" fill="#FFFFFF" /><path d="M12 11v6" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" /></template>
        </svg>
      </span>
      <span class="task-feedback-text">{{ text }}</span>
    </div>
  </div>
</template>

<style scoped>
.task-feedback-wrap { position:fixed; top:50%; left:50%; width:max-content; max-width:calc(100% - 48px); transform:translate(-50%,-50%); z-index:9999; pointer-events:none; }
.task-feedback { display:inline-flex; align-items:center; gap:8px; max-width:100%; box-sizing:border-box; padding:10px 18px; background:#fff; border:1px solid #e5e6eb; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.12); font-family:var(--app-font-family, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif); font-size:14px; line-height:22px; font-weight:500; color:#1d2129; white-space:normal; }
.task-feedback-text { min-width:0; overflow-wrap:anywhere; }
.task-feedback-icon { width:18px; height:18px; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
.task-feedback-icon svg { width:100%; height:100%; }
.task-feedback-loading .task-feedback-icon { color:#a8071a; animation:task-feedback-spin .8s linear infinite; }
@keyframes task-feedback-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) { .task-feedback-loading .task-feedback-icon { animation:none; } }
</style>
