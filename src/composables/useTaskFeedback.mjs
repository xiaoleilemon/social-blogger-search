import { computed, onUnmounted, ref } from 'vue';

const RUNNING_REMINDER = '请勿关闭插件，关闭将中断任务';
const WRITING_REMINDER = '请勿关闭插件，关闭会中断数据写入';
const errorText = error => String(error?.response?.data?.msg || error?.message || error || '执行失败，请稍后重试');
const resultText = text => String(text || '').replace(/[，。]?\s*请勿关闭插件，关闭(?:将中断任务|会中断数据写入)[。！!]?$/, '');

// 只管理页面反馈；任务、写入进度、恢复和互斥仍由调用方拥有。
export function useTaskFeedback() {
  const toastVisible = ref(false);
  const toastText = ref('');
  const toastType = ref('loading');
  const toastLoading = computed(() => toastType.value === 'loading');
  const taskNotice = ref('');
  const noticeRequiresReopen = ref(false);
  let timer = null;

  const cancelTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const clearNotice = () => { taskNotice.value = ''; noticeRequiresReopen.value = false; };
  const hide = () => { cancelTimer(); toastVisible.value = false; };
  const progress = (text, { stopping = false } = {}) => {
    cancelTimer();
    const message = String(text || '正在处理…');
    toastText.value = message.includes('请勿关闭插件') ? message
      : `${message}${/[.…]$/.test(message) ? '' : '，'}${stopping ? WRITING_REMINDER : RUNNING_REMINDER}`;
    toastType.value = 'loading';
    toastVisible.value = true;
  };
  const begin = (text, options) => { clearNotice(); progress(text, options); };
  const finish = (text, { type, stopped = false, successCount, failCount = 0, empty = false } = {}) => {
    cancelTimer();
    clearNotice();
    const kind = stopped ? (failCount > 0 ? 'warning' : 'info')
      : type || (failCount > 0 ? (successCount > 0 ? 'warning' : 'error') : empty ? 'info' : 'success');
    toastText.value = resultText(text);
    toastType.value = kind;
    toastVisible.value = true;
    const duration = kind === 'error' && /字段[\s\S]*类型(?:不匹配|错误)/.test(toastText.value)
      ? 8000 : kind === 'success' || (stopped && !failCount) ? 3000 : 5000;
    timer = setTimeout(() => { timer = null; toastVisible.value = false; }, duration);
  };
  const fail = (error, { persist = false, requiresReopen = !!error?.requiresReopen } = {}) => {
    const text = errorText(error);
    finish(text, { type: 'error' });
    if (persist || requiresReopen || error?.stopPolling) {
      taskNotice.value = text;
      noticeRequiresReopen.value = requiresReopen;
    }
  };
  const recordFailure = (error, { index } = {}) => {
    taskNotice.value = `${index ? `第 ${index} 条处理失败` : '单条处理失败'}：${errorText(error)}，整批任务继续执行。`;
    noticeRequiresReopen.value = false;
  };

  onUnmounted(() => { hide(); clearNotice(); });
  return { toastVisible, toastText, toastType, toastLoading, taskNotice, noticeRequiresReopen, begin, progress, finish, fail, recordFailure, hide, clearNotice };
}
