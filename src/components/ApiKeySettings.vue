<script setup>
import { onMounted, ref, watch } from 'vue';
import { bitable } from '@lark-base-open/js-sdk';
import { ElMessage } from 'element-plus';
import { setBridgeData } from '@/utils/bridgeStorage';

const props = defineProps({ locked: Boolean });
const emit = defineEmits(['ready', 'saved', 'saving-state']);
const draft = ref('');
const savedKey = ref('');
const editing = ref(false);
const initializing = ref(true);
const saving = ref(false);
watch(saving, value => emit('saving-state', value), { flush: 'sync' });
const error = ref('');
const clearedMarker = '__cleared__';

const initialize = async () => {
  initializing.value = true;
  error.value = '';
  let timer;
  try {
    const stored = await Promise.race([
      (async () => {
        await bitable.base.getSelection();
        return bitable.bridge.getData('api_key');
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('连接多维表格超时')), 8000); }),
    ]);
    savedKey.value = typeof stored === 'string' && stored !== clearedMarker ? stored.trim() : '';
    draft.value = savedKey.value;
    editing.value = !savedKey.value;
    emit('ready', savedKey.value);
  } catch {
    error.value = '请在飞书多维表格扩展中打开此页面，以读取 API Key 并将结果写入表格。';
  } finally { clearTimeout(timer); initializing.value = false; }
};
const save = async () => {
  if (props.locked || saving.value || initializing.value) return;
  saving.value = true;
  try {
    const nextKey = draft.value.trim();
    await setBridgeData('api_key', nextKey || clearedMarker);
    savedKey.value = nextKey;
    draft.value = nextKey;
    editing.value = !nextKey;
    emit('saved', nextKey);
    ElMessage({ message: nextKey ? 'API Key 已保存' : 'API Key 已清空', type: 'success', plain: true, duration: 3000 });
  } catch {
    ElMessage({ message: '保存 API Key 失败，请重试', type: 'error', plain: true, duration: 5000 });
  } finally { saving.value = false; }
};
const toggleEditing = () => {
  if (props.locked || saving.value || initializing.value) return;
  if (editing.value) draft.value = savedKey.value;
  editing.value = !editing.value;
};
onMounted(initialize);
</script>

<template>
  <section class="api-section" aria-labelledby="api-key-title">
    <div class="api-header">
      <div class="api-title-group">
        <h2 id="api-key-title" class="api-title">API Key 设置</h2>
        <a class="api-link" href="https://socialdatax.com?from=feishu:plugin" target="_blank" rel="noopener noreferrer">点击获取API密钥</a>
      </div>
      <button
        type="button"
        class="api-edit"
        :disabled="locked || saving || initializing"
        :aria-label="editing ? '取消编辑 API Key' : '编辑 API Key'"
        :title="editing ? '取消编辑' : '编辑'"
        @click="toggleEditing"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
      </button>
    </div>
    <p v-if="initializing" class="api-hint" role="status">正在连接多维表格…</p>
    <div v-else-if="error" role="alert">
      <p class="api-hint">{{ error }}</p>
      <el-button size="small" @click="initialize">重新连接</el-button>
    </div>
    <form v-else @submit.prevent="save">
      <div class="api-input-wrap">
        <el-input v-model="draft" class="arco-input" type="password" show-password autocomplete="off" aria-label="API Key" placeholder="" :disabled="!editing || locked || saving" />
      </div>
      <button v-if="editing" type="submit" class="api-save-btn" :disabled="locked || saving">
        <img src="https://cdn.zhinizhushou.com/material/20250826/2db36bfc55033175693a18a5f927d938.png" alt="" />
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <p v-if="locked" class="api-hint" role="status">任务处理中，完成或停止后可修改 API Key。</p>
    </form>
  </section>
</template>

<style scoped>
.api-section { box-sizing: border-box; margin: 20px 20px 0; padding: 16px; border: 1px solid rgba(0, 0, 0, .06); border-radius: 8px; background: #fff; }
.api-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.api-title-group { display: flex; align-items: center; gap: 10px; }
.api-title { margin: 0; color: #1d2129; font-size: var(--app-font-size-section); font-weight: var(--app-font-weight-semibold); line-height: 24px; }
.api-link { padding: 2px 6px; border-radius: 4px; color: #a8071a; font-size: var(--app-font-size-small); line-height: 20px; text-decoration: none; cursor: pointer; transition: all .2s; }
.api-link:hover { background: #fff0f2; opacity: .85; }
.api-edit { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 18px; height: 18px; padding: 0; border: 0; background: transparent; color: #86909c; cursor: pointer; transition: color .2s; }
.api-edit:hover:not(:disabled) { color: #a8071a; }
.api-edit:disabled { cursor: not-allowed; opacity: .45; }
.api-edit svg { width: 100%; height: 100%; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.api-input-wrap { position: relative; }
.api-save-btn { display: flex; align-items: center; justify-content: center; width: 100%; height: 32px; margin-top: 12px; padding: 0; border: 0; border-radius: 6px; background: #a8071a; color: #fff; font-family: inherit; font-size: var(--app-font-size-body); font-weight: var(--app-font-weight-medium); cursor: pointer; transition: background .2s ease; }
.api-save-btn:hover:not(:disabled) { background: #c11126; }
.api-save-btn:active:not(:disabled) { background: #8a0515; }
.api-save-btn:disabled { cursor: not-allowed; opacity: .65; }
.api-save-btn img { width: 14px; height: 14px; margin-right: 8px; }
.api-hint { margin: 8px 0 0; color: #86909c; font-size: 12px; line-height: 20px; }
</style>
