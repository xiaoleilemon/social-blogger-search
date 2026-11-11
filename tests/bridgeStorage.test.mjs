import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { loadModules } from './helpers.mjs';

test('bridge 持久化会解包响应式代理并移除宿主回调', async t => {
  const host = await loadModules(['/src/utils/bridgeStorage.js']);
  try {
    const { toBridgeData, setBridgeData } = host.modules[0];
    const value = reactive({
      taskId: 'task-1',
      selectedFieldKeys: reactive(['user_id', 'nickname']),
      onFirstTableLoaded: () => {},
    });

    const cloned = toBridgeData(value);
    assert.deepEqual(cloned, { taskId: 'task-1', selectedFieldKeys: ['user_id', 'nickname'] });
    assert.doesNotThrow(() => structuredClone(cloned));

    await setBridgeData('task', value);
    assert.deepEqual(host.state.saved.task, cloned);
  } finally { await host.close(); }
});
