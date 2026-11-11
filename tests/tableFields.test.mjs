import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './helpers.mjs';

const paths = ['/src/utils/tableFields.js'];

test('目标字段选项按当前视图的列顺序返回', async () => {
  const host = await loadModules(paths);
  try {
    const table = {
      getFieldMetaList: async () => [
        { id: 'first', name: '创建顺序一', type: 1 },
        { id: 'second', name: '创建顺序二', type: 1 },
        { id: 'third', name: '创建顺序三', type: 1 },
      ],
      getActiveView: async () => ({
        getFieldMetaList: async () => [
          { id: 'third', name: '视图第三列', type: 1 },
          { id: 'first', name: '视图第一列', type: 1 },
          { id: 'second', name: '视图第二列', type: 1 },
        ],
      }),
    };
    const fields = await host.modules[0].getOrderedTableFields(table);
    assert.deepEqual(fields.map(field => field.id), ['third', 'first', 'second']);
  } finally { await host.close(); }
});

test('读取视图字段失败时回退到数据表字段列表', async () => {
  const host = await loadModules(paths);
  try {
    const table = {
      getFieldMetaList: async () => [{ id: 'fallback', name: '备用字段', type: 1 }],
      getActiveView: async () => { throw new Error('no active view'); },
    };
    const fields = await host.modules[0].getOrderedTableFields(table);
    assert.deepEqual(fields, [{ id: 'fallback', name: '备用字段', type: 1 }]);
  } finally { await host.close(); }
});
