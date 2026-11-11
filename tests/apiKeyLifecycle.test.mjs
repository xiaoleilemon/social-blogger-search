import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRenderer, createSSRApp, defineComponent, h, nextTick, onUnmounted } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { fakeTable, loadModules } from './helpers.mjs';

const flush = async () => { await new Promise(setImmediate); await nextTick(); };

async function mountScenario({ recoveryReadError = false, savedTask = null, authInvalid = false } = {}) {
  const host = await loadModules([
    '/src/App.vue', '/src/components/ApiKeySettings.vue', '/src/components/BloggerSearch.vue',
  ], 'development', { mockAxios: true });
  let app;
  try {
    host.state.saved.api_key = 'old-key';
    if (savedTask) host.state.saved.blogger_search_stream_task_v1 = structuredClone(savedTask);
    host.sdk.base.getTableList = async () => [];
    if (recoveryReadError) {
      const read = host.sdk.bridge.getData;
      host.sdk.bridge.getData = key => {
        if (key === 'blogger_search_stream_task_v1' && recoveryReadError) throw new Error('读取已保存任务失败');
        return read(key);
      };
    }
    const requests = [];
    host.state.axiosHandler = async config => {
      if (config.url.includes('/blogger/search/task')) {
        requests.push(config);
        if (authInvalid && config.method === 'get') throw Object.assign(new Error('密钥失效'), { code: 'INVALID_API_KEY' });
        return { data: { sta: 0, data: config.method === 'post' ? { task_id: 'task-1' } : { status: 0 } } };
      }
      return { data: { sta: 0, data: config.url.endsWith('/list') ? { items: [] } : [] } };
    };
    const [App, ApiKeySettings, BloggerSearch] = host.modules.map(module => module.default);
    const appSource = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
    const savedHandler = appSource.match(/<ApiKeySettings\b[^>]*@saved="(\w+)"/)?.[1];
    const searchRef = appSource.match(/<BloggerSearch\b[^>]*\bref="(\w+)"/)?.[1];
    const views = { unmounts: 0 };
    const KeyHost = defineComponent({ props: { locked: Boolean }, setup(props) {
      views.key = ApiKeySettings.setup(props, { expose() {}, emit(name, value) {
        if (name === 'ready') views.app.applyApiKey(value);
        if (name === 'saved') views.app[savedHandler](value);
        if (name === 'saving-state') views.app.apiKeySaving.value = value;
      } });
      return () => null;
    } });
    const SearchHost = defineComponent({ props: { api_key: String, apiKeySaving: Boolean }, setup(props, { expose }) {
      views.search = BloggerSearch.setup(props, { expose, emit(name, value) {
        if (name === 'task-state') views.app.running.value = value;
      } });
      onUnmounted(() => { views.unmounts++; });
      return () => null;
    } });
    const renderer = createRenderer({
      createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
      insert() {}, remove() {}, setElementText() {}, setText() {}, setComment() {}, patchProp() {},
      parentNode: () => null, nextSibling: () => null,
    });
    app = renderer.createApp({ setup() {
      views.app = App.setup({}, { expose() {} });
      return () => h('div', [
        h(KeyHost, { locked: views.app.running.value }),
        views.app.ready.value && views.app.apiKey.value ? h(SearchHost, {
          ref: searchRef ? views.app[searchRef] : undefined,
          api_key: views.app.apiKey.value, apiKeySaving: views.app.apiKeySaving?.value,
        }) : null,
      ]);
    } });
    app.provide(Symbol.for('v-scx'), {});
    app.mount({});
    await flush();
    const execute = async () => {
      views.search.form.value.keyword = '猫咪';
      await views.search.handleTaskAction();
      await flush();
    };
    const render = async () => {
      const preview = createSSRApp({ setup: () => views.search, ssrRender: BloggerSearch.ssrRender });
      preview.config.warnHandler = () => {};
      preview.component('el-button', { props: { disabled: Boolean }, setup: (props, { slots }) =>
        () => h('button', { disabled: props.disabled }, slots.default?.()) });
      return renderToString(preview);
    };
    return { ...host, views, requests, execute, render, setAuthInvalid: value => { authInvalid = value; }, setRecoveryReadError: value => { recoveryReadError = value; }, close: async () => { app.unmount(); await host.close(); } };
  } catch (error) { app?.unmount(); await host.close(); throw error; }
}

test('已保存任务读取失败时真实生命周期允许同页重试恢复，不能创建新任务覆盖', async () => {
  const host = await mountScenario({ recoveryReadError: true,
    savedTask: { taskId: 'old', baseId: 'base-1', cursor: 'old-cursor', writtenCount: 20 } });
  try {
    const { search } = host.views;
    assert.equal(search.initializing.value, false);
    assert.equal(search.noticeRequiresReopen.value, false);
    assert.match(await host.render(), /<button(?![^>]*\bdisabled\b)[^>]*>恢复任务<\/button>/);
    await host.execute(); await search.submit();
    assert.equal(host.requests.filter(config => config.method === 'post').length, 0);
    assert.match(search.taskNotice.value, /读取已保存任务失败/);
    host.setRecoveryReadError(false);
    await host.execute();
    assert.equal(search.searchTask.getActiveTask().taskId, 'old');
    assert.equal(search.searchTask.getActiveTask().cursor, 'old-cursor');
    assert.equal(host.requests.filter(config => config.method === 'post').length, 0);
  } finally { await host.close(); }
});

for (const result of ['updated', 'cleared', 'failed']) {
  test(`密钥保存延迟返回时禁止作者任务启动，保存${result}后按实际密钥执行`, async t => {
    const host = await mountScenario();
    let release, rejectSave, saving;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const gate = new Promise((resolve, reject) => { release = resolve; rejectSave = reject; });
      const setData = host.sdk.bridge.setData;
      host.sdk.bridge.setData = async (key, value) => {
        if (key === 'api_key') await gate;
        return setData(key, value);
      };
      const { views } = host;
      views.key.toggleEditing();
      views.key.draft.value = result === 'cleared' ? '' : 'new-key';
      saving = views.key.save();
      await flush();
      assert.equal(views.key.saving.value, true);
      assert.match(await host.render(), /<button[^>]*disabled[^>]*>立即执行<\/button>/);
      await host.execute();
      await views.search.submit();
      assert.equal(host.requests.length, 0, '保存尚未返回时不能用旧密钥创建任务');
      assert.equal(views.search.searchTask.getActiveTask(), null);
      assert.equal(views.search.toastVisible.value, false);

      if (result === 'failed') rejectSave(new Error('保存暂时失败'));
      else release();
      await saving;
      await flush();
      assert.equal(views.key.saving.value, false);
      assert.equal(views.app.apiKey.value, result === 'cleared' ? '' : result === 'failed' ? 'old-key' : 'new-key');
      if (result === 'cleared') {
        assert.equal(views.unmounts, 1);
        views.key.draft.value = 'new-key';
        await views.key.save();
        await flush();
      }
      assert.doesNotMatch(await host.render(), /<button[^>]*disabled[^>]*>立即执行<\/button>/);
      await host.execute();
      assert.equal(host.requests.filter(config => config.method === 'post').length, 1);
      assert.ok(host.requests.every(config => config.headers.authorization === `Bearer ${result === 'failed' ? 'old-key' : 'new-key'}`));
      assert.ok(views.search.searchTask.getActiveTask());
      assert.equal(views.search.taskActionState.value, 'running');
      t.mock.timers.tick(6000);
      await flush();
      assert.equal(views.search.loading.value, true);
      assert.equal(views.search.toastVisible.value, true);
      assert.match(views.search.toastText.value, /请勿关闭插件/);
    } finally { release?.(); await saving; await host.close(); }
  });
}

test('作者任务创建响应未返回时锁定密钥保存，进度持续显示', async () => {
  const host = await mountScenario();
  let release, executing;
  try {
    const gate = new Promise(resolve => { release = resolve; });
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.method === 'post' && config.url.endsWith('/blogger/search/task')) await gate;
      return request(config);
    };
    const { views } = host;
    views.key.toggleEditing();
    views.key.draft.value = 'new-key';
    executing = host.execute();
    await flush();
    assert.equal(views.app.running.value, true);
    assert.equal(views.search.toastVisible.value, true);
    await views.key.save();
    assert.equal(host.state.saved.api_key, 'old-key');
    assert.equal(views.key.saving.value, false);
    release();
    await executing;
    assert.equal(views.search.taskActionState.value, 'running');
    assert.equal(views.search.toastVisible.value, true);
    assert.equal(views.app.apiKey.value, 'old-key');
  } finally { release?.(); await executing; await host.close(); }
});


const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const taskKey = 'blogger_search_stream_task_v1';
const pausedTask = { taskId: 'auth-paused', baseId: 'base-1', cursor: 'cursor-10', writtenCount: 10 };
const creates = host => host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task'));
const statusReads = host => host.requests.filter(config => config.method === 'get' && config.url.includes('/blogger/search/task'));

for (const savedKey of ['old-key', 'new-key']) {
  for (const phase of ['storage', 'status']) {
    test(`鉴权暂停后保存${savedKey === 'old-key' ? '同值' : '新'}密钥，${phase}等待期间恢复原身份且不重复创建`, async () => {
      const host = await mountScenario({ savedTask: pausedTask, authInvalid: true });
      const saving = deferred(), restoring = deferred(); let savingKey;
      try {
        assert.equal(host.views.search.searchTask.getActiveTask(), null);
        assert.equal(host.views.app.running.value, false);
        host.setAuthInvalid(false);
        host.views.search.form.value.keyword = '保留的关键词';
        const save = host.sdk.bridge.setData;
        host.sdk.bridge.setData = async (key, value) => { if (key === 'api_key') await saving.promise; return save(key, value); };
        const read = host.sdk.bridge.getData;
        host.sdk.bridge.getData = async key => { if (key === taskKey && phase === 'storage') await restoring.promise; return read(key); };
        const request = host.state.axiosHandler;
        host.state.axiosHandler = async config => {
          if (phase === 'status' && config.method === 'get' && config.url.includes('/blogger/search/task')) await restoring.promise;
          return request(config);
        };
        host.views.key.toggleEditing(); host.views.key.draft.value = savedKey;
        savingKey = host.views.key.save(); await flush();
        await host.views.search.submit();
        assert.equal(creates(host).length, 0);
        saving.resolve(); await savingKey; await flush();
        assert.equal(host.views.app.running.value, true);
        assert.equal(host.views.search.loading.value, true);
        assert.equal(host.views.search.toastVisible.value, true);
        const restoringTask = host.views.search.searchTask.getActiveTask();
        assert.match(await host.render(), phase === 'storage'
          ? /<button[^>]*disabled[^>]*>执行中…<\/button>/
          : /<button(?![^>]*\bdisabled\b)[^>]*>停止任务<\/button>/);
        await host.views.search.submit();
        assert.equal(creates(host).length, 0);
        assert.equal(host.state.saved[taskKey].taskId, 'auth-paused');
        restoring.resolve(); await flush();
        assert.equal(host.views.search.searchTask.getActiveTask().taskId, 'auth-paused');
        assert.equal(host.views.search.searchTask.getActiveTask().cursor, 'cursor-10');
        assert.equal(host.views.search.searchTask.getActiveTask().writtenCount, 10);
        assert.equal(host.views.search.searchTask.getActiveTask(), restoringTask);
        assert.match(await host.render(), /<button(?![^>]*\bdisabled\b)[^>]*>停止任务<\/button>/);
        assert.equal(statusReads(host).length, 2, '首次鉴权失败和恢复各一次，不重复轮询');
        assert.equal(statusReads(host).at(-1).headers.authorization, `Bearer ${savedKey}`);
        assert.equal(creates(host).length, 0);
        assert.equal(host.views.unmounts, 0);
        assert.equal(host.views.search.form.value.keyword, '保留的关键词');
        await host.views.search.handleTaskAction();
        assert.equal(host.requests.filter(config => config.url.endsWith('/cancel')).length, 1);
      } finally { saving.resolve(); restoring.resolve(); await savingKey; await flush(); await host.close(); }
    });
  }
}

test('直接恢复旧任务时先渲染等待按钮，恢复后刷新为可用停止入口', async () => {
  const host = await mountScenario({ savedTask: pausedTask, authInvalid: true });
  const restoring = deferred(); let resuming;
  try {
    host.setAuthInvalid(false);
    const read = host.sdk.bridge.getData;
    host.sdk.bridge.getData = async key => { if (key === taskKey) await restoring.promise; return read(key); };
    resuming = host.views.search.handleTaskAction(); await flush();
    const restoringTask = host.views.search.searchTask.getActiveTask();
    assert.match(await host.render(), /<button[^>]*disabled[^>]*>执行中…<\/button>/);
    restoring.resolve(); await resuming; await flush();
    assert.equal(host.views.search.searchTask.getActiveTask(), restoringTask);
    assert.equal(restoringTask.taskId, 'auth-paused');
    assert.equal(restoringTask.cursor, 'cursor-10');
    assert.equal(creates(host).length, 0);
    assert.match(await host.render(), /<button(?![^>]*\bdisabled\b)[^>]*>停止任务<\/button>/);
    await host.views.search.handleTaskAction();
    assert.equal(host.requests.filter(config => config.url.endsWith('/cancel')).length, 1);
  } finally { restoring.resolve(); await resuming; await host.close(); }
});

test('暂停后同值保存失败不自动恢复，显式执行仍恢复原任务而非新建', async () => {
  const host = await mountScenario({ savedTask: pausedTask, authInvalid: true });
  try {
    host.setAuthInvalid(false);
    const save = host.sdk.bridge.setData;
    host.sdk.bridge.setData = async (key, value) => { if (key === 'api_key') throw new Error('密钥保存失败'); return save(key, value); };
    host.views.key.toggleEditing(); await host.views.key.save(); await flush();
    assert.equal(statusReads(host).length, 1);
    assert.equal(host.state.saved[taskKey].taskId, 'auth-paused');
    await host.execute();
    assert.equal(creates(host).length, 0);
    assert.equal(host.views.search.searchTask.getActiveTask().taskId, 'auth-paused');
    assert.equal(host.views.search.searchTask.getActiveTask().cursor, 'cursor-10');
  } finally { await host.close(); }
});

test('读取失败时同值保存重试恢复，读取恢复后沿用旧任务而非新建', async () => {
  const host = await mountScenario({ savedTask: pausedTask, recoveryReadError: true });
  try {
    host.views.key.toggleEditing(); await host.views.key.save(); await flush();
    assert.equal(host.views.search.noticeRequiresReopen.value, false);
    assert.match(host.views.search.taskNotice.value, /读取已保存任务失败/);
    await host.execute();
    assert.equal(creates(host).length, 0);
    assert.equal(host.state.saved[taskKey].taskId, 'auth-paused');
    host.setRecoveryReadError(false);
    host.views.key.toggleEditing(); await host.views.key.save(); await flush();
    assert.equal(host.views.search.searchTask.getActiveTask().taskId, 'auth-paused');
    assert.equal(host.views.search.searchTask.getActiveTask().cursor, 'cursor-10');
    assert.equal(creates(host).length, 0);
  } finally { await host.close(); }
});

test('没有旧任务时同值保存保留表单，恢复检查结束后可正常新建', async () => {
  const host = await mountScenario();
  try {
    host.views.search.form.value.keyword = '保留的关键词';
    host.views.key.toggleEditing(); await host.views.key.save(); await flush();
    assert.equal(host.views.search.form.value.keyword, '保留的关键词');
    assert.equal(host.views.unmounts, 0);
    assert.equal(host.views.search.loading.value, false);
    assert.equal(creates(host).length, 0);
    await host.execute();
    assert.equal(creates(host).length, 1);
  } finally { await host.close(); }
});

test('已知暂停任务的恢复记录已清理时，同值保存释放旧身份，后续正常新建', async () => {
  const host = await mountScenario({ savedTask: pausedTask, authInvalid: true });
  try {
    host.setAuthInvalid(false);
    host.state.saved[taskKey] = {};
    host.views.search.form.value.keyword = '保留的关键词';
    host.views.key.toggleEditing(); await host.views.key.save(); await flush();
    assert.equal(host.views.search.taskId.value, '');
    assert.equal(host.views.search.searchTask.getActiveTask(), null);
    assert.equal(host.views.app.running.value, false);
    assert.equal(host.views.search.form.value.keyword, '保留的关键词');
    await host.execute();
    assert.equal(creates(host).length, 1);
    assert.equal(host.views.search.searchTask.getActiveTask().taskId, 'task-1');
  } finally { await host.close(); }
});


test('同值保存恢复检查不覆盖尚未保存完的字段映射', async () => {
  const host = await mountScenario();
  const savingConfig = deferred();
  try {
    const table = fakeTable('target', '作者', [{ id: 'old-field', name: '旧字段', type: 1 }, { id: 'new-field', name: '新字段', type: 1 }]);
    table.getName = async () => '作者'; host.state.tables.push(table);
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.url.endsWith('table-output-configs')) return { data: { sta: 0, data: [{ target_table_id: 'target', field_mappings: [{ source_key: 'nickname', target_field_id: 'old-field' }] }] } };
      if (config.method === 'put') { await savingConfig.promise; return { data: { sta: 0, data: config.data } }; }
      return request(config);
    };
    const search = host.views.search;
    search.form.value.radio = 2; search.form.value.table_id = 'target'; await flush();
    search.mappingDraft.value = [{ source_key: 'nickname', target_field_id: 'new-field' }]; await flush();
    assert.equal(search.tableConfigSaving.value, true);
    host.views.key.toggleEditing(); await host.views.key.save(); await flush();
    assert.equal(search.mappingDraft.value[0].target_field_id, 'new-field');
    assert.equal(creates(host).length, 0);
  } finally { savingConfig.resolve(); await flush(); await host.close(); }
});
