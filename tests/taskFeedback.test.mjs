import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, createSSRApp, h, nextTick, reactive } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { fakeTable, loadModules } from './helpers.mjs';

const flush = async () => { await new Promise(setImmediate); await nextTick(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function mount() {
  const host = await loadModules(['/src/components/BloggerSearch.vue'], 'development', { mockAxios: true });
  host.sdk.base.getTableList = async () => [];
  host.state.axiosHandler = async () => ({ data: { sta: 0, data: [] } });
  let view;
  const props = reactive({ api_key: 'test-key' });
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setElementText() {}, setText() {}, setComment() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ setup() { view = host.modules[0].default.setup(props, { expose() {}, emit() {} }); return () => h('div'); } });
  app.provide(Symbol.for('v-scx'), {});
  app.mount({});
  await flush();
  view.form.value.keyword = '猫咪';
  const render = async () => {
    const preview = createSSRApp({ setup: () => view, ssrRender: host.modules[0].default.ssrRender });
    preview.config.warnHandler = () => {};
    return renderToString(preview);
  };
  return { ...host, props, view, render, close: async () => { app.unmount(); await host.close(); } };
}

for (const nextState of ['new-task', 'finished', 'same-task']) {
  test(`作者停止请求延迟失败仅影响所属任务：${nextState}`, async t => {
    const host = await mount(), gate = deferred(), laterPoll = deferred();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let terminal = false, created = 0, holdPoll = false, pending;
    try {
      host.state.axiosHandler = async config => {
        if (config.url.endsWith('/cancel')) { await gate.promise; throw new Error('旧任务停止失败'); }
        if (config.url.endsWith('/list')) return { data: { sta: 0, data: { items: [] } } };
        if (config.method === 'get') {
          if (holdPoll) await laterPoll.promise;
          return { data: { sta: 0, data: { status: terminal && config.url.includes('task-1') ? 1 : 0, processed: 0, total: 10 } } };
        }
        return { data: { sta: 0, data: { task_id: `task-${++created}` } } };
      };
      await host.view.submit();
      assert.equal(host.view.taskId.value, 'task-1');
      pending = host.view.cancel();
      if (nextState !== 'same-task') {
        terminal = true;
        t.mock.timers.tick(2000); await flush();
        assert.equal(host.view.loading.value, false);
        if (nextState === 'new-task') {
          await host.view.submit();
          assert.equal(host.view.taskId.value, 'task-2');
          holdPoll = true;
        }
      }
      gate.resolve(); await pending; await flush();
      if (nextState === 'same-task') {
        assert.equal(host.view.cancelling.value, false);
        assert.equal(host.view.toastType.value, 'loading');
        assert.match(host.view.toastText.value, /任务继续执行.*请勿关闭插件/);
        assert.deepEqual(host.state.notices.map(n => n.message), ['旧任务停止失败']);
      } else if (nextState === 'finished') {
        assert.equal(host.view.loading.value, false);
        assert.equal(host.view.toastType.value, 'info');
        assert.equal(host.view.toastText.value, '处理完成，已写入 0 条作者');
      } else {
        assert.equal(host.view.loading.value, true);
        assert.equal(host.view.toastType.value, 'loading');
        assert.match(host.view.toastText.value, /正在获取作者.*请勿关闭插件/);
        t.mock.timers.tick(5000); await flush();
        assert.equal(host.view.toastVisible.value, true);
        assert.equal(host.view.taskId.value, 'task-2');
      }
      if (nextState !== 'same-task') assert.deepEqual(host.state.notices, []);
    } finally {
      gate.resolve(); await pending;
      await host.close();
      laterPoll.resolve(); await flush();
    }
  });
}

test('作者密钥失效暂停后更新密钥恢复同一任务，旧停止失败不覆盖新执行', async t => {
  const host = await mount(), stopPending = deferred(), writeStarted = deferred(), writePending = deferred();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let phase = 'running', pending, table, created = 0, restoredAuthorization;
  try {
    const addTable = host.sdk.base.addTable;
    host.sdk.base.addTable = async config => {
      const result = await addTable(config);
      table = host.state.tables.find(item => item.id === result.tableId);
      const addRecords = table.addRecords;
      table.addRecords = async records => { writeStarted.resolve(); await writePending.promise; return addRecords(records); };
      return result;
    };
    host.state.axiosHandler = async config => {
      if (config.url.endsWith('/cancel')) { await stopPending.promise; throw new Error('旧停止请求失败'); }
      if (config.url.endsWith('/table-output-configs')) return { data: { sta: 0, data: [] } };
      if (config.url.endsWith('/list')) return { data: { sta: 0, data: {
        items: phase === 'restored' && !config.data.after_id ? [{ user_id: 'author-1', social_type: 'xhs', nickname: '作者' }] : [],
        next_cursor: 'cursor-1', has_more: false,
      } } };
      if (config.method === 'get') {
        if (phase === 'auth-error') throw Object.assign(new Error('密钥失效'), { code: 'INVALID_API_KEY' });
        if (phase === 'restored') restoredAuthorization = config.headers.authorization;
        return { data: { sta: 0, data: { status: phase === 'restored' ? 3 : 0, processed: 1, total: 10 } } };
      }
      created++;
      return { data: { sta: 0, data: { task_id: 'same-task' } } };
    };
    await host.view.submit();
    const original = host.view.searchTask.getActiveTask();
    pending = host.view.cancel();
    phase = 'auth-error';
    t.mock.timers.tick(2000); await flush();
    assert.equal(host.view.searchTask.getActiveTask(), null);
    assert.equal(host.view.busy.value, false);
    assert.equal(host.state.saved.blogger_search_stream_task_v1.taskId, 'same-task');
    assert.match(host.view.taskNotice.value, /密钥失效/);

    phase = 'restored';
    host.props.api_key = 'updated-test-key';
    await writeStarted.promise; await flush();
    const current = host.view.searchTask.getActiveTask();
    assert.equal(current.taskId, original.taskId);
    assert.notEqual(current, original);
    assert.equal(created, 1);
    assert.equal(restoredAuthorization, 'Bearer updated-test-key');
    assert.equal(host.view.taskActionState.value, 'stopping');
    stopPending.resolve(); await pending; await flush();
    assert.equal(host.view.searchTask.getActiveTask(), current);
    assert.equal(host.view.taskActionState.value, 'stopping');
    assert.equal(host.view.cancelling.value, true);
    assert.equal(host.view.busy.value, true);
    assert.equal(host.view.toastType.value, 'loading');
    assert.match(await host.render(), /正在停止任务.*关闭会中断数据写入/);
    assert.equal(host.view.taskNotice.value, '');
    assert.deepEqual(host.state.notices, []);
    t.mock.timers.tick(5000); await flush();
    assert.equal(host.view.toastVisible.value, true);
    assert.equal(table.records.length, 0);
    writePending.resolve(); await flush();
    assert.equal(table.records.length, 1);
    assert.equal(table.writes, 1);
    t.mock.timers.tick(2000); await flush();
    assert.equal(host.view.busy.value, false);
    assert.equal(host.view.toastType.value, 'info');
    assert.equal(host.view.toastText.value, '任务已停止，已写入 1 条作者');
  } finally { stopPending.resolve(); writePending.resolve(); await pending; await flush(); await host.close(); }
});

test('作者停止失败只提示操作错误，实际SDK写入等待期间持续显示进度', async t => {
  const host = await mount(), writeStarted = deferred(), writePending = deferred();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let submitting, table;
  try {
    const addTable = host.sdk.base.addTable;
    host.sdk.base.addTable = async config => {
      const result = await addTable(config);
      table = host.state.tables.find(item => item.id === result.tableId);
      const addRecords = table.addRecords;
      table.addRecords = async records => { writeStarted.resolve(); await writePending.promise; return addRecords(records); };
      return result;
    };
    host.state.axiosHandler = async config => {
      if (config.url.endsWith('/cancel')) throw new Error('停止请求连接失败');
      if (config.url.endsWith('/list')) return { data: { sta: 0, data: {
        items: config.data.after_id ? [] : [{ user_id: 'author-1', social_type: 'xhs', nickname: '作者' }],
        next_cursor: 'cursor-1', has_more: false,
      } } };
      return { data: { sta: 0, data: config.method === 'get' ? { status: 0, processed: 1, total: 10 } : { task_id: 'write-task' } } };
    };
    submitting = host.view.submit();
    await writeStarted.promise;
    await host.view.cancel();
    assert.equal(host.view.loading.value, true);
    assert.equal(host.view.busy.value, true);
    assert.equal(host.view.cancelling.value, false);
    assert.equal(host.view.toastType.value, 'loading');
    assert.match(host.view.toastText.value, /任务继续执行.*请勿关闭插件/);
    assert.doesNotMatch(host.view.toastText.value, /正在停止/);
    assert.deepEqual(host.state.notices.map(n => n.message), ['停止请求连接失败']);
    t.mock.timers.tick(5000); await flush();
    assert.equal(host.view.toastVisible.value, true);
    assert.equal(table.records.length, 0);
    writePending.resolve(); await submitting;
    assert.equal(table.records.length, 1);
    assert.match(host.view.toastText.value, /已写入 1 条/);
    assert.equal(host.state.notices.length, 1);
  } finally { writePending.resolve(); await submitting; await host.close(); }
});

for (const confirmed of [{ status: 3 }, { status: 0, cancel_requested: true }, { status: 0, status_text: 'cancel_requested' }]) {
  test(`作者轮询已确认停止但SDK写入未完成时，迟到的停止失败保留收尾：${JSON.stringify(confirmed)}`, async t => {
    const host = await mount(), stopPending = deferred(), writeStarted = deferred(), writePending = deferred();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let confirmedByPoll = false, finished = false, pending, table, cancelRequests = 0;
    try {
      const addTable = host.sdk.base.addTable;
      host.sdk.base.addTable = async config => {
        const result = await addTable(config);
        table = host.state.tables.find(item => item.id === result.tableId);
        const addRecords = table.addRecords;
        table.addRecords = async records => { writeStarted.resolve(); await writePending.promise; return addRecords(records); };
        return result;
      };
      host.state.axiosHandler = async config => {
        if (config.url.endsWith('/cancel')) {
          cancelRequests++;
          await stopPending.promise;
          throw new Error('停止请求响应丢失');
        }
        if (config.url.endsWith('/list')) return { data: { sta: 0, data: {
          items: confirmedByPoll && !config.data.after_id ? [{ user_id: 'author-1', social_type: 'xhs', nickname: '作者' }] : [],
          next_cursor: 'cursor-1', has_more: false,
        } } };
        if (config.method === 'get') return { data: { sta: 0, data: {
          ...(finished ? { status: 3 } : confirmedByPoll ? confirmed : { status: 0 }), processed: 8, total: 10,
        } } };
        return { data: { sta: 0, data: { task_id: 'confirmed-stop-task' } } };
      };
      await host.view.submit();
      pending = host.view.cancel();
      confirmedByPoll = true;
      t.mock.timers.tick(2000); await writeStarted.promise;
      assert.equal(host.view.taskActionState.value, 'stopping');
      stopPending.resolve(); await pending; await flush();
      assert.equal(host.view.cancelling.value, true);
      assert.equal(host.view.taskActionState.value, 'stopping');
      assert.equal(host.view.busy.value, true);
      assert.equal(host.view.toastType.value, 'loading');
      assert.match(host.view.toastText.value, /正在停止.*请勿关闭插件，关闭会中断数据写入/);
      assert.doesNotMatch(host.view.toastText.value, /任务继续执行/);
      assert.deepEqual(host.state.notices.map(n => n.message), ['停止请求响应丢失']);
      t.mock.timers.tick(5000); await flush();
      assert.equal(host.view.toastVisible.value, true);
      assert.equal(table.records.length, 0);
      await host.view.handleTaskAction();
      assert.equal(cancelRequests, 1);
      writePending.resolve(); await flush();
      assert.equal(table.records.length, 1);
      assert.equal(table.writes, 1);
      finished = true;
      t.mock.timers.tick(2000); await flush();
      assert.equal(host.view.busy.value, false);
      assert.equal(host.view.toastType.value, 'info');
      assert.equal(host.view.toastText.value, '任务已停止，已写入 1 条作者');
    } finally {
      stopPending.resolve(); writePending.resolve(); await pending; await flush(); await host.close();
    }
  });
}

test('作者轮询直接确认已停止时，写入期间不再提供停止操作', async t => {
  const host = await mount(), writeStarted = deferred(), writePending = deferred();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let submitting, cancelRequests = 0;
  try {
    const addTable = host.sdk.base.addTable;
    host.sdk.base.addTable = async config => {
      const result = await addTable(config);
      const table = host.state.tables.find(item => item.id === result.tableId);
      const addRecords = table.addRecords;
      table.addRecords = async records => { writeStarted.resolve(); await writePending.promise; return addRecords(records); };
      return result;
    };
    host.state.axiosHandler = async config => {
      if (config.url.endsWith('/cancel')) cancelRequests++;
      return { data: { sta: 0, data: config.url.endsWith('/list') ? {
      items: config.data.after_id ? [] : [{ user_id: 'author-1', social_type: 'xhs', nickname: '作者' }],
      next_cursor: 'cursor-1', has_more: false,
      } : config.method === 'get' ? { status: '3', processed: 8, total: 10 } : { task_id: 'already-stopped-task' } } };
    };
    submitting = host.view.submit();
    await writeStarted.promise;
    assert.equal(host.view.taskActionState.value, 'stopping');
    assert.match(host.view.toastText.value, /正在停止.*关闭会中断数据写入/);
    assert.match(await host.render(), /正在停止任务，等待剩余作者写入完成后停止.*关闭会中断数据写入/);
    await host.view.handleTaskAction();
    assert.equal(cancelRequests, 0);
    writePending.resolve(); await submitting;
    t.mock.timers.tick(2000); await flush();
    assert.equal(host.view.toastText.value, '任务已停止，已写入 1 条作者');
  } finally { writePending.resolve(); await submitting; await host.close(); }
});

test('作者停止提示不把未获取的搜索页数说成待写入作者页数', async () => {
  const host = await mount(), stopPending = deferred();
  let pending;
  try {
    host.state.axiosHandler = async config => {
      if (config.url.endsWith('/cancel')) { await stopPending.promise; return { data: { sta: 0 } }; }
      return { data: { sta: 0, data: config.url.endsWith('/list') ? { items: [] }
        : config.method === 'get' ? { status: 0, processed: 8, total: 10 } : { task_id: 'page-count-task' } } };
    };
    await host.view.submit();
    pending = host.view.cancel();
    assert.doesNotMatch(host.view.toastText.value, /剩余\d+页作者未写入/);
    assert.match(host.view.toastText.value, /等待剩余作者写入完成后停止/);
  } finally { stopPending.resolve(); await pending; await host.close(); }
});

test('作者搜索提交HTTP未返回前已经展示进度并阻止第二次提交，准备失败退出加载', async () => {
  const host = await mount();
  const gate = deferred();
  let pending;
  try {
    let requests = 0;
    host.state.axiosHandler = async () => { requests++; await gate.promise; throw new Error('创建任务连接失败'); };
    pending = host.view.submit();
    await flush();
    assert.equal(host.view.toastVisible.value, true);
    assert.equal(host.view.toastLoading.value, true);
    assert.match(host.view.toastText.value, /正在启动作者搜索.*请勿关闭插件/);
    assert.equal(host.view.busy.value, true);
    await host.view.submit();
    assert.equal(requests, 1);
    gate.resolve(); await pending;
    assert.equal(host.view.loading.value, false);
    assert.equal(host.view.submitting.value, false);
    assert.equal(host.view.toastType.value, 'error');
    assert.equal(host.view.toastText.value, '创建任务连接失败');
    assert.equal(host.state.notices.length, 0);
  } finally { gate.resolve(); await pending; await host.close(); }
});

test('作者普通字段类型错误停留8秒且不锁定插件，同页修正后可以提交新任务', async t => {
  const host = await mount();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const table = fakeTable('target', '作者', [
      { id: 'uid', name: '作者ID', type: 1 }, { id: 'name', name: '作者名称', type: 2 },
    ]);
    host.state.tables.push(table);
    host.view.form.value.radio = 2; host.view.form.value.table_id = 'target'; await flush();
    host.view.selectedFieldKeys.value = ['user_id', 'nickname'];
    let creates = 0;
    host.state.axiosHandler = async config => {
      if (config.url.endsWith('/blogger/search/task')) { creates++; return { data: { sta: 0, data: { task_id: 'task-1' } } }; }
      return { data: { sta: 0, data: { status: 1, items: [], count: 0 } } };
    };
    await host.view.submit();
    assert.match(host.view.toastText.value, /字段.*作者名称.*类型不匹配/);
    assert.equal(host.view.noticeRequiresReopen.value, false);
    assert.equal(host.view.taskActionState.value, 'idle');
    assert.equal(host.view.busy.value, false);
    assert.equal(creates, 0);

    t.mock.timers.tick(7999); assert.equal(host.view.toastVisible.value, true);
    t.mock.timers.tick(1); assert.equal(host.view.toastVisible.value, false);

    table.fields[1].type = 1;
    await host.view.submit();
    assert.equal(creates, 1);
    assert.equal(host.view.noticeRequiresReopen.value, false);
    assert.doesNotMatch(host.view.toastText.value, /类型不匹配/);
  } finally { await host.close(); }
});

test('作者字段校验等待时先反馈，失败保留具体原因且只有一个浮动出口', async () => {
  const host = await mount();
  const gate = deferred();
  let pending;
  try {
    const table = fakeTable('target', '作者');
    host.state.tables.push(table);
    host.view.form.value.radio = 2; host.view.form.value.table_id = 'target';
    await flush();
    table.getFieldMetaList = async () => { await gate.promise; throw new Error('字段读取连接断开'); };
    pending = host.view.submit(); await flush();
    assert.equal(host.view.toastVisible.value, true);
    assert.equal(host.view.toastLoading.value, true);
    assert.equal(host.view.busy.value, true);
    await host.view.submit();
    gate.resolve(); await pending;
    assert.equal(host.view.toastType.value, 'error');
    assert.match(host.view.toastText.value, /字段读取连接断开/);
    assert.equal(host.view.busy.value, false);
    assert.equal(host.state.notices.length, 0);
  } finally { gate.resolve(); await pending; await host.close(); }
});

for (const [status, count, kind] of [[1, 0, 'info'], [3, 0, 'info'], [2, 0, 'error']]) {
  test(`作者任务终态 ${status} 不以成功图标展示空结果、停止或失败`, async () => {
    const host = await mount();
    try {
      host.state.axiosHandler = async config => ({ data: { sta: 0, data: config.url.endsWith('/list') ? { items: [] } : config.method === 'get' ? { status, reason: status === 2 ? '上游搜索失败' : '' } : { task_id: 'task-1' } } });
      await host.view.submit();
      assert.equal(host.view.toastType.value, kind);
      assert.equal(host.view.loading.value, false);
      assert.equal(host.view.toastLoading.value, false);
      assert.doesNotMatch(host.view.toastText.value, /请勿关闭/);
      assert.equal(host.state.notices.length, 0);
    } finally { await host.close(); }
  });
}


test('同步关键词校验只显示具体顶部错误且不启动加载', async () => {
  const host = await mount();
  try {
    host.view.form.value.keyword = '';
    await host.view.submit();
    assert.deepEqual(host.state.notices, [{ message: '请输入至少一个作者关键词', type: 'error', plain: true, duration: 3000 }]);
    assert.equal(host.view.toastVisible.value, false);
    assert.equal(host.view.busy.value, false);
  } finally { await host.close(); }
});

test('主动保存API Key失败保留旧值、释放保存状态且顶部错误显示5秒', async () => {
  const host = await loadModules(['/src/components/ApiKeySettings.vue']);
  let view;
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
  const app = renderer.createApp({ setup() { view = host.modules[0].default.setup({ locked: false }, { expose() {}, emit() {} }); return () => null; } });
  app.provide(Symbol.for('v-scx'), {});
  try {
    host.state.saved.api_key = 'old-key'; app.mount({}); await flush();
    host.sdk.bridge.setData = async () => { throw new Error('SDK保存拒绝'); };
    view.draft.value = 'new-key'; await view.save();
    assert.equal(view.savedKey.value, 'old-key'); assert.equal(host.state.saved.api_key, 'old-key');
    assert.equal(view.saving.value, false);
    assert.deepEqual(host.state.notices, [{ message: '保存 API Key 失败，请重试', type: 'error', plain: true, duration: 5000 }]);
  } finally { app.unmount(); await host.close(); }
});

test('作者任务异常后的原说明以普通状态文字保留在操作区', async () => {
  const host = await mount();
  try {
    host.state.axiosHandler = async config => {
      if (config.method === 'get') throw Object.assign(new Error('密钥需要更新后恢复原任务'), { code: 'INVALID_API_KEY' });
      return { data: { sta: 0, data: { task_id: 'task-1' } } };
    };
    await host.view.submit();
    assert.equal(host.view.loading.value, false);
    assert.match(host.view.taskNotice.value, /密钥需要更新后恢复原任务/);
    assert.match(await host.render(), /class="sub-hint" role="status"[^>]*>[^<]*密钥需要更新后恢复原任务/);
  } finally { await host.close(); }
});

test('主动保存API Key成功落地后顶部成功提示明确显示3秒', async () => {
  const host = await loadModules(['/src/components/ApiKeySettings.vue']);
  let view;
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
  const app = renderer.createApp({ setup() { view = host.modules[0].default.setup({ locked: false }, { expose() {}, emit() {} }); return () => null; } });
  app.provide(Symbol.for('v-scx'), {});
  try {
    host.state.saved.api_key = 'old-key'; app.mount({}); await flush();
    view.draft.value = 'new-key'; await view.save();
    assert.equal(view.savedKey.value, 'new-key'); assert.equal(host.state.saved.api_key, 'new-key');
    assert.equal(view.saving.value, false);
    assert.deepEqual(host.state.notices, [{ message: 'API Key 已保存', type: 'success', plain: true, duration: 3000 }]);
  } finally { app.unmount(); await host.close(); }
});
