import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './helpers.mjs';

async function setup(t) {
  const host = await loadModules(['/src/composables/useIncrementalTask.js']);
  const scheduled = [];
  t.mock.method(globalThis, 'setTimeout', callback => { scheduled.push(callback); return callback; });
  t.mock.method(globalThis, 'clearTimeout', callback => {
    const index = scheduled.indexOf(callback);
    if (index >= 0) scheduled.splice(index, 1);
  });
  const tasks = [];
  const make = overrides => {
    const task = host.modules[0].useIncrementalTask({
      storageKey: 'task', getStatus: async () => ({ sta: 0, data: { status: 0, processed: 1 } }),
      getResults: async () => ({ sta: 0, data: { items: [], has_more: false } }),
      writeBatch: async () => {}, ...overrides,
    });
    tasks.push(task); return task;
  };
  return { ...host, scheduled, make, close: async () => { tasks.forEach(task => task.stop()); t.mock.restoreAll(); await host.close(); } };
}

test('批量写入失败保留游标；重试成功后才持久化新游标', async t => {
  const host = await setup(t);
  try {
    let fail = true;
    const task = host.make({
      getResults: async () => ({ sta: 0, data: { items: [{ user_id: 'abc' }], next_cursor: 'cursor-1', has_more: false } }),
      writeBatch: async () => { if (fail) throw new Error('写入失败'); },
    });
    await task.start({ taskId: 'task-1' });
    assert.equal(host.state.saved.task.cursor, '');
    assert.equal(host.state.saved.task.writtenCount, 0);
    fail = false;
    await host.scheduled.shift()();
    assert.equal(host.state.saved.task.cursor, 'cursor-1');
    assert.equal(host.state.saved.task.writtenCount, 1);
  } finally { await host.close(); }
});

test('任务终态仍先写完剩余结果，然后清除恢复状态', async t => {
  const host = await setup(t);
  try {
    let reads = 0; const written = []; let finished = false;
    const task = host.make({
      getStatus: async () => ({ status: 1, processed: 1 }),
      getResults: async () => reads++ === 0 ? { items: [{ user_id: 'last' }], next_cursor: 'last', has_more: false } : { items: [] },
      writeBatch: async items => { written.push(...items); },
      onFinish: () => { finished = true; },
    });
    await task.start({ taskId: 'task-1' });
    assert.deepEqual(written, [{ user_id: 'last' }]);
    assert.equal(finished, false);
    await host.scheduled.shift()();
    assert.equal(finished, true);
    assert.deepEqual(host.state.saved.task, {});
    assert.equal(host.scheduled.length, 0);
  } finally { await host.close(); }
});

test('其他多维表格的已存任务不能在当前表恢复', async t => {
  const host = await setup(t);
  try {
    host.state.saved.task = { taskId: 'foreign', baseId: 'base-other', cursor: 'old' };
    const task = host.make({ getStatus: async () => { throw new Error('不应请求其他表任务'); } });
    assert.equal(await task.resume(), false);
    assert.equal(task.getActiveTask(), null);
    assert.equal(host.state.saved.task.cursor, 'old');
  } finally { await host.close(); }
});

test('卸载时停止本地轮询，保留任务以便下次恢复', async t => {
  const host = await setup(t);
  try {
    const task = host.make({});
    await task.start({ taskId: 'task-1' });
    task.stop();
    assert.equal(host.scheduled.length, 0);
    assert.equal(host.state.saved.task.taskId, 'task-1');
    assert.equal(task.getActiveTask(), null);
  } finally { await host.close(); }
});

test('任务身份保存等待期间停止实例，晚返回不能触发就绪回调或轮询', async t => {
  const host = await setup(t);
  let release, saved, starting;
  const entered = new Promise(resolve => { saved = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let ready = 0, reads = 0;
  const save = host.sdk.bridge.setData;
  host.sdk.bridge.setData = async (key, value) => { saved(); await gate; return save(key, value); };
  const task = host.make({ getStatus: async () => { reads++; return { status: 0 }; } });
  try {
    starting = task.start({ taskId: 'task-1' }, () => { ready++; });
    await entered; task.stop(); release(); await starting;
    assert.equal(ready, 0); assert.equal(reads, 0);
    assert.equal(task.getActiveTask(), null);
    assert.equal(host.state.saved.task.taskId, 'task-1');
  } finally { release(); await starting?.catch(() => {}); await host.close(); }
});

for (const phase of ['start-selection', 'resume-data', 'resume-selection']) {
  test(`${phase}等待期间停止，晚返回不得重建任务归属或开始轮询`, async t => {
    const host = await setup(t);
    host.state.saved.task = { taskId: 'old', baseId: 'base-1' };
    let entered, release, running;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let ready = 0, reads = 0;
    const owner = phase === 'resume-data' ? host.sdk.bridge : host.sdk.base;
    const name = phase === 'resume-data' ? 'getData' : 'getSelection';
    const original = owner[name];
    owner[name] = async (...args) => { entered(); await gate; return original(...args); };
    const task = host.make({ getStatus: async () => { reads++; return { status: 0 }; } });
    try {
      running = phase === 'start-selection' ? task.start({ taskId: 'new' }, () => { ready++; }) : task.resume(() => { ready++; });
      await waiting; task.stop(); release(); await running;
      assert.equal(ready, 0); assert.equal(reads, 0);
      assert.equal(task.getActiveTask(), null);
      assert.equal(host.scheduled.length, 0);
    } finally { release(); await running; await host.close(); }
  });
}

test('卸载发生在结果请求期间，旧实例不得继续写入或重新调度', async t => {
  const host = await setup(t);
  try {
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    let writes = 0;
    const task = host.make({
      getResults: () => { entered(); return new Promise(resolve => { release = resolve; }); },
      writeBatch: async () => { writes++; },
    });
    const pending = task.start({ taskId: 'task-1' });
    await waiting;
    task.stop();
    release({ items: [{ user_id: 'abc' }], next_cursor: 'next', has_more: false });
    await pending;
    assert.equal(writes, 0);
    assert.equal(host.scheduled.length, 0);
    assert.equal(host.state.saved.task.cursor, '');
  } finally { await host.close(); }
});

test('旧轮询未结束时重新启动任务，新任务仍会开始轮询', async t => {
  const host = await setup(t);
  try {
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    let first = true;
    const task = host.make({
      getStatus: async () => {
        if (!first) return { sta: 0, data: { status: 0, processed: 1 } };
        first = false;
        entered();
        return new Promise(resolve => { release = resolve; });
      },
    });
    const oldPoll = task.start({ taskId: 'task-old' });
    await waiting;
    await task.start({ taskId: 'task-new' });
    release({ sta: 0, data: { status: 0, processed: 1 } });
    await oldPoll;
    assert.equal(task.getActiveTask()?.taskId, 'task-new');
    assert.equal(host.scheduled.length, 1);
  } finally { await host.close(); }
});

test('旧任务写入完成时不得覆盖新任务的恢复状态', async t => {
  const host = await setup(t);
  try {
    let releaseWrite;
    let enteredWrite;
    const waiting = new Promise(resolve => { enteredWrite = resolve; });
    let firstWrite = true;
    const task = host.make({
      getStatus: async () => ({ sta: 0, data: { status: 0, processed: 1 } }),
      getResults: async () => ({ sta: 0, data: { items: [{ user_id: 'author' }], next_cursor: 'cursor-1', has_more: false } }),
      writeBatch: async () => {
        if (!firstWrite) return;
        firstWrite = false;
        enteredWrite();
        await new Promise(resolve => { releaseWrite = resolve; });
      },
    });
    const oldPoll = task.start({ taskId: 'task-old' });
    await waiting;
    const starting = task.start({ taskId: 'task-new' });
    await Promise.resolve();
    assert.equal(host.state.saved.task.taskId, 'task-old');
    releaseWrite();
    await Promise.all([oldPoll, starting]);
    assert.equal(host.state.saved.task.taskId, 'task-new');
  } finally { await host.close(); }
});

test('密钥失效立即释放本地任务，让用户修改密钥并恢复任务', async t => {
  const host = await setup(t);
  try {
    const errors = [];
    let invalidKey = true;
    const task = host.make({
      getStatus: async () => {
        if (invalidKey) throw Object.assign(new Error('请输入正确的apikey'), { code: 'INVALID_API_KEY' });
        return { status: 0, processed: 1 };
      },
      onError: error => { errors.push(error.code); },
    });
    await task.start({ taskId: 'task-1' });
    assert.deepEqual(errors, ['INVALID_API_KEY']);
    assert.equal(task.getActiveTask(), null);
    assert.equal(host.scheduled.length, 0);
    assert.equal(host.state.saved.task.taskId, 'task-1');
    invalidKey = false;
    assert.equal(await task.resume(), true);
    assert.equal(task.getActiveTask().taskId, 'task-1');
  } finally { await host.close(); }
});

test('任务混入不可克隆的宿主回调时，只持久化可恢复的纯数据', async t => {
  const host = await setup(t);
  try {
    const task = host.make({});
    await task.start({
      taskId: 'task-1',
      tableName: '作者',
      targetTableId: 'table-1',
      selectedFieldKeys: ['user_id', 'nickname'],
      fieldMappings: [{ source_key: 'nickname', target_field_id: 'field-name' }],
      onFirstTableLoaded: () => {},
    });

    assert.deepEqual(host.state.saved.task, {
      cursor: '',
      writtenCount: 0,
      lastProcessed: 1,
      lastHeartbeatAt: 0,
      latestStatus: { status: 0, processed: 1 },
      lastActivityAt: host.state.saved.task.lastActivityAt,
      pollInterval: 2000,
      baseId: 'base-1',
      taskId: 'task-1',
      tableName: '作者',
      targetTableId: 'table-1',
      selectedFieldKeys: ['user_id', 'nickname'],
      fieldMappings: [{ source_key: 'nickname', target_field_id: 'field-name' }],
    });
    assert.equal(typeof host.state.saved.task.lastActivityAt, 'number');
  } finally { await host.close(); }
});
