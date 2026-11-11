import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, createSSRApp, h, reactive, nextTick } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { ElButton, ElForm, ElInput, ElRadioGroup, ElRadio, ID_INJECTION_KEY } from 'element-plus';
import { fakeTable, loadModules } from './helpers.mjs';

const flush = async () => { await new Promise(setImmediate); await nextTick(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const storageKey = 'blogger_search_stream_task_v1';

async function mount(t, configure = () => {}, existingHost = null) {
  const host = existingHost || await loadModules(['/src/components/BloggerSearch.vue'], 'development', { mockAxios: true });
  const component = host.modules[0].default, requests = existingHost?.requests || [];
  if (!existingHost) host.sdk.base.getTableList = async () => [];
  if (!existingHost) host.state.axiosHandler = async config => {
    requests.push(config);
    if (config.url.endsWith('/cancel')) return { data: { sta: 0 } };
    if (config.url.endsWith('/list')) return { data: { sta: 0, data: { items: [] } } };
    if (config.url.includes('table-output-config')) return { data: { sta: 0, data: [] } };
    return { data: { sta: 0, data: config.method === 'post' ? { task_id: 'new' } : { status: 0 } } };
  };
  configure(host);
  const props = reactive({ api_key: 'test-key', apiKeySaving: false });
  let view;
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setElementText() {}, setText() {}, setComment() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ setup() { view = component.setup(props, { expose() {}, emit() {} }); return () => h('div'); } });
  app.provide(Symbol.for('v-scx'), {});
  let unmounted = false;
  const unmount = () => { if (!unmounted) { unmounted = true; app.unmount(); } };
  t.after(async () => { unmount(); if (!existingHost) await host.close(); });
  app.mount({}); await flush();
  const html = async () => {
    const preview = createSSRApp({ setup: () => view, ssrRender: component.ssrRender });
    preview.config.warnHandler = () => {};
    for (const [name, component] of Object.entries({ ElButton, ElForm, ElInput, ElRadioGroup, ElRadio })) preview.component(name, component);
    preview.provide(ID_INJECTION_KEY, { prefix: 1, current: 0 });
    return renderToString(preview);
  };
  const button = async () => {
    const output = await html();
    const node = [...output.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[1].includes('commit-btn'));
    assert.ok(node);
    return { text: node[2].replace(/<[^>]+>/g, '').trim(), disabled: /\sdisabled\b/.test(node[1]), loading: node[1].includes('is-loading') };
  };
  return { ...host, props, view, button, html, requests, unmount };
}

test('任务身份准备好前保持准备中，首轮轮询未返回时可停止且不会重复取消', async t => {
  const selection = deferred(), status = deferred(); let running;
  const host = await mount(t);
  host.sdk.base.getSelection = async () => { await selection.promise; return { baseId: 'base-1' }; };
  const request = host.state.axiosHandler;
  host.state.axiosHandler = async config => {
    if (config.method === 'get' && config.url.includes('/blogger/search/task')) { await status.promise; return { data: { sta: 0, data: { status: 3 } } }; }
    return request(config);
  };
  try {
    host.view.form.value.keyword = '猫';
    running = host.view.handleTaskAction(); await flush();
    assert.deepEqual(await host.button(), { text: '准备中…', disabled: true, loading: true });
    assert.equal(host.view.taskId.value, '');
    selection.resolve(); await flush();
    assert.equal(host.state.saved[storageKey].taskId, 'new');
    assert.deepEqual(await host.button(), { text: '停止任务', disabled: false, loading: false });
    await host.view.handleTaskAction(); await host.view.handleTaskAction();
    assert.equal(host.requests.filter(config => config.url.endsWith('/cancel')).length, 1);
    assert.deepEqual(await host.button(), { text: '正在停止…', disabled: true, loading: true });
    status.resolve(); await running;
    assert.deepEqual(await host.button(), { text: '立即执行', disabled: false, loading: false });
  } finally { selection.resolve(); status.resolve(); await running; }
});

test('恢复同一任务时首轮轮询等待不禁用已可用的停止入口', async t => {
  const status = deferred();
  const host = await mount(t, host => {
    host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1' };
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.method === 'get' && config.url.includes('/blogger/search/task')) { await status.promise; return { data: { sta: 0, data: { status: 3 } } }; }
      return request(config);
    };
  });
  try {
    assert.equal(host.view.searchTask.getActiveTask().taskId, 'old');
    assert.deepEqual(await host.button(), { text: '停止任务', disabled: false, loading: false });
    await host.view.handleTaskAction();
    assert.equal(host.requests.find(config => config.url.endsWith('/cancel')).data.task_id, 'old');
    assert.deepEqual(await host.button(), { text: '正在停止…', disabled: true, loading: true });
  } finally { status.resolve(); await flush(); }
});

test('旧任务保存失败需重开时，更换密钥不能清保护或创建新任务覆盖旧进度', async t => {
  const host = await mount(t, host => {
    host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1' };
    const save = host.sdk.bridge.setData; let failures = 0;
    host.sdk.bridge.setData = async (key, value) => {
      if (key === storageKey && failures++ < 2) throw new Error('飞书写入任务进度失败');
      return save(key, value);
    };
  });
  assert.equal(host.view.noticeRequiresReopen.value, true);
  host.props.api_key = 'updated-key'; await flush();
  assert.deepEqual(await host.button(), { text: '请重新进入插件恢复', disabled: true, loading: false });
  assert.match(host.view.taskNotice.value, /飞书写入任务进度失败/);
  host.view.form.value.keyword = '猫';
  await host.view.handleTaskAction(); await host.view.submit();
  assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
  assert.equal(host.view.searchTask.getActiveTask(), null);
  assert.equal(host.state.saved[storageKey].taskId, 'old');
});

test('普通鉴权暂停仍允许换密钥恢复原任务，不误用重开保护', async t => {
  const host = await mount(t, host => {
    host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1' };
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.method === 'get' && config.url.includes('/blogger/search/task') && config.headers.authorization === 'Bearer test-key') throw Object.assign(new Error('密钥失效'), { code: 'INVALID_API_KEY' });
      return request(config);
    };
  });
  assert.equal(host.view.noticeRequiresReopen.value, false);
  host.props.api_key = 'updated-key'; await flush();
  assert.equal(host.view.searchTask.getActiveTask().taskId, 'old');
  assert.deepEqual(await host.button(), { text: '停止任务', disabled: false, loading: false });
  assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
});

for (const stage of ['getData', 'getSelection']) {
  test(`恢复进度${stage}只读失败后可同页恢复，不误建新任务`, async t => {
    let blocked = true, readingTask = false;
    const host = await mount(t, host => {
      host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1', cursor: 'old-cursor', writtenCount: 20 };
      const read = host.sdk.bridge.getData, selection = host.sdk.base.getSelection;
      host.sdk.bridge.getData = async key => {
        if (key === storageKey) {
          readingTask = true;
          if (stage === 'getData' && blocked) throw new Error('临时读取恢复进度失败');
        }
        return read(key);
      };
      host.sdk.base.getSelection = async () => {
        if (stage === 'getSelection' && readingTask && blocked) throw new Error('临时读取当前表格失败');
        return selection();
      };
    });
    assert.equal(host.view.noticeRequiresReopen.value, false);
    assert.deepEqual(await host.button(), { text: '恢复任务', disabled: false, loading: false });
    assert.match(host.view.taskNotice.value, /临时读取/);
    assert.doesNotMatch(host.view.taskNotice.value, /关闭|重新进入/);
    await host.view.handleTaskAction();
    assert.deepEqual(await host.button(), { text: '恢复任务', disabled: false, loading: false });
    assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
    blocked = false;
    host.view.form.value.keyword = '新的关键词';
    await host.view.handleTaskAction();
    assert.equal(host.view.searchTask.getActiveTask().taskId, 'old');
    assert.equal(host.view.searchTask.getActiveTask().cursor, 'old-cursor');
    assert.equal(host.state.saved[storageKey].writtenCount, 20);
    assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
    assert.deepEqual(await host.button(), { text: '停止任务', disabled: false, loading: false });
  });
}

for (const applied of [false, true]) {
  test(`终态清理失败（已生效=${applied}）不误报完成，同页重试确认清理后才开放新任务`, async t => {
    let clearAttempts = 0;
    const host = await mount(t, host => {
      host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1', cursor: 'last-cursor', writtenCount: 20 };
      const save = host.sdk.bridge.setData, request = host.state.axiosHandler;
      host.sdk.bridge.setData = async (key, value) => {
        if (key === storageKey && !value.taskId && ++clearAttempts === 1) {
          if (applied) await save(key, value);
          throw new Error('清理请求连接失败');
        }
        return save(key, value);
      };
      host.state.axiosHandler = async config => config.method === 'get' && config.url.includes('/blogger/search/task')
        ? { data: { sta: 0, data: { status: 1 } } } : request(config);
    });
    assert.deepEqual(await host.button(), { text: '恢复任务', disabled: false, loading: false });
    assert.equal(host.view.toastType.value, 'error');
    assert.match(host.view.taskNotice.value, /清理.*失败/);
    assert.doesNotMatch(host.view.toastText.value, /处理完成/);
    await host.view.handleTaskAction();
    assert.deepEqual(host.state.saved[storageKey], {});
    assert.deepEqual(await host.button(), { text: '立即执行', disabled: false, loading: false });
    assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
    assert.equal(host.state.tables.length, 0, '重试清理不应创建或写入表格');
    assert.equal(clearAttempts, applied ? 1 : 2);
  });
}

test('终态清理失败晚于卸载时不回写旧页面，新实例可清理原任务', async t => {
  const gate = deferred(); let clearAttempts = 0;
  const old = await mount(t, host => {
    host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1', cursor: 'last-cursor', writtenCount: 20 };
    const save = host.sdk.bridge.setData, request = host.state.axiosHandler;
    host.sdk.bridge.setData = async (key, value) => {
      if (key === storageKey && !value.taskId && ++clearAttempts === 1) {
        await gate.promise;
        throw new Error('旧清理请求失败');
      }
      return save(key, value);
    };
    host.state.axiosHandler = async config => config.method === 'get' && config.url.includes('/blogger/search/task')
      ? { data: { sta: 0, data: { status: 1 } } } : request(config);
  });
  try {
    old.unmount();
    const reopened = await mount(t, () => {}, old);
    assert.deepEqual(await reopened.button(), { text: '准备中…', disabled: true, loading: true });
    gate.resolve(); await flush();
    assert.equal(old.view.toastVisible.value, false);
    assert.equal(old.view.taskNotice.value, '');
    assert.deepEqual(old.state.saved[storageKey], {});
    assert.deepEqual(await reopened.button(), { text: '立即执行', disabled: false, loading: false });
    assert.equal(reopened.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
  } finally { gate.resolve(); await flush(); }
});

test('暂停后按钮说明恢复旧任务，恢复和完成后随实际动作切换', async t => {
  let authInvalid = true, status = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await mount(t, host => {
    host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1', cursor: 'old-cursor' };
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.method === 'get' && config.url.includes('/blogger/search/task')) {
        if (authInvalid) throw Object.assign(new Error('密钥失效'), { code: 'INVALID_API_KEY' });
        return { data: { sta: 0, data: { status, processed: 0 } } };
      }
      return request(config);
    };
  });
  assert.deepEqual(await host.button(), { text: '恢复任务', disabled: false, loading: false });
  authInvalid = false;
  host.view.form.value.keyword = '新的关键词';
  await host.view.handleTaskAction();
  assert.equal(host.view.searchTask.getActiveTask().taskId, 'old');
  assert.equal(host.view.searchTask.getActiveTask().cursor, 'old-cursor');
  assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
  assert.deepEqual(await host.button(), { text: '停止任务', disabled: false, loading: false });
  status = 1;
  t.mock.timers.tick(2000); await flush();
  assert.equal(host.view.taskId.value, '');
  assert.deepEqual(await host.button(), { text: '立即执行', disabled: false, loading: false });
  await host.view.handleTaskAction();
  assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 1);
});

for (const phase of ['identity', 'poll']) {
  test(`新建任务${phase}保存失败后保持保护，不能再次创建覆盖原任务`, async t => {
    let writes = 0;
    const host = await mount(t, host => {
      const save = host.sdk.bridge.setData;
      host.sdk.bridge.setData = async (key, value) => {
        if (key === storageKey && (phase === 'identity' || writes++ > 0)) throw new Error('保存任务进度失败');
        return save(key, value);
      };
    });
    host.view.form.value.keyword = '猫';
    await host.view.handleTaskAction(); await flush();
    assert.equal(host.view.noticeRequiresReopen.value, true);
    const paused = await host.button();
    assert.equal(paused.disabled, true);
    assert.equal(paused.text, phase === 'identity' ? '请重新进入插件' : '请重新进入插件恢复');
    if (phase === 'identity') assert.match(host.view.taskNotice.value, /任务已创建.*未能确认保存.*勿重复启动/);
    host.props.api_key = 'updated-key'; await flush();
    await host.view.handleTaskAction(); await host.view.submit();
    assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 1);
    assert.equal(host.view.searchTask.getActiveTask(), null);
    if (phase === 'poll') assert.equal(host.state.saved[storageKey].taskId, 'new');
  });
}

test('终态清理等待时不再提供停止，但清理完成前不能创建下一任务', async t => {
  const clear = deferred();
  const host = await mount(t, host => {
    host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1' };
    const save = host.sdk.bridge.setData;
    host.sdk.bridge.setData = async (key, value) => {
      if (key === storageKey && !value.taskId) await clear.promise;
      return save(key, value);
    };
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => config.method === 'get' && config.url.includes('/blogger/search/task')
      ? { data: { sta: 0, data: { status: 1 } } } : request(config);
  });
  try {
    assert.equal(host.view.searchTask.getActiveTask(), null);
    assert.deepEqual(await host.button(), { text: '执行中…', disabled: true, loading: true });
    await host.view.handleTaskAction(); await host.view.submit();
    assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
    clear.resolve(); await flush();
    assert.deepEqual(await host.button(), { text: '立即执行', disabled: false, loading: false });
  } finally { clear.resolve(); await flush(); }
});

test('创建响应晚返回只保存身份供新实例恢复，不启动已卸载页面', async t => {
  const reply = deferred(), sent = deferred(); let creating, creates = 0;
  const old = await mount(t, host => {
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.method === 'post' && config.url.endsWith('/blogger/search/task')) {
        creates++; sent.resolve(); await reply.promise;
        return { data: { sta: 0, data: { task_id: 'late-task' } } };
      }
      return request(config);
    };
  });
  try {
    old.view.form.value.keyword = '猫';
    creating = old.view.handleTaskAction(); await sent.promise; old.unmount();
    const reopened = await mount(t, () => {}, old);
    assert.equal(reopened.view.initializing.value, true);
    await reopened.view.handleTaskAction(); await reopened.view.submit();
    assert.equal(creates, 1);
    reply.resolve(); await creating; await flush();
    assert.equal(old.view.searchTask.getActiveTask(), null);
    assert.equal(old.view.toastVisible.value, false);
    assert.equal(reopened.view.searchTask.getActiveTask().taskId, 'late-task');
    assert.equal(reopened.state.saved[storageKey].taskId, 'late-task');
    assert.equal(reopened.requests.filter(config => config.url.includes('task?task_id=late-task')).length, 1);
  } finally { reply.resolve(); await creating; await flush(); }
});

test('初始化读取晚返回不在卸载实例恢复任务', async t => {
  const fields = deferred();
  const old = await mount(t, host => {
    host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1' };
    const get = host.sdk.bridge.getData;
    host.sdk.bridge.getData = async key => {
      if (key === 'blogger_search_selected_fields_v1') await fields.promise;
      return get(key);
    };
  });
  try {
    old.unmount(); fields.resolve(); await flush();
    assert.equal(old.view.searchTask.getActiveTask(), null);
    assert.equal(old.requests.filter(config => config.url.includes('task?task_id=old')).length, 0);
    const reopened = await mount(t, () => {}, old);
    assert.equal(reopened.view.searchTask.getActiveTask().taskId, 'old');
    assert.equal(reopened.requests.filter(config => config.url.includes('task?task_id=old')).length, 1);
  } finally { fields.resolve(); await flush(); }
});

test('重进先等待旧清理，完成后新任务记录不被旧实例擦除', async t => {
  const clear = deferred(), entered = deferred(); let clears = 0;
  const old = await mount(t, host => {
    host.state.saved[storageKey] = { taskId: 'previous', baseId: 'base-1' };
    const save = host.sdk.bridge.setData, request = host.state.axiosHandler;
    host.sdk.bridge.setData = async (key, value) => {
      if (key === storageKey && !value.taskId && ++clears === 1) { entered.resolve(); await clear.promise; }
      return save(key, value);
    };
    host.state.axiosHandler = async config => config.url.includes('task?task_id=previous')
      ? { data: { sta: 0, data: { status: 1 } } } : request(config);
  });
  try {
    await entered.promise; old.unmount();
    const reopened = await mount(t, () => {}, old);
    assert.equal(reopened.view.initializing.value, true);
    await reopened.view.submit();
    assert.equal(reopened.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
    clear.resolve(); await flush();
    assert.equal(old.view.toastVisible.value, false);
    reopened.view.form.value.keyword = '猫'; await reopened.view.handleTaskAction();
    assert.equal(reopened.state.saved[storageKey].taskId, 'new');
    assert.equal(reopened.view.searchTask.getActiveTask().taskId, 'new');
    assert.equal(clears, 1);
  } finally { clear.resolve(); await flush(); }
});

test('后续定时轮询保存和补存失败时正确暂停，不留下永久停止状态', async t => {
  const host = await mount(t), scheduled = [];
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if ([2000, 4000, 8000, 16000, 30000].includes(ms)) { scheduled.push(callback); return {}; }
    return timeout(callback, ms, ...args);
  });
  host.view.form.value.keyword = '猫'; await host.view.handleTaskAction();
  assert.equal(scheduled.length, 1);
  const save = host.sdk.bridge.setData; let attempts = 0;
  host.sdk.bridge.setData = async (key, value) => {
    if (key === storageKey) { attempts++; throw new Error('后续保存失败'); }
    return save(key, value);
  };
  await scheduled.shift()(); await flush();
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 0);
  assert.equal(host.view.loading.value, false);
  assert.equal(host.view.noticeRequiresReopen.value, true);
  assert.match(host.view.taskNotice.value, /后续保存失败/);
  assert.equal((await host.button()).disabled, true);
  await host.view.handleTaskAction();
  assert.equal(host.requests.filter(config => config.url.endsWith('/cancel')).length, 0);
});

for (const confirmed of [{ status: 3 }, { status: 0, cancel_requested: true }, { status: 0, status_text: 'cancel_requested' }]) {
  test(`恢复已确认停止状态${JSON.stringify(confirmed)}，首轮状态等待不重复取消`, async t => {
    const status = deferred();
    const host = await mount(t, host => {
      host.state.saved[storageKey] = { taskId: 'stopped', baseId: 'base-1', latestStatus: confirmed };
      const request = host.state.axiosHandler;
      host.state.axiosHandler = async config => {
        if (config.url.includes('task?task_id=stopped')) { await status.promise; return { data: { sta: 0, data: { status: 3 } } }; }
        return request(config);
      };
    });
    try {
      assert.deepEqual(await host.button(), { text: '正在停止…', disabled: true, loading: true });
      assert.match(host.view.toastText.value, /正在停止任务.*请勿关闭插件，关闭会中断数据写入/);
      await host.view.handleTaskAction(); await host.view.cancel();
      assert.equal(host.requests.filter(config => config.url.endsWith('/cancel')).length, 0);
    } finally { status.resolve(); await flush(); }
  });
}


test('身份保存尚未结束时重进等待旧保存，只由新实例轮询', async t => {
  const writing = deferred(), release = deferred(); let creating;
  const old = await mount(t);
  const save = old.sdk.bridge.setData;
  old.sdk.bridge.setData = async (key, value) => {
    if (key === storageKey) { writing.resolve(); await release.promise; }
    return save(key, value);
  };
  try {
    old.view.form.value.keyword = '猫';
    creating = old.view.handleTaskAction(); await writing.promise; old.unmount();
    const reopened = await mount(t, () => {}, old);
    assert.equal(reopened.view.initializing.value, true);
    await reopened.view.submit();
    release.resolve(); await creating; await flush();
    assert.equal(old.view.searchTask.getActiveTask(), null);
    assert.equal(reopened.view.searchTask.getActiveTask().taskId, 'new');
    assert.equal(reopened.requests.filter(config => config.url.includes('task?task_id=new')).length, 1);
    assert.equal(reopened.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 1);
  } finally { release.resolve(); await creating; await flush(); }
});

test('创建成功但身份保存失败，重进补存原身份而不重复创建', async t => {
  const old = await mount(t);
  const save = old.sdk.bridge.setData;
  old.sdk.bridge.setData = async (key, value) => {
    if (key === storageKey) throw new Error('身份保存失败');
    return save(key, value);
  };
  old.view.form.value.keyword = '猫'; await old.view.handleTaskAction();
  assert.equal(old.state.saved[storageKey], undefined);
  assert.equal(old.view.noticeRequiresReopen.value, true);
  old.unmount(); old.sdk.bridge.setData = save;
  const reopened = await mount(t, () => {}, old);
  assert.equal(reopened.view.searchTask.getActiveTask().taskId, 'new');
  assert.equal(reopened.state.saved[storageKey].taskId, 'new');
  assert.equal(reopened.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 1);
  assert.deepEqual(await reopened.button(), { text: '停止任务', disabled: false, loading: false });
});


for (const scenario of ['upsert', 'append', 'new-table', 'new-table-write-failed']) {
  test(`旧批次写入等待时重进${scenario}，完成并保存游标前不恢复或重复新增`, async t => {
    const entered = deferred(), release = deferred(); let old, resultReads = 0;
    const newTable = scenario.startsWith('new-table');
    let failWrite = scenario === 'new-table-write-failed';
    try {
      old = await mount(t, host => {
        const wrap = table => {
          const add = table.addRecords;
          table.addRecords = async batch => {
            entered.resolve(); await release.promise;
            if (failWrite) { failWrite = false; throw new Error('首次写入失败'); }
            return add(batch);
          };
        };
        if (newTable) {
          const add = host.sdk.base.addTable;
          host.sdk.base.addTable = async config => { const result = await add(config); wrap(host.state.tables.at(-1)); return result; };
        } else {
          const table = fakeTable('target', '已有作者', [
            { id: 'author', name: '作者ID', type: 1 }, { id: 'platform', name: '平台', type: 1 },
          ]);
          wrap(table); host.state.tables.push(table);
        }
        host.state.saved[storageKey] = {
          taskId: 'same-task', baseId: 'base-1', targetTableId: newTable ? '' : 'target',
          selectedFieldKeys: ['user_id', 'social_type'], writeMode: scenario === 'append' ? 'append' : 'upsert', cursor: '',
        };
        const request = host.state.axiosHandler;
        host.state.axiosHandler = async config => {
          if (config.url.endsWith('/list')) {
            if (!config.data.after_id) resultReads++;
            return { data: { sta: 0, data: config.data.after_id ? { items: [] }
              : { items: [{ user_id: 'author-1', social_type: 'xhs' }], next_cursor: 'next', has_more: false } } };
          }
          return request(config);
        };
      });
      await entered.promise; old.unmount();
      const reopened = await mount(t, () => {}, old);
      assert.equal(reopened.view.initializing.value, true);
      assert.equal(reopened.requests.filter(config => config.url.includes('task?task_id=same-task')).length, 1);
      assert.equal((await reopened.button()).disabled, true);
      release.resolve(); await flush();
      assert.equal(reopened.state.tables.length, 1);
      assert.equal(reopened.state.tables[0].records.length, 1);
      assert.equal(reopened.state.saved[storageKey].cursor, 'next');
      assert.equal(reopened.state.saved[storageKey].writtenCount, 1);
      assert.equal(reopened.state.saved[storageKey].targetTableId, reopened.state.tables[0].id);
      assert.equal(reopened.view.searchTask.getActiveTask().taskId, 'same-task');
      assert.equal(old.view.searchTask.getActiveTask(), null);
      assert.equal(old.view.toastVisible.value, false);
      assert.deepEqual(await reopened.button(), { text: '停止任务', disabled: false, loading: false });
      assert.equal(reopened.requests.filter(config => config.url.includes('task?task_id=same-task')).length, 2);
      assert.equal(resultReads, scenario === 'new-table-write-failed' ? 2 : 1);
    } finally { release.resolve(); await flush(); }
  });
}

for (const failures of [1, 2]) {
  test(`旧批次已写入但进度连续${failures}次保存失败，重进仅补存游标不重发已成功写入`, async t => {
    const entered = deferred(), release = deferred(); let progressSaves = 0, resultReads = 0;
    const old = await mount(t, host => {
      const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }]);
      const add = table.addRecords;
      table.addRecords = async batch => { entered.resolve(); await release.promise; return add(batch); };
      host.state.tables.push(table);
      host.state.saved[storageKey] = { taskId: 'same-task', baseId: 'base-1', targetTableId: 'target', selectedFieldKeys: ['user_id'], writeMode: 'append', cursor: '' };
      const save = host.sdk.bridge.setData;
      host.sdk.bridge.setData = async (key, task) => {
        if (key === storageKey && task.cursor === 'next' && ++progressSaves <= failures) throw new Error('批次进度保存失败');
        return save(key, task);
      };
      const request = host.state.axiosHandler;
      host.state.axiosHandler = async config => {
        if (config.url.endsWith('/list')) {
          if (!config.data.after_id) resultReads++;
          return { data: { sta: 0, data: config.data.after_id ? { items: [] } : { items: [{ user_id: 'author-1' }], next_cursor: 'next', has_more: false } } };
        }
        return request(config);
      };
    });
    try {
      await entered.promise; old.unmount();
      let reopened = await mount(t, () => {}, old);
      release.resolve(); await flush();
      assert.equal(reopened.state.tables[0].records.length, 1);
      if (failures === 2) {
        assert.equal(reopened.view.noticeRequiresReopen.value, true);
        assert.match(reopened.view.taskNotice.value, /批次进度保存失败/);
        assert.equal((await reopened.button()).disabled, true);
        reopened.unmount();
        reopened = await mount(t, () => {}, old);
      }
      assert.equal(reopened.state.saved[storageKey].cursor, 'next');
      assert.equal(reopened.view.searchTask.getActiveTask().cursor, 'next');
      assert.equal(resultReads, 1);
    } finally { release.resolve(); await flush(); }
  });
}


for (const mode of ['append', 'upsert']) {
  test(`${mode}写入已生效但响应超时，原页重试和重进均不重复新增`, async t => {
    const entered = deferred(), release = deferred();
    const scheduled = [], timeout = globalThis.setTimeout;
    let host;
    try {
      host = await mount(t, host => {
        const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'platform', name: '平台', type: 1 }]);
        const add = table.addRecords; let fail = true;
        table.addRecords = async batch => {
          if (fail) { fail = false; entered.resolve(); await release.promise; await add(batch); throw new Error('写入生效但响应超时'); }
          return add(batch);
        };
        host.state.tables.push(table);
        host.state.saved[storageKey] = { taskId: 'same-task', baseId: 'base-1', targetTableId: 'target', selectedFieldKeys: ['user_id', 'social_type'], writeMode: mode, cursor: '' };
        const request = host.state.axiosHandler;
        host.state.axiosHandler = async config => config.url.endsWith('/list')
          ? { data: { sta: 0, data: config.data.after_id ? { items: [] } : { items: [{ user_id: 'author-1', social_type: 'xhs' }], next_cursor: 'next', has_more: false } } }
          : request(config);
      });
      await entered.promise;
      t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
        if ([2000, 4000, 8000, 16000, 30000].includes(ms)) { scheduled.push(callback); return {}; }
        return timeout(callback, ms, ...args);
      });
      if (mode === 'append') {
        host.unmount();
        const reopened = await mount(t, () => {}, host);
        release.resolve(); await flush();
        assert.equal(reopened.state.tables[0].records.length, 1);
        assert.equal(reopened.state.saved[storageKey].cursor, 'next');
        assert.equal(reopened.state.saved[storageKey].writtenCount, 1);
      } else {
        release.resolve(); await flush();
        assert.equal(scheduled.length, 1);
        await scheduled.shift()();
        assert.equal(host.state.tables[0].records.length, 1);
        assert.equal(host.state.saved[storageKey].cursor, 'next');
        assert.equal(host.state.saved[storageKey].writtenCount, 1);
      }
    } finally { release.resolve(); await flush(); }
  });
}


test('写入前核对检查点保存失败时，不发送SDK新增并保持重进保护', async t => {
  const host = await mount(t, host => {
    const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }]);
    host.state.tables.push(table);
    host.state.saved[storageKey] = { taskId: 'task', baseId: 'base-1', targetTableId: 'target', selectedFieldKeys: ['user_id'], writeMode: 'append', cursor: '' };
    const save = host.sdk.bridge.setData;
    host.sdk.bridge.setData = async (key, task) => {
      if (key === storageKey && task.appendState?.pending) throw new Error('保存批次核对进度失败');
      return save(key, task);
    };
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => config.url.endsWith('/list')
      ? { data: { sta: 0, data: { items: [{ user_id: 'a' }], next_cursor: 'next', has_more: false } } }
      : request(config);
  });
  assert.equal(host.state.tables[0].records.length, 0);
  assert.equal(host.state.tables[0].writes, 0);
  assert.equal(host.view.noticeRequiresReopen.value, true);
  assert.match(host.view.taskNotice.value, /保存批次核对进度失败/);
  assert.equal((await host.button()).disabled, true);
  await host.view.submit();
  assert.equal(host.state.tables[0].writes, 0);
});

test('失败批次核对到多于预期的新增记录时暂停，禁止继续追加', async t => {
  const entered = deferred(), release = deferred(), scheduled = [];
  const host = await mount(t, host => {
    const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }]);
    const add = table.addRecords; let first = true;
    table.addRecords = async batch => {
      if (first) { first = false; entered.resolve(); await release.promise; await add(batch.concat(batch)); throw new Error('SDK响应超时'); }
      return add(batch);
    };
    host.state.tables.push(table);
    host.state.saved[storageKey] = { taskId: 'task', baseId: 'base-1', targetTableId: 'target', selectedFieldKeys: ['user_id'], writeMode: 'append', cursor: '' };
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => config.url.endsWith('/list')
      ? { data: { sta: 0, data: { items: [{ user_id: 'a' }], next_cursor: 'next', has_more: false } } }
      : request(config);
  });
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if ([2000, 4000, 8000, 16000, 30000].includes(ms)) { scheduled.push(callback); return {}; }
    return timeout(callback, ms, ...args);
  });
  try {
    await entered.promise; release.resolve(); await flush();
    await scheduled.shift()();
    assert.equal(host.state.tables[0].records.length, 2);
    assert.equal(host.view.loading.value, false);
    assert.equal(host.view.noticeRequiresReopen.value, true);
    assert.match(host.view.taskNotice.value, /多于预期/);
    assert.equal((await host.button()).disabled, true);
    await host.view.submit();
    assert.equal(host.state.tables[0].records.length, 2);
  } finally { release.resolve(); await flush(); }
});

for (const rangeType of ['pages', 'all']) {
  test(`刷新恢复${rangeType}作者搜索，同步原批量关键词、平台、范围及筛选，不创建新任务`, async t => {
    const old = await mount(t);
    Object.assign(old.view.form.value, { social_type: 'douyin', keyword: '浓缩\n拿铁', rangeType, pages: 2, follower_count_range: '1000_10000', user_type: 'personal' });
    old.view.selectedFieldKeys.value = ['user_id', 'nickname', 'social_type'];
    const original = { ...old.view.form.value };
    await old.view.handleTaskAction();
    assert.deepEqual(old.state.saved[storageKey].formData, original);
    const sent = old.requests.find(config => config.method === 'post' && config.url.endsWith('/blogger/search/task'));
    assert.deepEqual(sent.data.keyword, ['浓缩', '拿铁']);
    assert.equal(sent.data.pages, rangeType === 'all' ? 0 : 2);
    old.unmount();
    // 后来的字段偏好不能覆盖当前任务实际选择。
    old.state.saved.blogger_search_selected_fields_v1 = ['user_id', 'avatar'];
    const reopened = await mount(t, () => {}, old);
    assert.deepEqual(reopened.view.form.value, original);
    const output = await reopened.html();
    assert.match(output, /<textarea[^>]*disabled[^>]*>/);
    assert.match(output, /<input[^>]*type="number"[^>]*value="2"/);
    assert.deepEqual(reopened.view.selectedFieldKeys.value, ['user_id', 'nickname', 'social_type']);
    assert.equal(reopened.view.searchTask.getActiveTask().taskId, 'new');
    assert.equal(reopened.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 1);
    assert.deepEqual(await reopened.button(), { text: '停止任务', disabled: false, loading: false });
    await reopened.view.handleTaskAction();
    assert.equal(reopened.requests.find(config => config.url.endsWith('/cancel')).data.task_id, 'new');
  });
}

test('恢复已有表任务时延迟字段配置不覆盖原写入方式与映射，恢复过程不自动保存配置', async t => {
  const fields = deferred(); let saves = 0;
  const task = { taskId: 'saved', baseId: 'base-1', cursor: 'cursor-20', writtenCount: 20, targetTableId: 'target', selectedFieldKeys: ['user_id', 'nickname'], writeMode: 'append', fieldMappings: [{ source_key: 'nickname', target_field_id: 'name' }], formData: { social_type: 'xhs', keyword: '浓缩\n美式', rangeType: 'pages', pages: 2, radio: 2, table_id: 'target', writeMode: 'append', follower_count_range: 'all', user_type: 'all' } };
  const host = await mount(t, host => {
    const table = fakeTable('target', '原目标', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'name', name: '作者名称', type: 1 }]);
    const read = table.getFieldMetaList; table.getFieldMetaList = async () => { await fields.promise; return read(); };
    host.state.tables.push(table);
    host.state.saved[storageKey] = task;
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.method === 'put') { saves++; return { data: { sta: 0, data: config.data } }; }
      if (config.url.endsWith('table-output-configs')) return { data: { sta: 0, data: [{ target_table_id: 'target', write_mode: 'upsert', field_mappings: [] }] } };
      return request(config);
    };
  });
  try {
    assert.deepEqual(host.view.form.value, task.formData);
    fields.resolve(); await flush();
    assert.equal(host.view.form.value.writeMode, 'append');
    assert.deepEqual(host.view.mappingDraft.value, task.fieldMappings);
    assert.equal(saves, 0);
    assert.equal(host.view.searchTask.getActiveTask().cursor, 'cursor-20');
    assert.deepEqual(await host.button(), { text: '停止任务', disabled: false, loading: false });
  } finally { fields.resolve(); await flush(); }
});

test('旧作者任务没有查询参数快照仍恢复原任务，不用首个关键词或结果总页数猜参数', async t => {
  const host = await mount(t, host => { host.state.saved[storageKey] = { taskId: 'legacy', baseId: 'base-1', tableName: '首关键词', totalPages: 15, selectedFieldKeys: ['user_id'] }; });
  assert.equal(host.view.searchTask.getActiveTask().taskId, 'legacy');
  assert.equal(host.view.form.value.keyword, '');
  assert.equal(host.view.form.value.pages, 1);
  assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
});

test('带参数快照的同页鉴权恢复仍保留现有映射草稿，不覆盖用户待保存配置', async t => {
  let invalid = true;
  const host = await mount(t, host => {
    const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'name', name: '作者名称', type: 1 }, { id: 'draft', name: '新名称', type: 1 }]);
    table.getName = async () => '作者'; host.state.tables.push(table);
    host.state.saved[storageKey] = { taskId: 'paused', baseId: 'base-1', targetTableId: 'target', selectedFieldKeys: ['user_id', 'nickname'], writeMode: 'append', fieldMappings: [{ source_key: 'nickname', target_field_id: 'name' }], formData: { social_type: 'xhs', keyword: '浓缩', rangeType: 'pages', pages: 2, radio: 2, table_id: 'target', writeMode: 'append', follower_count_range: 'all', user_type: 'all' } };
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (invalid && config.url.includes('task?task_id=paused')) throw Object.assign(new Error('密钥失效'), { code: 'INVALID_API_KEY' });
      return request(config);
    };
  });
  assert.equal(host.view.loading.value, false);
  assert.equal(host.view.taskId.value, 'paused');
  host.view.mappingDraft.value = [{ source_key: 'nickname', target_field_id: 'draft' }]; await flush();
  invalid = false;
  await host.view.refreshSavedTask(false); await flush();
  assert.deepEqual(host.view.mappingDraft.value, [{ source_key: 'nickname', target_field_id: 'draft' }]);
  assert.equal(host.view.searchTask.getActiveTask().taskId, 'paused');
  assert.equal(host.requests.filter(config => config.method === 'post' && config.url.endsWith('/blogger/search/task')).length, 0);
});

test('恢复字段读取在卸载后失败，不向已恢复的新实例弹旧错误', async t => {
  const entered = deferred(), late = deferred(); let reads = 0;
  const host = await mount(t, host => {
    const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }]);
    table.getFieldMetaList = async () => { if (++reads === 1) { entered.resolve(); await late.promise; throw new Error('旧实例字段读取失败'); } return table.fields; };
    host.state.tables.push(table);
    host.state.saved[storageKey] = { taskId: 'old', baseId: 'base-1', targetTableId: 'target', selectedFieldKeys: ['user_id'], writeMode: 'append', fieldMappings: [], formData: { social_type: 'xhs', keyword: '咖啡', rangeType: 'pages', pages: 2, radio: 2, table_id: 'target', writeMode: 'append' } };
  });
  try {
    await entered.promise;
    assert.equal(host.view.taskId.value, 'old');
    assert.equal(host.state.notices.length, 0);
    host.unmount();
    const reopened = await mount(t, () => {}, host);
    assert.equal(reopened.view.searchTask.getActiveTask().taskId, 'old');
    assert.equal(reopened.view.loading.value, true);
    late.resolve(); await flush(); await flush();
    assert.equal(host.state.notices.length, 0);
  } finally { late.resolve(); await flush(); }
});

for (const ending of ['stopped', 'failed']) {
for (const replyTiming of ['during-task', 'after-unlock']) {
test(`排队配置保存${replyTiming}返回，${ending}解锁后补存最后一次映射且只补一次`, async t => {
  const firstSaved = deferred(), scheduled = [], updates = []; let stopped = false;
  const host = await mount(t, host => {
    const table = fakeTable('target', '作者', [ { id: 'id', name: '作者ID', type: 1 }, { id: 'n1', name: '旧名称', type: 1 }, { id: 'n2', name: '新名称', type: 1 } ]);
    table.getName = async () => '作者'; host.state.tables.push(table);
  });
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (cb, ms, ...args) => { if ([2000,4000,8000,16000,30000].includes(ms)) { scheduled.push(cb); return {}; } return timeout(cb,ms,...args); });
  try {
    host.view.form.value.writeMode = 'append';
    host.view.form.value.radio = 2; host.view.form.value.table_id = 'target'; await flush();
    host.view.selectedFieldKeys.value = ['user_id','nickname'];
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.method === 'put') {
        updates.push(structuredClone(config.data));
        if (updates.length === 1) await firstSaved.promise;
        return { data: { sta: 0, data: config.data } };
      }
      if (stopped && ending === 'failed' && config.url.includes('task?task_id=')) throw Object.assign(new Error('轮询失败暂停'), { stopPolling: true });
      if (config.url.includes('task?task_id=')) return { data: { sta: 0, data: { status: stopped ? 3 : 0 } } };
      return request(config);
    };
    host.view.mappingDraft.value = [{ source_key:'nickname', target_field_id:'n1' }]; await flush();
    assert.equal(updates.length,1);
    host.view.mappingDraft.value = [{ source_key:'nickname', target_field_id:'n2' }]; await flush();
    assert.equal(host.view.tableConfigSaving.value,true);
    host.view.form.value.keyword = '咖啡'; await host.view.handleTaskAction(); await flush();
    assert.equal(host.view.loading.value,true);
    assert.equal(host.state.saved[storageKey].fieldMappings[0].target_field_id,'n2');
    if (replyTiming === 'during-task') { firstSaved.resolve(); await flush(); assert.equal(updates.length, 1); }
    stopped = true; assert.ok(scheduled.length); await scheduled.shift()(); await flush();
    assert.equal(host.view.loading.value,false);
    if (replyTiming === 'after-unlock') { firstSaved.resolve(); await flush(); }
    assert.equal(updates.length, 2);
    assert.deepEqual(host.view.mappingDraft.value, [{ source_key: 'nickname', target_field_id: 'n2' }]);
    assert.equal(updates.at(-1).field_mappings[0].target_field_id,'n2');
  } finally { firstSaved.resolve(); await flush(); }
});

}
}

test('配置保存尚未返回时卸载，旧实例不继续补发排队保存', async t => {
  const saving = deferred(); let saves = 0;
  const host = await mount(t, host => {
    const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'name', name: '作者名称', type: 1 }]);
    table.getName = async () => '作者'; host.state.tables.push(table);
  });
  try {
    host.view.form.value.radio = 2; host.view.form.value.table_id = 'target'; await flush();
    const request = host.state.axiosHandler;
    host.state.axiosHandler = async config => {
      if (config.method === 'put') { saves++; await saving.promise; return { data: { sta: 0, data: config.data } }; }
      return request(config);
    };
    host.view.mappingDraft.value = [{ source_key: 'nickname', target_field_id: 'name' }]; await flush();
    assert.equal(saves, 1);
    host.view.form.value.writeMode = 'append'; await flush();
    host.unmount(); saving.resolve(); await flush(); await flush();
    assert.equal(saves, 1);
    assert.equal(host.state.notices.length, 0);
  } finally { saving.resolve(); await flush(); }
});

for (const stage of ['table', 'base', 'name']) {
  test(`排队补存等待${stage}读取时卸载，新实例保存后旧读取不能再覆盖配置`, async t => {
    const reply = deferred(), entered = deferred(), release = deferred(), scheduled = [], updates = [];
    let stopped = false, blockRead = false, blocked = false;
    const pause = async at => { if (blockRead && !blocked && at === stage) { blocked = true; entered.resolve(); await release.promise; } };
    const host = await mount(t, host => {
      const table = fakeTable('target', '作者', [ { id: 'id', name: '作者ID', type: 1 }, { id: 'n1', name: '名称1', type: 1 }, { id: 'n2', name: '名称2', type: 1 }, { id: 'n3', name: '名称3', type: 1 } ]);
      table.getName = async () => { await pause('name'); return '作者'; }; host.state.tables.push(table);
      const read = host.sdk.base.getTableById;
      host.sdk.base.getTableById = async id => { await pause('table'); return read(id); };
      const selection = host.sdk.base.getSelection;
      host.sdk.base.getSelection = async () => { await pause('base'); return selection(); };
    });
    const timeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (cb, ms, ...args) => { if ([2000,4000,8000,16000,30000].includes(ms)) { scheduled.push(cb); return {}; } return timeout(cb,ms,...args); });
    try {
      host.view.form.value.writeMode = 'append'; host.view.form.value.radio = 2; host.view.form.value.table_id = 'target'; await flush();
      host.view.selectedFieldKeys.value = ['user_id','nickname'];
      const request = host.state.axiosHandler;
      host.state.axiosHandler = async config => {
        if (config.method === 'put') { updates.push(structuredClone(config.data)); if (updates.length === 1) await reply.promise; return { data: { sta: 0, data: config.data } }; }
        if (config.url.includes('task?task_id=')) return { data: { sta: 0, data: { status: stopped ? 3 : 0 } } };
        return request(config);
      };
      host.view.mappingDraft.value = [{ source_key:'nickname', target_field_id:'n1' }]; await flush();
      host.view.mappingDraft.value = [{ source_key:'nickname', target_field_id:'n2' }]; await flush();
      host.view.form.value.keyword = '咖啡'; await host.view.handleTaskAction(); await flush();
      assert.equal(host.view.loading.value,true);
      reply.resolve(); await flush(); assert.equal(updates.length,1);
      blockRead = true; stopped = true; await scheduled.shift()(); await entered.promise;
      assert.equal(host.view.loading.value,false);
      host.unmount();
      const reopened = await mount(t, () => {}, host);
      reopened.view.form.value.radio = 2; reopened.view.form.value.table_id = 'target'; await flush();
      reopened.view.mappingDraft.value = [{ source_key:'nickname', target_field_id:'n3' }]; await flush(); await flush();
      assert.equal(updates.at(-1).field_mappings[0].target_field_id,'n3');
      const before = updates.length;
      release.resolve(); await flush(); await flush();
      assert.equal(updates.length,before);
      assert.equal(updates.at(-1).field_mappings[0].target_field_id,'n3');
    } finally { reply.resolve(); release.resolve(); await flush(); }
  });
}

for (const stage of ['table','base','name']) {
  test(`A表排队补存等待${stage}时切B表，A请求应保留A字段及写入方式`,async t=>{
    const first=deferred(),entered=deferred(),release=deferred(),scheduled=[],updates=[];
    let block=false,blocked=false,stopped=false;
    const pause=async at=>{if(block&&!blocked&&at===stage){blocked=true;entered.resolve();await release.promise;}};
    const host=await mount(t,host=>{
      const a=fakeTable('A','表A',[{id:'a-id',name:'作者ID',type:1},{id:'a-name1',name:'名称A1',type:1},{id:'a-name2',name:'名称A2',type:1}]);
      const b=fakeTable('B','表B',[{id:'b-id',name:'作者ID',type:1},{id:'b-name',name:'名称B',type:1}]);
      a.getName=async()=>{await pause('name');return '表A';};b.getName=async()=> '表B';host.state.tables.push(a,b);
      const read=host.sdk.base.getTableById,selection=host.sdk.base.getSelection;
      host.sdk.base.getTableById=async id=>{if(id==='A')await pause('table');return read(id);};
      host.sdk.base.getSelection=async()=>{await pause('base');return selection();};
      const request=host.state.axiosHandler;
      host.state.axiosHandler=async config=>config.url.endsWith('table-output-configs')?{data:{sta:0,data:[{target_table_id:'B',write_mode:'upsert',field_mappings:[{source_key:'nickname',target_field_id:'b-name'}]}]}}:request(config);
    });
    const timeout=globalThis.setTimeout;
    t.mock.method(globalThis,'setTimeout',(cb,ms,...args)=>{if([2000,4000,8000,16000,30000].includes(ms)){scheduled.push(cb);return{};}return timeout(cb,ms,...args);});
    try{
      const s=host.view;
      s.form.value.writeMode='append';s.form.value.radio=2;s.form.value.table_id='A';await flush();
      s.selectedFieldKeys.value=['user_id','nickname'];
      const request=host.state.axiosHandler;
      host.state.axiosHandler=async config=>{
        if(config.method==='put'){updates.push(structuredClone(config.data));if(updates.length===1)await first.promise;return{data:{sta:0,data:config.data}};}
        if(config.url.includes('task?task_id='))return{data:{sta:0,data:{status:stopped?3:0}}};
        return request(config);
      };
      s.mappingDraft.value=[{source_key:'nickname',target_field_id:'a-name1'}];await flush();
      s.mappingDraft.value=[{source_key:'nickname',target_field_id:'a-name2'}];await flush();
      s.form.value.keyword='咖啡';await s.handleTaskAction();await flush();
      assert.equal(host.state.saved[storageKey].targetTableId,'A');assert.equal(s.loading.value,true);
      first.resolve();await flush();assert.equal(updates.length,1);
      block=true;stopped=true;await scheduled.shift()();await entered.promise;
      assert.equal(s.loading.value,false);
      s.form.value.table_id='B';await flush();
      assert.equal(s.form.value.writeMode,'upsert');assert.equal(s.mappingDraft.value[0].target_field_id,'b-name');
      release.resolve();await flush();await flush();
      const savedA=updates.filter(config=>config.target_table_id==='A').at(-1);
      assert.equal(savedA.write_mode,'append');
      assert.equal(savedA.field_mappings[0].target_field_id,'a-name2');
      const savedB=updates.filter(config=>config.target_table_id==='B').at(-1);
      assert.equal(savedB.write_mode,'upsert');
      assert.equal(savedB.field_mappings[0].target_field_id,'b-name');
      assert.equal(s.form.value.table_id,'B');
    }finally{first.resolve();release.resolve();await flush();}
  });
}


for (const stage of ['table', 'base', 'name']) {
  test(`同表${stage}保存准备期间连续修改，原请求固定参数且队列保存最新配置`, async t => {
    const entered = deferred(), release = deferred(), updates = [];
    let armed = false, blocked = false;
    const pause = async at => { if (armed && !blocked && at === stage) { blocked = true; entered.resolve(); await release.promise; } };
    const host = await mount(t, host => {
      const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, ...['n1', 'n2', 'n3'].map(id => ({ id, name: id, type: 1 }))]);
      table.getName = async () => { await pause('name'); return '作者'; }; host.state.tables.push(table);
      const read = host.sdk.base.getTableById, selection = host.sdk.base.getSelection;
      host.sdk.base.getTableById = async id => { await pause('table'); return read(id); };
      host.sdk.base.getSelection = async () => { await pause('base'); return selection(); };
    });
    try {
      const s = host.view;
      s.form.value.writeMode = 'append'; s.form.value.radio = 2; s.form.value.table_id = 'target'; await flush();
      const request = host.state.axiosHandler;
      host.state.axiosHandler = async config => {
        if (config.method === 'put') { updates.push(structuredClone(config.data)); return { data: { sta: 0, data: config.data } }; }
        return request(config);
      };
      armed = true;
      s.mappingDraft.value = [{ source_key: 'nickname', target_field_id: 'n1' }]; await entered.promise;
      s.mappingDraft.value[0].target_field_id = 'n2'; await flush();
      s.mappingDraft.value[0].target_field_id = 'n3'; s.form.value.writeMode = 'upsert'; await flush();
      release.resolve(); await flush(); await flush();
      assert.equal(updates.length, 2);
      assert.equal(updates[0].target_table_id, 'target');
      assert.equal(updates[0].field_mappings[0].target_field_id, 'n1');
      assert.equal(updates[0].write_mode, 'append');
      assert.equal(updates[1].field_mappings[0].target_field_id, 'n3');
      assert.equal(updates[1].write_mode, 'upsert');
      assert.equal(s.mappingDraft.value[0].target_field_id, 'n3');
      assert.equal(s.tableConfigSaving.value, false);
    } finally { release.resolve(); await flush(); }
  });
}

async function cloudConfigFixture(t, { savedTask = false } = {}) {
  let readConfig = async () => { throw new Error('云端配置网络原错'); };
  let delivered = false;
  const table = fakeTable('B', '作者B', [
    { id: 'id', name: '作者ID', type: 1 }, { id: 'platform', name: '平台', type: 1 },
    { id: 'mapped', name: '指定作者', type: 1 }, { id: 'notes', name: '备注', type: 1 },
  ], [{ recordId: 'old', fields: { id: 'u', platform: 'xhs', mapped: '旧作者', notes: '保留备注' } }]);
  table.getName = async () => '作者B';
  const mappings = [{ source_key: 'nickname', target_field_id: 'mapped' }];
  const host = await mount(t, host => {
    host.state.tables.push(table); host.sdk.base.getTableList = async () => [table];
    if (savedTask) host.state.saved[storageKey] = {
      taskId: 'saved', baseId: 'base-1', targetTableId: 'B', selectedFieldKeys: ['user_id', 'social_type', 'nickname'],
      writeMode: 'upsert', fieldMappings: mappings,
      formData: { social_type: 'xhs', keyword: '原任务', radio: 2, table_id: 'B', writeMode: 'upsert' },
    };
    host.state.axiosHandler = async config => {
      host.requestsForConfigTest ||= []; host.requestsForConfigTest.push(config);
      if (config.url.endsWith('table-output-configs')) return readConfig();
      if (config.method === 'put') return { data: { sta: 0, data: config.data } };
      if (config.url.endsWith('/list')) {
        const items = delivered ? [] : [{ user_id: 'u', social_type: 'xhs', nickname: '新作者' }]; delivered = true;
        return { data: { sta: 0, data: { items, next_cursor: items.length ? 'one' : '', has_more: false } } };
      }
      return { data: { sta: 0, data: config.method === 'post' ? { task_id: 'new' } : { status: 0 } } };
    };
  });
  host.view.form.value.keyword = '猫';
  if (!savedTask) {
    host.view.selectedFieldKeys.value = ['user_id', 'social_type', 'nickname'];
    host.view.form.value.radio = 2; host.view.form.value.table_id = 'B'; await flush();
  }
  return { ...host, table, mappings,
    calls: () => host.requestsForConfigTest,
    read: fn => { readConfig = fn; },
    success: () => ({ data: { sta: 0, data: [{ target_table_id: 'B', write_mode: 'upsert', field_mappings: mappings }] } }),
  };
}

for (const [failure, expected] of [['network', /再次网络原错/], ['business', /云端配置业务原错/], ['missing-list', /表格配置返回格式不正确/]]) {
  test(`作者云端配置${failure}失败：执行重试保留本次原因，不补列、写表、保存或创建任务`, async t => {
    const host = await cloudConfigFixture(t);
    const original = new Error('再次网络原错');
    host.read(async () => {
      if (failure === 'network') throw original;
      if (failure === 'missing-list') return { data: { sta: 0, data: {} } };
      return { data: { sta: 1005, msg: '云端配置业务原错', data: [] } };
    });
    await host.view.submit(); await flush();
    assert.match(host.view.toastText.value, expected);
    if (failure === 'network') assert.equal(host.view.tableConfigsError, original);
    assert.equal(host.calls().filter(config => config.method === 'post' || config.method === 'put').length, 0);
    assert.equal(host.table.writes, 0); assert.equal(host.table.fields.length, 4);
    assert.equal(host.view.submitting.value, false); assert.equal(host.view.loading.value, false);
  });
}

test('作者云端配置重试延迟时保持忙碌，成功恢复原映射及模式后更新原列', async t => {
  const host = await cloudConfigFixture(t), gate = deferred(); let pending;
  host.read(async () => { await gate.promise; return host.success(); });
  try {
    pending = host.view.submit(); await flush(); await host.view.submit();
    assert.equal(host.view.submitting.value, true);
    assert.equal(host.calls().filter(config => config.method === 'post' || config.method === 'put').length, 0);
    gate.resolve(); await pending;
    assert.equal(host.calls().filter(config => config.method === 'get' && config.url.endsWith('table-output-configs')).length, 2);
    assert.equal(host.table.records.length, 1); assert.equal(host.table.records[0].fields.mapped, '新作者');
    assert.equal(host.table.records[0].fields.notes, '保留备注'); assert.equal(host.table.fields.length, 4);
    assert.equal(host.state.saved[storageKey].writtenCount, 1);
    assert.deepEqual(host.state.saved[storageKey].fieldMappings, host.mappings);
    assert.equal(host.state.saved[storageKey].writeMode, 'upsert');
  } finally { gate.resolve(); await pending; }
});

for (const output of ['empty-config', 'new-table']) {
  test(`作者云端配置${output}仍正常写入默认列`, async t => {
    const host = await cloudConfigFixture(t);
    if (output === 'empty-config') host.read(async () => ({ data: { sta: 0, data: [] } }));
    else { host.view.form.value.radio = 1; await flush(); }
    await host.view.submit();
    const target = output === 'new-table' ? host.state.tables[1] : host.table;
    const name = target.fields.find(field => field.name === '作者名称');
    assert.ok(name); assert.equal(target.records.at(-1).fields[name.id], '新作者');
    assert.equal(host.table.records[0].fields.notes, '保留备注');
  });
}

test('作者云端配置不可读仍恢复已有任务快照并写回原映射', async t => {
  const host = await cloudConfigFixture(t, { savedTask: true });
  assert.equal(host.view.searchTask.getActiveTask().taskId, 'saved');
  assert.equal(host.table.records.length, 1); assert.equal(host.table.records[0].fields.mapped, '新作者');
  assert.equal(host.table.records[0].fields.notes, '保留备注');
  assert.deepEqual(host.view.mappingDraft.value, host.mappings);
  assert.equal(host.calls().filter(config => config.method === 'put' || (config.method === 'post' && config.url.endsWith('/task'))).length, 0);
});

test('作者云端配置成功后执行保留当前用户映射草稿，不重新加载云端旧映射', async t => {
  const host = await cloudConfigFixture(t);
  host.read(async () => host.success()); await host.view.loadTableOutputConfigs(); await host.view.loadTableFields('B');
  host.table.fields.push({ id: 'edited', name: '本次手选列', type: 1 });
  host.view.tableFieldOptions.value = await host.table.getFieldMetaList();
  host.view.mappingDraft.value = [{ source_key: 'nickname', target_field_id: 'edited' }]; await flush();
  const reads = host.calls().filter(config => config.url.endsWith('table-output-configs')).length;
  await host.view.submit();
  assert.equal(host.calls().filter(config => config.url.endsWith('table-output-configs')).length, reads);
  assert.equal(host.table.records[0].fields.edited, '新作者'); assert.equal(host.table.records[0].fields.mapped, '旧作者');
});

test('作者云端配置卸载后迟到不更新旧实例，不继续恢复或保存', async t => {
  const gate = deferred();
  const host = await mount(t, host => {
    host.state.axiosHandler = async () => { await gate.promise; return { data: { sta: 0, data: [{ target_table_id: 'B', field_mappings: [] }] } }; };
  });
  try {
    host.unmount(); gate.resolve(); await flush();
    assert.deepEqual(host.view.tableOutputConfigs.value, {});
    assert.equal(host.view.tableConfigsLoaded.value, false);
    assert.equal(host.view.searchTask.getActiveTask(), null);
    assert.equal(host.state.notices.length, 0);
  } finally { gate.resolve(); await flush(); }
});

test('独立作者真实Vue：半填映射无逐行提示，执行仍拦截', async t => {
  const f = await cloudConfigFixture(t);
  f.read(async () => f.success());
  await f.view.loadTableOutputConfigs();
  await f.view.loadTableFields('B'); await flush();
  f.view.mappingExpanded.value = true;
  const fields = structuredClone(f.table.fields);
  for (const row of [{ source_key: 'nickname', target_field_id: '' }, { source_key: '', target_field_id: 'mapped' }, { source_key: '', target_field_id: '' }]) {
    f.view.mappingDraft.value = [row]; await flush();
    const before = f.calls().length;
    await f.view.submit();
    assert.equal(f.calls().slice(before).some(r => r.method === 'post'), false);
    assert.deepEqual(f.table.fields, fields);
    assert.equal(f.view.loading.value, false);
    assert.doesNotMatch(await f.html(), /class="mapping-validation"/);
  }
  f.view.mappingDraft.value = []; await flush();
  assert.doesNotMatch(await f.html(), /class="mapping-validation"/);
});
