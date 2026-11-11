import { shallowRef, triggerRef } from 'vue';
import { bitable } from '@lark-base-open/js-sdk';
import { setBridgeData } from '@/utils/bridgeStorage';

const ACTIVE_INTERVAL = 2000;
const MAX_INTERVAL = 30000;
const STALL_TIMEOUT = 10 * 60 * 1000;
// SDK 写入不会随 Vue 卸载取消；新实例先等待同一存储键的旧操作。
const pendingWrites = new Map();
// 批次已完成但保存失败时，重进只补存进度，不重发已成功的写入。
const unsavedProgress = new Map();
const submissions = new Map();

const unwrapApiData = (responseData) => {
  if (responseData?.sta !== undefined) {
    if (responseData.sta !== 0) throw new Error(responseData.msg || '请求失败');
    return responseData.data || {};
  }
  return responseData || {};
};

export const useIncrementalTask = ({ storageKey, getStatus, getResults, writeBatch, onProgress, onWriting, onFinish, onError, isTerminal }) => {
  const activeTask = shallowRef(null);
  let timer = null;
  let inFlightTask = null;

  let lifecycleVersion = 0;
  const waitForWrites = async () => {
    while (pendingWrites.has(storageKey)) {
      await pendingWrites.get(storageKey).catch(() => {});
    }
    const task = unsavedProgress.get(storageKey);
    if (task) await store(task);
  };
  const enqueueWrite = async operation => {
    const previous = pendingWrites.get(storageKey) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    pendingWrites.set(storageKey, pending);
    try { await pending; }
    finally { if (pendingWrites.get(storageKey) === pending) pendingWrites.delete(storageKey); }
  };
  const persist = async value => {
    try { await setBridgeData(storageKey, value); }
    catch (error) {
      if (value.taskId) error.requiresReopen = true;
      throw error;
    }
    if (unsavedProgress.get(storageKey) === value) unsavedProgress.delete(storageKey);
  };
  const store = (value, canWrite = () => true) => enqueueWrite(() => {
    if (canWrite()) return persist(value);
  });
  const save = task => store(task, () => activeTask.value === task);
  const clear = async () => {
    try { await store({}); }
    catch (error) { throw new Error(`清理任务进度失败，请重试恢复以完成清理：${error.message || '请求失败'}`); }
  };
  const stop = () => {
    lifecycleVersion++;
    if (timer) clearTimeout(timer);
    timer = null;
    activeTask.value = null;
  };
  const schedule = (task, delay) => {
    if (activeTask.value !== task) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => poll(task), delay);
  };

  const drain = async (task) => {
    let wroteData = false;
    while (activeTask.value === task) {
      const response = await getResults(task);
      if (activeTask.value !== task) return wroteData;
      const data = unwrapApiData(response);
      const items = Array.isArray(data.data) ? data.data : (Array.isArray(data.items) ? data.items : []);
      if (items.length === 0) return wroteData;
      const nextCursor = data.next_cursor || '';
      if (!nextCursor || nextCursor === task.cursor) throw new Error('结果接口未返回有效的 next_cursor');

      onWriting?.(items, task);
      // 写入与游标保存共同交接；卸载后仍须确认这一批的进度，供新实例恢复。
      await enqueueWrite(async () => {
        if (activeTask.value !== task) return;
        try { await writeBatch(items, task, { saveProgress: () => persist(task) }); }
        catch (error) {
          if (activeTask.value !== task) {
            unsavedProgress.set(storageKey, task);
            await persist(task);
          }
          throw error;
        }
        task.cursor = nextCursor;
        task.writtenCount = (task.writtenCount || 0) + items.length;
        task.lastActivityAt = Date.now();
        unsavedProgress.set(storageKey, task);
        await persist(task);
      });
      if (activeTask.value !== task) return wroteData;
      wroteData = true;
      if (!data.has_more) return wroteData;
    }
    return wroteData;
  };

  const poll = async (task) => {
    if (activeTask.value !== task || inFlightTask === task) return;
    inFlightTask = task;
    try {
      const status = unwrapApiData(await getStatus(task));
      if (activeTask.value !== task) return;
      task.latestStatus = status;
      const processed = Number(status.processed) || 0;
      const heartbeatAt = Number(status.heartbeat_at) || 0;
      const progressed = processed !== task.lastProcessed || heartbeatAt !== task.lastHeartbeatAt;
      if (progressed) {
        task.lastProcessed = processed;
        task.lastHeartbeatAt = heartbeatAt;
        task.lastActivityAt = Date.now();
        task.pollInterval = ACTIVE_INTERVAL;
      } else {
        task.pollInterval = Math.min(Math.max(task.pollInterval || ACTIVE_INTERVAL, ACTIVE_INTERVAL) * 2, MAX_INTERVAL);
      }

      onProgress?.(status, task, 'collecting');
      const wroteData = await drain(task);
      if (activeTask.value !== task) return;
      if (wroteData) {
        task.pollInterval = ACTIVE_INTERVAL;
        onProgress?.(status, task, 'written');
      }

      const terminal = isTerminal
        ? isTerminal(status)
        : Number(status.status) === 1 || Number(status.status) === 2;
      if (terminal && !wroteData) {
        stop();
        const version = lifecycleVersion;
        try { await clear(); }
        catch (error) {
          if (version === lifecycleVersion) await onError?.(error, task);
          return;
        }
        if (version === lifecycleVersion) await onFinish?.(status, task);
        return;
      }
      if (Date.now() - (task.lastActivityAt || Date.now()) >= STALL_TIMEOUT) {
        throw new Error('任务超过 10 分钟没有进度更新，请稍后重试');
      }
      await save(task);
      schedule(task, task.pollInterval || ACTIVE_INTERVAL);
    } catch (error) {
      if (activeTask.value !== task) return;
      task.pollInterval = Math.min(Math.max(task.pollInterval || ACTIVE_INTERVAL, ACTIVE_INTERVAL) * 2, MAX_INTERVAL);
      const invalidAuth = error.code === 'INVALID_API_KEY' || [401, 403].includes(error.response?.status);
      if (error.stopPolling || invalidAuth || Date.now() - (task.lastActivityAt || Date.now()) >= STALL_TIMEOUT) {
        stop();
        await onError?.(error, task);
      } else {
        try {
          await save(task);
          schedule(task, task.pollInterval);
        } catch (saveError) {
          if (activeTask.value !== task) return;
          saveError.requiresReopen = true;
          stop();
          await onError?.(saveError, task);
        }
      }
    } finally {
      if (inFlightTask === task) inFlightTask = null;
    }
  };

  const start = async (task, onReady) => {
    stop();
    activeTask.value = {
      cursor: '', writtenCount: 0, lastProcessed: -1, lastHeartbeatAt: 0,
      lastActivityAt: Date.now(), pollInterval: ACTIVE_INTERVAL, baseId: '', ...task,
    };
    const startedTask = activeTask.value;
    await waitForWrites();
    if (activeTask.value !== startedTask) return;
    const selection = await bitable.base.getSelection();
    if (activeTask.value !== startedTask) return;
    startedTask.baseId = 'baseId' in task ? task.baseId : selection.baseId || '';
    await save(startedTask);
    if (activeTask.value !== startedTask) return;
    await onReady?.(startedTask);
    await poll(startedTask);
  };

  // 创建成功后先保存身份；旧页面退出也不能丢掉新任务的恢复入口。
  const saveForResume = async task => {
    const selection = await bitable.base.getSelection();
    await store({
      cursor: '', writtenCount: 0, lastProcessed: -1, lastHeartbeatAt: 0,
      lastActivityAt: Date.now(), pollInterval: ACTIVE_INTERVAL, baseId: selection.baseId || '', ...task,
    });
  };
  const submit = async (createTask, onReady) => {
    const version = lifecycleVersion;
    if (submissions.has(storageKey)) throw new Error('上次提交尚未处理，请先恢复任务');
    const entry = { task: null, promise: null };
    entry.promise = (async () => {
      await waitForWrites();
      if (version !== lifecycleVersion) return;
      entry.task = await createTask();
      if (!entry.task?.taskId) throw new Error('创建任务未返回任务 ID');
      await saveForResume(entry.task);
    })();
    submissions.set(storageKey, entry);
    try {
      await entry.promise;
      if (submissions.get(storageKey) === entry) submissions.delete(storageKey);
      if (version === lifecycleVersion) await resume(onReady);
    } catch (error) {
      if (!entry.task?.taskId && submissions.get(storageKey) === entry) submissions.delete(storageKey);
      if (version === lifecycleVersion) {
        if (entry.task?.taskId) error.taskCreated = true;
        throw error;
      }
    }
  };

  const resume = async (onRestore) => {
    if (activeTask.value) return false;
    const restoringTask = {};
    activeTask.value = restoringTask;
    try {
      const entry = submissions.get(storageKey);
      if (entry) {
        try { await entry.promise; }
        catch (error) {
          if (activeTask.value !== restoringTask) return false;
          if (entry.task?.taskId) {
            entry.promise = saveForResume(entry.task);
            await entry.promise;
          }
        }
        if (submissions.get(storageKey) === entry) submissions.delete(storageKey);
      }
      await waitForWrites();
      if (activeTask.value !== restoringTask) return false;
      const saved = await bitable.bridge.getData(storageKey);
      if (activeTask.value !== restoringTask) return false;
      if (!saved?.taskId) { activeTask.value = null; return false; }
      const selection = await bitable.base.getSelection();
      if (activeTask.value !== restoringTask) return false;
      if (saved.baseId && selection.baseId && saved.baseId !== selection.baseId) { activeTask.value = null; return false; }
      Object.assign(restoringTask, saved, { lastActivityAt: saved.lastActivityAt || Date.now(), pollInterval: saved.pollInterval || ACTIVE_INTERVAL });
      // 保留任务对象身份，并刷新依赖其就绪状态的按钮。
      triggerRef(activeTask);
      await onRestore?.(restoringTask);
      await poll(restoringTask);
      return true;
    } catch (error) {
      if (activeTask.value === restoringTask && !restoringTask.taskId) activeTask.value = null;
      throw error;
    }
  };

  return { start, submit, resume, stop, getActiveTask: () => activeTask.value };
};
