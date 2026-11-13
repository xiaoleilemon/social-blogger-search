<script setup>
import { bitable } from '@lark-base-open/js-sdk';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { feishuRequest as request, API_BASE_URL, FEISHU_API_BASE_URL, FEISHU_API_PATH_PREFIX, LEGACY_FEISHU_API_PATH_PREFIX, buildFeishuApiPath } from '@/utils/request';
import { BLOGGER_FIELD_MAPPING, getDefaultSelectedFieldKeys, showErrorMsg, useBloggerData } from '@/composables/useBloggerData';
import { useIncrementalTask } from '@/composables/useIncrementalTask';
import { getOrderedTableFields } from '@/utils/tableFields';
import { setBridgeData } from '@/utils/bridgeStorage';
import TaskFeedback from './TaskFeedback.vue';
import { useTaskFeedback } from '@/composables/useTaskFeedback.mjs';

const props = defineProps({ api_key: { type: String, required: true }, apiKeySaving: Boolean });
const emit = defineEmits(['task-state']);
const TASK_PLUGIN_TYPE = 'blogger_search';
const TABLE_CONFIG_API_PATH = buildFeishuApiPath('/v1/feishu/profile-fetch/table-output-config');
const TABLE_CONFIGS_API_PATH = buildFeishuApiPath('/v1/feishu/profile-fetch/table-output-configs');
const form = ref({ social_type: '', keyword: '', rangeType: 'pages', pages: 1, radio: 1, table_id: '', writeMode: 'upsert', follower_count_range: 'all', user_type: 'all' });
const tableOptions = ref([]);
const tableFieldOptions = ref([]);
const selectedFieldKeys = ref([]);
const mappingDraft = ref([]);
const mappingExpanded = ref(false);
const mappingLoading = ref(false);
let tableFieldsLoadToken = 0;
let tableFieldsError = null;
const loading = ref(false);
const submitting = ref(false);
const cancelling = ref(false);
const taskId = ref('');
const hasRecoverableTask = ref(false);
let componentUnmounted = false;
const feedback = useTaskFeedback();
const { toastVisible, toastText, toastLoading, toastType, taskNotice, noticeRequiresReopen } = feedback;
const fieldReady = ref(false);
const storageKey = 'blogger_search_stream_task_v1';
const fieldStorageKey = 'blogger_search_selected_fields_v1';
const tableOutputConfigs = ref({});
const tableConfigsLoaded = ref(false);
let tableConfigsError = null;
let tableConfigsLoadToken = 0;
const tableConfigSaving = ref(false);
const tableConfigApplying = ref(false);
const outputConfigReady = computed(() => tableConfigsLoaded.value && !!form.value.table_id && !tableConfigApplying.value && !mappingLoading.value && !tableFieldsError);
const tableConfigSaves = new Map();
let tableConfigSaveQueued = false;
const allKeys = BLOGGER_FIELD_MAPPING.map(field => field.key);
const requiredFieldKeys = computed(() => BLOGGER_FIELD_MAPPING
  .filter(field => field.required || (field.requiredForUpsert && form.value.writeMode === 'upsert'))
  .map(field => field.key));
const allSelected = computed(() => allKeys.every(key => selectedFieldKeys.value.includes(key)));
const socialOptions = computed(() => [
  { value: 'xhs', label: '小红书' }, { value: 'douyin', label: '抖音' },
  { value: 'tiktok', label: 'TikTok' }, { value: 'kuaishou', label: '快手' },
  { value: 'bilibili', label: '哔哩哔哩' }, { value: 'weibo', label: '微博' },
  { value: 'haokan', label: '好看视频' }, { value: 'toutiao', label: '今日头条' },
  { value: 'wechat', label: '视频号' }, { value: 'zhihu', label: '知乎' },
  { value: 'instagram', label: 'Instagram' }, { value: 'x', label: 'X' },
]);
const isDouyin = computed(() => form.value.social_type === 'douyin');

const getTableName = () => searchTask.getActiveTask()?.tableName || form.value.keyword.split(/[\n,，]+/).map(item => item.trim()).find(Boolean) || '作者搜索';
const { createAndWriteData, validateTableFields } = useBloggerData(getTableName);
const auth = () => ({ authorization: `Bearer ${props.api_key}` });

const showToast = text => feedback.progress(text, { stopping: cancelling.value });

const getStoppingText = () => '正在停止任务，等待剩余作者写入完成后停止，避免已获取数据丢失';
const onTaskReady = async (task, restoring = false) => {
  const restoreForm = restoring && taskId.value !== task.taskId && task.formData;
  hasRecoverableTask.value = true;
  taskId.value = task.taskId;
  const status = task.latestStatus;
  cancelling.value = Number(status?.status) === 3 || status?.status_text === 'cancel_requested' || !!status?.cancel_requested;
  if (cancelling.value) showToast(getStoppingText());
  else if (restoring) showToast('正在恢复未完成的作者搜索任务…');
  if (restoreForm) {
    Object.assign(form.value, task.formData);
    if (Array.isArray(task.selectedFieldKeys)) selectedFieldKeys.value = [...task.selectedFieldKeys];
    await nextTick();
    if (componentUnmounted) return;
    await loadTableFields(form.value.radio === 2 ? form.value.table_id : '', task);
  }
};

// 未保存后端来源的历史任务继续请求旧后端。
const bloggerTaskApiPath = (task, path) => buildFeishuApiPath(path, task.apiPathPrefix ?? LEGACY_FEISHU_API_PATH_PREFIX);

const searchTask = useIncrementalTask({
  storageKey,
  isTerminal: status => [1, 2, 3].includes(Number(status.status)),
  getStatus: async task => (await request({ url: `${bloggerTaskApiPath(task, '/v1/feishu/blogger/search/task')}?task_id=${encodeURIComponent(task.taskId)}`, baseURL: task.apiBaseUrl ?? API_BASE_URL, method: 'get', headers: auth() })).data,
  getResults: async task => (await request({ url: bloggerTaskApiPath(task, '/v1/feishu/blogger/search/list'), baseURL: task.apiBaseUrl ?? API_BASE_URL, method: 'post', headers: auth(), data: { task_id: task.taskId, after_id: task.cursor || '', limit: 40 } })).data,
  writeBatch: async (items, task, controls) => {
    task.appendState ||= {};
    const result = await createAndWriteData(items, task.targetTableId ? 'stream' : '', task.taskId, task.targetTableId || '', task.selectedFieldKeys, {
      writeMode: task.writeMode,
      fieldMappings: task.fieldMappings || [],
      appendState: task.appendState,
      onBeforeWrite: controls.saveProgress,
      onTargetTableReady: async tableId => { task.targetTableId = tableId; await controls.saveProgress(); },
    });
    task.targetTableId = result.tableId;
    task.appendState = {};
  },
  onProgress: (status, task) => {
    if (Number(status.status) === 3 || status.status_text === 'cancel_requested' || status.cancel_requested) cancelling.value = true;
    const processed = Number(status.processed) || 0;
    const total = Number(status.total) || 0;
    task.processedPages = processed;
    task.totalPages = total;
    showToast(cancelling.value
      ? getStoppingText()
      : `正在获取作者，已处理 ${total ? `${processed}/${total}` : processed} 页，已写入 ${task.writtenCount || 0} 条`);
  },
  onWriting: items => { showToast(cancelling.value ? getStoppingText() : `正在写入 ${items.length} 条作者数据…`); },
  onFinish: (status, task) => {
    hasRecoverableTask.value = false;
    loading.value = false; cancelling.value = false; taskId.value = '';
    if (Number(status.status) === 2) {
      feedback.fail(status.reason || '获取数据失败');
      return;
    }
    if (Number(status.status) === 3) {
      feedback.finish(`任务已停止，已写入 ${task.writtenCount || 0} 条作者`, { stopped: true });
      return;
    }
    feedback.finish(`处理完成，已写入 ${task.writtenCount || 0} 条作者`, { empty: !task.writtenCount });
  },
  onError: error => {
    loading.value = false; cancelling.value = false;
    feedback.fail(error, { persist: true });
  },
});

const loadTables = async () => {
  try {
    const tables = await bitable.base.getTableList();
    tableOptions.value = await Promise.all(tables.map(async table => ({ id: table.id, name: await table.getName() })));
  } catch (error) { showErrorMsg('获取表格列表失败，请稍后重试', 5000); }
};
const getBaseId = async () => (await bitable.base.getSelection()).baseId || '';
const loadTableOutputConfigs = async () => {
  const token = ++tableConfigsLoadToken;
  tableConfigsLoaded.value = false;
  tableConfigsError = null;
  if (!props.api_key) return false;
  try {
    const baseId = await getBaseId();
    if (componentUnmounted || token !== tableConfigsLoadToken) return false;
    const response = await request({ url: TABLE_CONFIGS_API_PATH, method: 'get', headers: auth(), params: { plugin_type: TASK_PLUGIN_TYPE, base_id: baseId } });
    if (componentUnmounted || token !== tableConfigsLoadToken) return false;
    if (response.data?.sta !== undefined && response.data.sta !== 0) throw new Error(response.data.msg || '读取表格输出配置失败');
    const data = response.data?.data || response.data;
    const list = Array.isArray(data) ? data : data?.list ?? data?.items;
    if (!Array.isArray(list)) throw new Error('表格配置返回格式不正确');
    tableOutputConfigs.value = Object.fromEntries(list.filter(item => item?.target_table_id).map(item => [item.target_table_id, item]));
    tableConfigsLoaded.value = true;
    return true;
  } catch (error) {
    if (componentUnmounted || token !== tableConfigsLoadToken) return false;
    tableConfigsError = error;
    if (!submitting.value) showErrorMsg(error?.response?.data?.msg || error.message || '读取表格输出配置失败', 5000);
    return false;
  }
};
const loadTableFields = async (tableId, restoredTask = null) => {
  const token = ++tableFieldsLoadToken;
  const pendingConfig = tableConfigSaves.get(tableId)?.config;
  tableFieldsError = null;
  tableConfigApplying.value = true;
  tableFieldOptions.value = [];
  mappingDraft.value = (restoredTask?.fieldMappings || []).map(item => ({ ...item }));
  if (!tableId) { mappingLoading.value = false; tableConfigApplying.value = false; return true; }
  mappingLoading.value = true;
  try {
    const table = await bitable.base.getTableById(tableId);
    if (componentUnmounted || token !== tableFieldsLoadToken) return;
    const fields = await getOrderedTableFields(table);
    if (componentUnmounted || token !== tableFieldsLoadToken) return;
    tableFieldOptions.value = fields;
    if (!restoredTask && !tableConfigsLoaded.value) return false;
    const config = restoredTask ? { field_mappings: restoredTask.fieldMappings, write_mode: restoredTask.writeMode } : (tableConfigSaves.get(tableId)?.config || pendingConfig || tableOutputConfigs.value[tableId]);
    mappingDraft.value = Array.isArray(config?.field_mappings) ? config.field_mappings.map(item => ({ ...item })) : [];
    if (config?.write_mode === 'append' || config?.write_mode === 'upsert') form.value.writeMode = config.write_mode;
    return true;
  } catch (error) {
    if (componentUnmounted || token !== tableFieldsLoadToken) return;
    tableFieldsError = error;
    if (!submitting.value) showErrorMsg(error.message || '读取目标表字段失败，请稍后重试', 5000);
    return false;
  } finally {
    if (componentUnmounted || token !== tableFieldsLoadToken) return;
    mappingLoading.value = false;
    tableConfigApplying.value = false;
  }
};
const saveTableOutputConfig = async (outputConfig = null) => {
  outputConfig = outputConfig?.targetTableId ? outputConfig : null;
  if (componentUnmounted || !tableConfigsLoaded.value || busy.value) return;
  if (!outputConfig && (form.value.radio !== 2 || !form.value.table_id || tableConfigApplying.value)) return;
  if (!props.api_key || (!outputConfig && !tableFieldOptions.value.length)) return;
  let snapshot = outputConfig;
  if (!snapshot) {
    const targetTableId = form.value.table_id, writeMode = form.value.writeMode;
    const fieldMappings = mappingDraft.value.filter(item => item.source_key && item.target_field_id).map(item => {
      const source = BLOGGER_FIELD_MAPPING.find(field => field.key === item.source_key);
      const target = tableFieldOptions.value.find(field => field.id === item.target_field_id);
      return { ...item, source_name: source?.name || item.source_name || '', target_field_name: target?.name || item.target_field_name || '', target_field_type: target?.type ?? item.target_field_type };
    });
    snapshot = { targetTableId, writeMode, fieldMappings };
  }
  const { targetTableId, writeMode, fieldMappings } = snapshot;
  const pending = { snapshot, config: { write_mode: writeMode, field_mappings: fieldMappings } };
  tableConfigSaves.set(targetTableId, pending);
  if (tableConfigSaving.value) { tableConfigSaveQueued = true; return; }
  tableConfigSaveQueued = false;
  tableConfigSaving.value = true;
  try {
    const table = await bitable.base.getTableById(targetTableId);
    const payload = { plugin_type: TASK_PLUGIN_TYPE, base_id: await getBaseId(), target_table_id: targetTableId, target_table_name: await table.getName(), write_mode: writeMode, field_mappings: fieldMappings };
    if (componentUnmounted) return;
    const response = await request({ url: TABLE_CONFIG_API_PATH, method: 'put', headers: auth(), data: payload });
    if (componentUnmounted) return;
    if (response.data?.sta !== undefined && Number(response.data.sta) !== 0) throw new Error(response.data.msg || '保存作者搜索表格配置失败');
    tableOutputConfigs.value = { ...tableOutputConfigs.value, [targetTableId]: response.data?.data || response.data };
  } catch (error) { if (!componentUnmounted) showErrorMsg(error.message || '保存作者搜索表格配置失败', 5000); }
  finally {
    if (tableConfigSaves.get(targetTableId) === pending) tableConfigSaves.delete(targetTableId);
    tableConfigSaving.value = false;
    tableConfigSaveQueued = tableConfigSaves.size > 0;
    if (tableConfigSaveQueued && !componentUnmounted && !busy.value) saveTableOutputConfig(tableConfigSaves.values().next().value.snapshot);
  }
};

const getMappingSourceFields = index => {
  const usedKeys = new Set(mappingDraft.value.filter((item, itemIndex) => itemIndex !== index).map(item => item.source_key).filter(Boolean));
  return BLOGGER_FIELD_MAPPING.filter(field => selectedFieldKeys.value.includes(field.key)).map(field => ({ ...field, disabled: usedKeys.has(field.key) }));
};
const getMappingTargetFields = index => {
  const usedIds = new Set(mappingDraft.value.filter((item, itemIndex) => itemIndex !== index).map(item => item.target_field_id).filter(Boolean));
  return tableFieldOptions.value.map(field => ({ ...field, disabled: usedIds.has(field.id) }));
};
const mappingStatus = computed(() => {
  if (form.value.radio === 2 && !form.value.table_id) return '选择目标表格后可设置';
  const count = mappingDraft.value.filter(item => item.source_key && item.target_field_id).length;
  return count ? `已设置 ${count} 项映射` : '尚未设置自定义映射';
});
const loadFields = async () => {
  try {
    const saved = await bitable.bridge.getData(fieldStorageKey);
    selectedFieldKeys.value = Array.isArray(saved) ? [...new Set([...saved, ...requiredFieldKeys.value])].filter(key => allKeys.includes(key)) : getDefaultSelectedFieldKeys(BLOGGER_FIELD_MAPPING);
  } catch { selectedFieldKeys.value = getDefaultSelectedFieldKeys(BLOGGER_FIELD_MAPPING); }
  fieldReady.value = true;
};
watch(selectedFieldKeys, keys => { if (fieldReady.value) setBridgeData(fieldStorageKey, keys); }, { deep: true });
watch(requiredFieldKeys, keys => {
  selectedFieldKeys.value = [...new Set([...selectedFieldKeys.value, ...keys])];
});
watch([mappingDraft, () => form.value.writeMode], saveTableOutputConfig, { deep: true });
watch([() => form.value.radio, () => form.value.table_id], ([radio, tableId], [previousRadio]) => {
  if (radio === 2) {
    if (radio !== previousRadio) loadTables();
    if (!busy.value) loadTableFields(tableId);
  } else loadTableFields('');
});

const toggleAll = checked => { selectedFieldKeys.value = checked ? [...allKeys] : [...requiredFieldKeys.value]; };
const parseKeywords = value => [...new Set(String(value || '').split(/[\n,，]+/).map(item => item.trim()).filter(Boolean))];
const cancel = async () => {
  const task = searchTask.getActiveTask();
  if (!task?.taskId || cancelling.value) return;
  cancelling.value = true; showToast(getStoppingText());
  try {
    const response = await request({ url: bloggerTaskApiPath(task, '/v1/feishu/blogger/search/task/cancel'), baseURL: task.apiBaseUrl ?? API_BASE_URL, method: 'post', headers: auth(), data: { task_id: task.taskId } });
    if (response.data?.sta !== 0) throw new Error(response.data?.msg || '停止任务失败');
  } catch (error) {
    if (searchTask.getActiveTask() !== task) return;
    const status = task.latestStatus;
    cancelling.value = Number(status?.status) === 3 || status?.status_text === 'cancel_requested' || !!status?.cancel_requested;
    showToast(cancelling.value ? getStoppingText() : `任务继续执行，已写入 ${task.writtenCount || 0} 条作者`);
    showErrorMsg(error?.response?.data?.msg || error.message || '停止任务失败');
  }
};
const submit = async () => {
  if (componentUnmounted || props.apiKeySaving || submitting.value || loading.value || initializing.value || noticeRequiresReopen.value) return;
  submitting.value = true;
  let prepared = false;
  try {
    if (taskId.value || hasRecoverableTask.value) {
      prepared = true;
      await resumeTask();
      return;
    }
    const keywords = parseKeywords(form.value.keyword);
    if (!props.api_key) throw new Error('请输入 API Key');
    if (!form.value.social_type) throw new Error('请选择平台');
    if (!keywords.length) throw new Error('请输入至少一个作者关键词');
    if (keywords.length > 100) throw new Error('最多支持 100 个关键词');
    if (form.value.social_type === 'instagram' && keywords.some(keyword => [...keyword].length > 256)) throw new Error('Instagram 每个关键词最多 256 个字符');
    if (form.value.rangeType === 'pages' && (!Number.isInteger(form.value.pages) || form.value.pages < 1 || form.value.pages > 100)) throw new Error('搜索页数必须为 1～100 的整数');
    if (form.value.radio === 2 && !form.value.table_id) throw new Error('请选择现有表格');
    if (form.value.radio === 2 && !tableConfigsLoaded.value) {
      prepared = true;
      loading.value = true;
      feedback.begin('正在读取表格输出配置…');
      const loaded = await loadTableOutputConfigs();
      if (componentUnmounted) return;
      if (!loaded) throw tableConfigsError || new Error('读取表格输出配置失败，请稍后重试');
      const fieldsLoaded = await loadTableFields(form.value.table_id);
      if (componentUnmounted) return;
      if (!fieldsLoaded) throw tableFieldsError || new Error('读取目标表字段失败，请稍后重试');
    }
    if (form.value.radio === 2 && mappingLoading.value) throw new Error('正在读取目标表字段，请稍后重试');
    if (form.value.radio === 2 && tableFieldsError) {
      prepared = true;
      loading.value = true;
      feedback.begin('正在读取目标表字段…');
      const loaded = await loadTableFields(form.value.table_id);
      if (componentUnmounted) return;
      if (!loaded) throw tableFieldsError || new Error('读取目标表字段失败，请稍后重试');
    }
    if (form.value.radio === 2 && mappingDraft.value.some(item => !item.source_key || !item.target_field_id)) throw new Error('请完成字段映射，或删除未完成的映射');
    prepared = true;
    const formData = { ...form.value };
    const outputSnapshot = {
      targetTableId: formData.radio === 2 ? formData.table_id : '',
      selectedFieldKeys: [...selectedFieldKeys.value],
      writeMode: formData.writeMode,
      fieldMappings: formData.radio === 2 ? mappingDraft.value.filter(item => item.source_key && item.target_field_id).map(item => ({ ...item })) : [],
    };
    loading.value = true;
    feedback.begin('正在启动作者搜索...');
    await nextTick();
    if (componentUnmounted) return;
    if (outputSnapshot.targetTableId && !(await validateTableFields(outputSnapshot.targetTableId, outputSnapshot.selectedFieldKeys, { writeMode: outputSnapshot.writeMode, uniqueKey: 'user_id', fieldMappings: outputSnapshot.fieldMappings, throwOnError: true }))) throw new Error('目标表字段校验失败，请检查表格字段类型');
    if (componentUnmounted) return;
    const filter_config = formData.social_type === 'douyin' ? { follower_count_range: formData.follower_count_range, user_type: formData.user_type } : {};
    await searchTask.submit(async () => {
      const response = await request({ url: buildFeishuApiPath('/v1/feishu/blogger/search/task'), method: 'post', headers: auth(), data: { social_type: formData.social_type, keyword: keywords, pages: formData.rangeType === 'all' ? 0 : Number(formData.pages), filter_config } });
      if (response.data?.sta !== 0) throw new Error(response.data?.msg || '创建任务失败');
      const task = response.data.data;
      const id = task?.task_id;
      if (!id) throw new Error('创建任务未返回任务ID');
      if (!componentUnmounted) showToast('任务已创建，正在准备获取作者…');
      return { taskId: id, apiBaseUrl: FEISHU_API_BASE_URL, apiPathPrefix: FEISHU_API_PATH_PREFIX, formData, tableName: keywords[0], totalPages: Number(task.total) || 0, ...outputSnapshot };
    }, onTaskReady);
  } catch (error) {
    if (componentUnmounted) return;
    loading.value = false;
    if (prepared) {
      const active = searchTask.getActiveTask();
      const reason = (active || error.taskCreated) && !taskId.value
        ? `${error?.response?.data?.msg || error.message || '保存任务进度失败'}；任务已创建，但恢复进度未能确认保存，请先核对结果再重新进入插件，勿重复启动。`
        : error;
      feedback.fail(reason, { persist: hasRecoverableTask.value || !!active || !!error.taskCreated, requiresReopen: !!active || !!error.taskCreated || !!error.requiresReopen });
    }
    else showErrorMsg(error.message || '提交失败，请稍后重试');
  } finally { submitting.value = false; }
};
const taskActionState = computed(() => {
  if (cancelling.value) return 'stopping';
  if (loading.value && taskId.value && searchTask.getActiveTask()?.taskId === taskId.value) return 'running';
  if (loading.value || submitting.value) return 'submitting';
  if (noticeRequiresReopen.value) return 'reopen';
  return 'idle';
});
const handleTaskAction = () => {
  if (taskActionState.value === 'running') return cancel();
  if (taskActionState.value === 'idle') return submit();
};
const initializing = ref(true);
const busy = computed(() => initializing.value || loading.value || submitting.value);
watch(busy, value => {
  emit('task-state', value);
  if (!value && tableConfigSaveQueued) saveTableOutputConfig(tableConfigSaves.values().next().value?.snapshot);
}, { immediate: true, flush: 'sync' });
const resumeTask = async () => {
  if (componentUnmounted || noticeRequiresReopen.value) return false;
  loading.value = true;
  feedback.begin('正在检查未完成任务…');
  await nextTick();
  if (componentUnmounted) return false;
  const restored = await searchTask.resume(task => onTaskReady(task, true)).catch(error => {
    hasRecoverableTask.value = true;
    throw error;
  });
  if (!restored && !componentUnmounted) {
    loading.value = false; taskId.value = ''; hasRecoverableTask.value = false; feedback.hide();
  }
  return restored;
};
const refreshSavedTask = async (reloadFields = true) => {
  if (componentUnmounted || noticeRequiresReopen.value || busy.value) return;
  initializing.value = true;
  try {
    await loadTableOutputConfigs();
    if (componentUnmounted) return;
    if (reloadFields && form.value.radio === 2 && form.value.table_id) await loadTableFields(form.value.table_id);
    await resumeTask();
  } catch (error) {
    if (componentUnmounted) return;
    loading.value = false;
    feedback.fail(error, { persist: true });
  } finally { initializing.value = false; }
};
defineExpose({ refreshSavedTask: () => refreshSavedTask(false) });
watch(() => props.api_key, () => refreshSavedTask());
onMounted(async () => {
  form.value.social_type = socialOptions.value[0]?.value || '';
  try {
    await Promise.all([loadFields(), loadTableOutputConfigs()]);
    await resumeTask();
  } catch (error) {
    if (componentUnmounted) return;
    loading.value = false;
    feedback.fail(error, { persist: true });
  } finally {
    initializing.value = false;
  }
});
onUnmounted(() => {
  componentUnmounted = true;
  searchTask.stop();
});
</script>

<template>
  <div class="blogger-search-page">
    <div class="form-card">
      <el-form class="form" :model="form" :disabled="busy || props.apiKeySaving" label-position="top">
        <fieldset class="settings-section" :disabled="busy || props.apiKeySaving" aria-labelledby="blogger-fetch-settings-title">
          <h2 id="blogger-fetch-settings-title" class="settings-section-heading">
            <span class="settings-step">1</span>
            <span>获取设置</span>
          </h2>
        <el-form-item label="">
          <div slot="label" class="c-label">
            平台
            <el-tooltip effect="dark" placement="top">
              <template #content>平台</template>
              <img src="https://cdn.zhinizhushou.com/material/20250826/45c287c837d7c34626a8f441264db162.png" class="help-icon" />
            </el-tooltip>
          </div>
          <el-select v-model="form.social_type" placeholder="请选择" style="width:100%">
            <el-option v-for="item in socialOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="">
          <div slot="label" class="c-label">作者关键词</div>
          <el-input v-model="form.keyword" type="textarea" :rows="4" placeholder="请输入作者关键词，支持批量添加，多个关键词可换行或用逗号分隔" />
        </el-form-item>
        <template v-if="isDouyin">
          <el-form-item label="">
            <div slot="label" class="c-label">粉丝量</div>
            <el-select v-model="form.follower_count_range" placeholder="请选择" style="width:100%">
              <el-option value="all" label="不限" />
              <el-option value="under_1k" label="1000 以下" />
              <el-option value="1k_to_10k" label="1000～1 万" />
              <el-option value="10k_to_100k" label="1 万～10 万" />
              <el-option value="100k_to_1m" label="10 万～100 万" />
              <el-option value="over_1m" label="100 万以上" />
            </el-select>
          </el-form-item>
          <el-form-item label="">
            <div slot="label" class="c-label">用户类型</div>
            <el-select v-model="form.user_type" placeholder="请选择" style="width:100%">
              <el-option value="all" label="不限" />
              <el-option value="regular_user" label="普通用户" />
              <el-option value="enterprise_verified" label="企业认证" />
              <el-option value="individual_verified" label="个人认证" />
            </el-select>
          </el-form-item>
        </template>
        <el-form-item label="">
          <div slot="label" class="c-label">作者获取范围</div>
          <el-radio-group v-model="form.rangeType" class="custom-radio-group">
            <el-radio value="all" class="custom-radio-item"><span class="radio-label-text">全部作者</span></el-radio>
            <el-radio value="pages" class="custom-radio-item">
              <span class="radio-label-text">前</span>
              <div class="custom-stepper-input range-stepper" :class="{ 'is-disabled': form.rangeType !== 'pages' }">
                <input v-model.number="form.pages" type="number" min="1" max="100" :disabled="form.rangeType !== 'pages'" @click.stop />
                <div class="stepper-buttons">
                  <button type="button" class="stepper-btn stepper-btn-up" :disabled="form.rangeType !== 'pages'" aria-label="增加页数" @click.stop="form.pages = Math.min(100, (form.pages || 1) + 1)"></button>
                  <button type="button" class="stepper-btn stepper-btn-down" :disabled="form.rangeType !== 'pages'" aria-label="减少页数" @click.stop="form.pages = Math.max(1, (form.pages || 1) - 1)"></button>
                </div>
              </div>
              <span class="range-unit">页</span>
            </el-radio>
          </el-radio-group>
        </el-form-item>
        </fieldset>

        <fieldset class="settings-section settings-section-output" :disabled="busy" aria-labelledby="blogger-output-settings-title">
          <h2 id="blogger-output-settings-title" class="settings-section-heading">
            <span class="settings-step">2</span>
            <span>输出设置</span>
          </h2>
        <el-form-item label="" style="margin-top: 0">
          <div class="field-stack">
            <div class="c-label">输出到表格</div>
            <el-radio-group v-model="form.radio" class="radio-block">
              <el-radio :value="1">新建表格</el-radio>
              <el-radio :value="2">使用现有表格</el-radio>
            </el-radio-group>
          </div>
        </el-form-item>
        <el-form-item v-if="form.radio === 2" label="">
          <div class="c-label">选择现有表格</div>
          <el-select v-model="form.table_id" placeholder="请选择" style="width:100%">
            <el-option v-for="table in tableOptions" :key="table.id" :label="table.name" :value="table.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.radio === 2" label="" style="margin-top: 0">
          <div class="field-stack">
            <div class="c-label">数据写入方式</div>
            <el-radio-group v-model="form.writeMode" class="radio-block" :disabled="!outputConfigReady">
              <el-radio value="upsert">更新或新增</el-radio>
              <el-radio value="append">始终新增</el-radio>
            </el-radio-group>
          </div>
        </el-form-item>
        <el-form-item label="" style="margin-top: 0">
          <div class="field-selection-content">
            <div class="field-selection-title"><div class="c-label">选择需要的字段</div></div>
            <el-checkbox :model-value="allSelected" class="select-all-fields" @change="toggleAll">全选</el-checkbox>
            <el-checkbox-group v-model="selectedFieldKeys" class="field-checkbox-group">
              <el-checkbox v-for="field in BLOGGER_FIELD_MAPPING" :key="field.key" :label="field.key" :disabled="requiredFieldKeys.includes(field.key)" class="field-checkbox-item">{{ field.name }}</el-checkbox>
            </el-checkbox-group>
          </div>
        </el-form-item>
        <div v-if="form.radio === 2" class="mapping-accordion">
          <button type="button" class="mapping-accordion-trigger" :aria-expanded="mappingExpanded" @click="mappingExpanded = !mappingExpanded">
            <span>字段映射 <span class="mapping-optional">（可选）</span> <span class="mapping-status">{{ mappingStatus }}</span></span>
            <span class="mapping-chevron" :class="{ 'is-expanded': mappingExpanded }"></span>
          </button>
          <div v-show="mappingExpanded" class="mapping-accordion-panel">
            <div v-if="mappingLoading" class="sub-hint">正在读取目标表字段...</div>
            <div v-else-if="!form.table_id" class="sub-hint">请先选择现有表格，再配置字段映射。</div>
            <template v-else>
              <p class="mapping-note">同名字段会自动匹配；不同名时可指定目标列。未映射且没有同名列时，将自动新建同名列。</p>
              <div v-for="(mapping, index) in mappingDraft" :key="`${mapping.source_key}-${index}`" class="mapping-row">
                <el-select v-model="mapping.source_key" :disabled="!outputConfigReady" placeholder="选择输出字段" size="small">
                  <el-option v-for="field in getMappingSourceFields(index)" :key="field.key" :label="field.name" :value="field.key" :disabled="field.disabled" />
                </el-select>
                <span class="mapping-arrow">→</span>
                <el-select v-model="mapping.target_field_id" :disabled="!outputConfigReady" placeholder="选择目标字段" size="small">
                  <el-option v-for="field in getMappingTargetFields(index)" :key="field.id" :label="field.name" :value="field.id" :disabled="field.disabled" />
                </el-select>
                <el-button link type="danger" class="mapping-delete" @click="mappingDraft.splice(index, 1)" :disabled="!outputConfigReady">删除</el-button>
              </div>
              <div class="mapping-actions"><el-button link type="primary" @click="mappingDraft.push({ source_key: '', target_field_id: '' })" :disabled="!outputConfigReady">+ 添加字段映射</el-button></div>
            </template>
          </div>
        </div>
        </fieldset>
      </el-form>
      <p v-if="taskNotice" class="sub-hint" role="status">{{ taskNotice }}</p>
        <el-button
          class="commit-btn"
          :class="{ 'is-running': taskActionState === 'running' || taskActionState === 'stopping' }"
          :loading="taskActionState === 'submitting' || taskActionState === 'stopping'"
          :disabled="props.apiKeySaving || (initializing && taskActionState !== 'running') || taskActionState === 'submitting' || taskActionState === 'stopping' || noticeRequiresReopen"
          @click="handleTaskAction"
        >{{ taskActionState === 'submitting' ? (taskId ? '执行中…' : '准备中…') : taskActionState === 'stopping' ? '正在停止…' : taskActionState === 'running' ? '停止任务' : noticeRequiresReopen ? (taskId ? '请重新进入插件恢复' : '请重新进入插件') : (taskId || hasRecoverableTask) ? '恢复任务' : '立即执行' }}</el-button>
    </div>

    <TaskFeedback :visible="toastVisible" :text="toastText" :kind="toastType" />
  </div>
</template>

<style scoped>
.search-note { margin: 0 0 16px; color: #86909c; font-size: 12px; line-height: 1.6; }
.settings-section { min-width: 0; margin: 0; padding: 0; border: 0; }
.settings-section:disabled { opacity: .65; }
.settings-section:disabled :deep(.el-select), .settings-section:disabled :deep(.el-checkbox), .settings-section:disabled :deep(.el-radio) { pointer-events: none; }
.settings-section-output { margin-top: 20px; padding-top: 20px; border-top: 1px solid #f0f1f3; }
.settings-section-heading { display:flex; align-items:center; gap:8px; margin:0 0 12px; color:#1d2129; font-size:16px; font-weight:500; line-height:22px; }
.settings-step { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; color:#a8071a; background:#fff1f2; border-radius:50%; font-size:12px; font-weight:600; line-height:20px; }
.field-stack,.field-selection-content { width:100%; }
.mapping-accordion { margin:12px 0 16px; border-top:1px solid #f0f1f3; border-bottom:1px solid #f0f1f3; }
.mapping-accordion-trigger { display:flex; align-items:center; justify-content:space-between; width:100%; min-height:48px; padding:12px 0; border:0; background:transparent; color:#1d2129; font:inherit; text-align:left; cursor:pointer; }
.mapping-optional,.mapping-status,.mapping-note { color:#86909c; font-size:12px; font-weight:400; }
.mapping-chevron { width:8px; height:8px; border-right:1px solid #86909c; border-bottom:1px solid #86909c; transform:rotate(45deg); transition:transform .2s ease; }
.mapping-chevron.is-expanded { transform:rotate(225deg); }
.mapping-accordion-panel { padding:0 0 12px; }
.mapping-note { margin:0 0 12px; line-height:18px; }
.mapping-row { display:grid; grid-template-columns:minmax(0,1fr) 12px minmax(0,1fr) auto; align-items:center; gap:4px; min-height:44px; border-top:1px solid #f0f1f3; }
.mapping-row :deep(.el-select__wrapper) { min-height:36px; height:36px; padding:0 12px; border-radius:6px; box-shadow:0 0 0 1px #e5e6eb inset; }
.mapping-arrow { color:#86909c; }
.mapping-delete { min-width:28px; padding:4px; }
.mapping-actions { display:flex; align-items:center; gap:12px; margin-top:8px; }
.mapping-actions :deep(.el-button) { margin-left:0; }
.sub-hint { margin:0 0 10px; color:#86909c; font-size:12px; line-height:18px; }
@media (max-width: 420px) {
  .mapping-row { grid-template-columns:minmax(0,1fr) 12px minmax(0,1fr); }
  .mapping-delete { grid-column:3; justify-self:end; }
}
.c-label { display:flex; align-items:center; margin-bottom:8px; color:#1d2129; font-size:14px; font-weight:500; line-height:20px; }
.help-icon { width:16px; height:16px; margin-left:4px; }
.radio-block { display:flex; flex-wrap:wrap; gap:16px; width:100%; }
.select-all-fields { margin-right:0; margin-bottom:8px; }
.field-selection-title { margin-bottom:8px; }
.field-checkbox-group { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 16px; width:100%; }
.field-checkbox-item,.field-checkbox-group :deep(.el-checkbox) { margin-right:0; align-items:center; }
.field-checkbox-group :deep(.el-checkbox__label) { padding-left:8px; color:#1d2129; line-height:22px; }
.field-checkbox-group :deep(.el-checkbox__inner) { width:16px; height:16px; border:1px solid #e5e6eb; border-radius:4px; }
.field-checkbox-group :deep(.el-checkbox:hover .el-checkbox__inner) { border-color:#86909c; }
.field-checkbox-group :deep(.el-checkbox__input.is-checked .el-checkbox__inner) { background:#a8071a; border-color:#a8071a; }
.field-checkbox-group :deep(.el-checkbox__input.is-disabled.is-checked .el-checkbox__inner) { background:#f7f8fa; border-color:#e5e6eb; }
.field-checkbox-group :deep(.el-checkbox__input.is-disabled.is-checked .el-checkbox__inner::after) { border-color:#c9cdd4; }
.field-checkbox-group :deep(.el-checkbox__input.is-disabled + .el-checkbox__label) { color:#c9cdd4; }
.field-checkbox-group :deep(.el-checkbox__input.is-checked + .el-checkbox__label) { color:#1d2129; }
.form :deep(.el-form-item__label) { margin-bottom:8px; color:#1d2129; font-size:14px; }
.form :deep(.el-form-item) { margin-bottom:16px; }
.form :deep(.el-form-item__content) { font-size:14px; }
.form :deep(.el-select__wrapper) { min-height:36px; height:36px; padding:0 12px; }
.form :deep(.el-input__wrapper) { min-height:36px; padding:0 12px; }
.form :deep(.el-textarea__inner) { min-height:80px; padding:8px 12px; }
.custom-radio-group { display:flex; flex-direction:column; gap:12px; width:100%; }
.custom-radio-group :deep(.el-radio) { display:flex; align-items:center; flex-wrap:nowrap; width:100%; margin-right:0; }
.custom-radio-group :deep(.el-radio__input) { flex-shrink:0; margin-right:8px; }
.custom-radio-group :deep(.el-radio__inner) { width:16px; height:16px; border-color:#e5e6eb; background:#fff; }
.custom-radio-group :deep(.el-radio__input.is-checked .el-radio__inner) { border-color:#a8071a; background:#fff; border-width:4px; }
.custom-radio-group :deep(.el-radio__inner::after) { display:none; }
.custom-radio-group :deep(.el-radio__label) { display:flex; align-items:center; width:100%; padding-left:0; color:#1d2129; font-size:14px; line-height:22px; }
.radio-label-text { flex-shrink:0; }
.custom-stepper-input { display:flex; align-items:center; width:80px; height:32px; margin-left:8px; overflow:hidden; border:1px solid #e5e6eb; border-radius:6px; background:#fff; }
.custom-stepper-input.is-disabled { background:#f2f3f5; }
.custom-stepper-input input { width:100%; height:100%; padding:0 8px; border:0; outline:0; background:transparent; font:inherit; }
.custom-stepper-input input::-webkit-outer-spin-button,.custom-stepper-input input::-webkit-inner-spin-button { margin:0; -webkit-appearance:none; }
.range-unit { flex-shrink:0; margin-left:8px; color:#4e5969; font-size:14px; white-space:nowrap; }
.range-cost { margin-top:8px; color:#86909c; font-size:12px; line-height:20px; }
.stepper-buttons { display:flex; flex-direction:column; width:28px; height:100%; flex-shrink:0; border-left:1px solid #e5e6eb; background:#f2f3f5; }
.stepper-btn { flex:1; width:100%; padding:0; border:0; background:transparent; cursor:pointer; }
.stepper-btn-up { border-bottom:1px solid #e5e6eb; }
.stepper-btn::before { display:block; width:0; height:0; margin:auto; border-right:4px solid transparent; border-left:4px solid transparent; content:''; }
.stepper-btn-up::before { border-bottom:4px solid #86909c; }
.stepper-btn-down::before { border-top:4px solid #86909c; }
.stepper-btn:not(:disabled):hover { background:#fff0f2; }
.stepper-btn:disabled { cursor:not-allowed; }
.blogger-search-page { background:#fffcfc; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
.form-card { box-sizing:border-box; margin:16px; padding:20px; background:#fff; border:1px solid #e5e6eb; border-radius:8px; }

.commit-btn { margin-top:0; }

</style>
