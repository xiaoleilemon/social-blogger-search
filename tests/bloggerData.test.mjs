import test from 'node:test';
import assert from 'node:assert/strict';
import { bitable } from '@lark-base-open/js-sdk';
import { installSDKCells } from '../../social-data-bridge/tests/helpers/sdkTable.mjs';
import { fakeTable, loadModules } from './helpers.mjs';

const paths = ['/src/composables/useBloggerData.js'];

for (const legacyCheckpoint of [false, true]) {
  test(`独立作者空值追加已生效但响应超时：${legacyCheckpoint ? '旧空串检查点保留核对保护' : '重进核对原批次且保留历史重复'}`, async () => {
    const host = await loadModules(paths);
    try {
      const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 },
        { id: 'count', name: '粉丝数', type: 2 }, { id: 'date', name: '提取时间', type: 5 }],
      [{ recordId: 'historical', fields: { id: 'one', count: null, date: null } }]);
      host.state.tables.push(table);
      const add = table.addRecords; let fail = true;
      table.addRecords = async batch => {
        const ids = await add(batch);
        if (fail) { fail = false; throw new Error('空值写入已生效但响应超时'); }
        return ids;
      };
      const rows = [{ user_id: 'one', follower_count: null, ctime: null }], state = {};
      const first = host.modules[0].useBloggerData(() => '作者');
      await assert.rejects(first.createAndWriteData(rows, 'stream', 'task', 'target', ['follower_count', 'ctime'],
        { writeMode: 'append', appendState: state }), /空值写入已生效但响应超时/);
      assert.equal(table.records[1].fields.count, null);
      assert.equal(table.records[1].fields.date, null);
      const saved = structuredClone(state);
      if (legacyCheckpoint) {
        saved.pending.keys = saved.pending.keys.map(key => JSON.stringify(JSON.parse(key).map((value, index) =>
          ['count', 'date'].includes(saved.pending.fieldIds[index]) ? '' : value)));
        // 旧格式仅记录了原比较规则匹配的历史 ID，不能把新规则下的历史空白行当成本批新增行。
        saved.pending.knownRecordIds = [];
      }
      const next = host.modules[0].useBloggerData(() => '作者');
      const retry = next.createAndWriteData(rows, 'stream', 'task', 'target', ['follower_count', 'ctime'],
        { writeMode: 'append', appendState: saved });
      if (legacyCheckpoint) {
        await assert.rejects(retry, error => error.requiresReopen && /待核对批次或目标字段/.test(error.message));
        assert.ok(saved.pending);
      } else {
        const result = await retry;
        assert.deepEqual(result.recordIds, [table.records[1].recordId]);
        assert.equal(saved.completedCount, 1);
      }
      assert.equal(table.records.length, 2);
      assert.equal(table.writes, 1);
      assert.equal(table.records[0].recordId, 'historical');
    } finally { await host.close(); }
  });
}

for (const countType of [1, 2]) {
  test(`独立作者：更新已有 ${countType} 数值列及日期列时保留空值和零`, async () => {
    const host = await loadModules(paths);
    try {
      const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'platform', name: '平台', type: 1 },
        { id: 'count', name: '粉丝数', type: countType }, { id: 'date', name: '提取时间', type: 5 }],
      [{ recordId: 'one', fields: { id: 'one', platform: 'xhs', count: 5, date: 1794182400000 } }]);
      host.state.tables.push(table);
      const writer = host.modules[0].useBloggerData(() => '作者');
      for (const input of [null, undefined, '', 0]) {
        await writer.createAndWriteData([{ user_id: 'one', social_type: 'xhs', follower_count: input, ctime: input }],
          'stream', 'task', 'target', ['follower_count', 'ctime'], { writeMode: 'upsert' });
        assert.equal(table.records.length, 1);
        assert.equal(table.records[0].recordId, 'one');
        assert.equal(table.records[0].fields.date, input === 0 ? 0 : null);
        assert.equal(table.records[0].fields.count, countType === 1 ? (input === 0 ? '0' : '') : (input === 0 ? 0 : null));
      }
    } finally { await host.close(); }
  });
}

test('同批各平台相同作者ID分别新增，后续批次只更新对应平台', async () => {
  const host = await loadModules(paths);
  try {
    const platforms = ['xhs', 'douyin', 'tiktok', 'kuaishou', 'bilibili', 'weibo', 'haokan', 'toutiao', 'wechat', 'zhihu', 'instagram', 'x'];
    const writer = host.modules[0].useBloggerData(() => '跨平台作者');
    const result = await writer.createAndWriteData(platforms.map(social_type => ({
      user_id: '123', social_type, nickname: `${social_type}作者`,
    })), '', 'task-1', '', ['nickname'], { writeMode: 'upsert' });
    const table = host.state.tables.find(table => table.id === result.tableId);
    const fieldId = key => table.fields.find(field => field.name === key).id;
    assert.equal(table.records.length, 12);
    assert.deepEqual(table.records.map(record => record.fields[fieldId('平台')]), platforms);

    await writer.createAndWriteData([{ user_id: '123', social_type: 'douyin', nickname: '抖音更新' }],
      'stream', 'task-1', result.tableId, ['nickname'], { writeMode: 'upsert' });
    assert.equal(table.records.length, 12);
    assert.deepEqual(table.records.map(record => record.fields[fieldId('作者名称')]), [
      'xhs作者', '抖音更新', 'tiktok作者', 'kuaishou作者', 'bilibili作者', 'weibo作者', 'haokan作者',
      'toutiao作者', 'wechat作者', 'zhihu作者', 'instagram作者', 'x作者',
    ]);
  } finally { await host.close(); }
});

test('现有表通过映射的平台单选列区分作者，未选择平台输出时仍保留身份列', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '作者', [
      { id: 'id', name: '编号', type: 1 }, { id: 'platform', name: '来源', type: 3 },
      { id: 'name', name: '作者名称', type: 1 },
    ], [
      { recordId: 'weibo', fields: { id: [{ type: 'text', text: '123' }], platform: { id: 'option-2', text: 'weibo' }, name: '微博作者' } },
      { recordId: 'douyin', fields: { id: [{ type: 'text', text: '123' }], platform: { id: 'option-1', text: 'douyin' }, name: '抖音作者' } },
    ]);
    host.state.tables.push(table);
    await host.modules[0].useBloggerData(() => '作者').createAndWriteData([
      { user_id: '123', social_type: 'weibo', nickname: '微博更新' },
    ], 'stream', 'task-2', 'target', ['nickname'], {
      writeMode: 'upsert', fieldMappings: [{ source_key: 'user_id', target_field_id: 'id' }, { source_key: 'social_type', target_field_id: 'platform' }],
    });
    assert.equal(table.records.length, 2);
    assert.equal(table.records[0].fields.name, '微博更新');
    assert.equal(table.records[1].fields.name, '抖音作者');
    assert.equal(table.records[0].fields.platform, 'weibo');
    assert.equal(table.fields.length, 3);
  } finally { await host.close(); }
});

test('同平台大小写不同的作者ID保持独立', async () => {
  const host = await loadModules(paths);
  try {
    const result = await host.modules[0].useBloggerData(() => '作者').createAndWriteData([
      { user_id: 'AbC', social_type: 'wechat', nickname: '作者一' },
      { user_id: 'abc', social_type: 'wechat', nickname: '作者二' },
    ], '', 'case-task', '', ['nickname'], { writeMode: 'upsert' });
    assert.equal(host.state.tables.find(table => table.id === result.tableId).records.length, 2);
  } finally { await host.close(); }
});

test('历史作者没有平台时保留原行，新任务不按相同ID推断归属', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '历史作者', [
      { id: 'id', name: '作者ID', type: 1 }, { id: 'name', name: '作者名称', type: 1 },
    ], [{ recordId: 'legacy', fields: { id: '123', name: '未知平台作者' } }]);
    host.state.tables.push(table);
    const writer = host.modules[0].useBloggerData(() => '作者');
    await writer.createAndWriteData([{ user_id: '123', social_type: 'douyin', nickname: '抖音作者' }],
      'stream', 'task-3', 'target', ['nickname'], { writeMode: 'upsert' });
    await writer.createAndWriteData([{ user_id: '123', social_type: 'douyin', nickname: '抖音更新' }],
      'stream', 'task-4', 'target', ['nickname'], { writeMode: 'upsert' });
    assert.equal(table.records.length, 2);
    assert.deepEqual(table.records[0], { recordId: 'legacy', fields: { id: '123', name: '未知平台作者' } });
    assert.equal(table.records[1].fields.name, '抖音更新');
  } finally { await host.close(); }
});

test('新建作者表处理重名，并转换认证、数值、日期和链接字段', async () => {
  const host = await loadModules(paths);
  try {
    host.state.tables.push(fakeTable('old', '猫咪'));
    const { useBloggerData } = host.modules[0];
    const writer = useBloggerData(() => '猫咪');
    const result = await writer.createAndWriteData([
      { user_id: '123', nickname: '小猫', verified: false, follower_count: 0, ctime: 1700000000, profile_url: 'https://example.com/user/123' },
    ], '', 'task-1', '', ['nickname', 'verified', 'follower_count', 'ctime', 'profile_url'], { writeMode: 'append' });
    const table = host.state.tables.find(table => table.id === result.tableId);
    assert.equal(table.name, '猫咪1');
    const values = Object.fromEntries(table.fields.map(field => [field.name, table.records[0].fields[field.id]]));
    assert.deepEqual(values, { 作者名称: '小猫', 作者ID: '123', 作者主页链接: 'https://example.com/user/123', 粉丝数: 0, 认证状态: '未认证', 提取时间: 1700000000000 });
  } finally { await host.close(); }
});

test('现有表使用显式映射更新作者，新增新作者和缺少 ID 的结果', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '结果', [
      { id: 'id', name: '自定义编号', type: 1 }, { id: 'name', name: '自定义名称', type: 3 },
      { id: 'fans', name: '粉丝数', type: 1 },
      { id: 'platform', name: '平台', type: 1 },
    ], [{ recordId: 'existing', fields: { id: [{ type: 'text', text: 'abc' }], name: '旧名', fans: '1', platform: 'xhs' } }]);
    host.state.tables.push(table);
    const writer = host.modules[0].useBloggerData(() => '结果');
    const options = { writeMode: 'upsert', fieldMappings: [{ source_key: 'user_id', target_field_id: 'id' }, { source_key: 'nickname', target_field_id: 'name' }] };
    const result = await writer.createAndWriteData([
      { user_id: 'abc', social_type: 'xhs', nickname: '更新后', follower_count: 10 },
      { user_id: 'def', social_type: 'xhs', nickname: '新作者', follower_count: 0 },
      { social_type: 'xhs', nickname: '无编号', follower_count: 5 },
    ], 'stream', 'task-2', 'target', ['nickname', 'follower_count'], options);
    assert.deepEqual(table.records.map(record => record.fields), [
      { id: 'abc', name: '更新后', fans: '10', platform: 'xhs' }, { id: 'def', name: '新作者', fans: '0', platform: 'xhs' }, { id: '', name: '无编号', fans: '5', platform: 'xhs' },
    ]);
    assert.deepEqual(result.recordIds, ['existing', 'record-2', 'record-3']);
    await writer.createAndWriteData([{ user_id: 'def', social_type: 'xhs', nickname: '再次更新', follower_count: 20 }], 'stream', 'task-2', 'target', ['nickname', 'follower_count'], options);
    assert.equal(table.records.length, 3);
    assert.equal(table.records[1].fields.name, '再次更新');
  } finally { await host.close(); }
});

test('目标字段类型不兼容时阻止写入，不意外创建其他表', async () => {
  const host = await loadModules(paths);
  try {
    host.state.tables.push(fakeTable('target', '结果', [{ id: 'id', name: '作者ID', type: 2 }]));
    const writer = host.modules[0].useBloggerData(() => '结果');
    await assert.rejects(writer.createAndWriteData([{ user_id: 'abc' }], 'stream', 'task', 'target', [], { writeMode: 'upsert' }), /类型/);
    assert.equal(host.state.tables.length, 1);
    assert.equal(host.state.tables[0].records.length, 0);
  } finally { await host.close(); }
});

test('写入失败向任务层抛错，不新建表绕过失败', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '结果', [{ id: 'id', name: '作者ID', type: 1 }]);
    table.addRecords = async () => { throw new Error('没有写入权限'); };
    host.state.tables.push(table);
    await assert.rejects(host.modules[0].useBloggerData(() => '结果').createAndWriteData([{ user_id: 'abc' }], 'stream', 'task', 'target', [], { writeMode: 'append' }), /没有写入权限/);
    assert.equal(host.state.tables.length, 1);
  } finally { await host.close(); }
});

test('更新现有记录使用 SDK 单元格转换后的字段值', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '结果', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'url', name: '作者主页链接', type: 15 }, { id: 'platform', name: '平台', type: 1 }], [
      { recordId: 'existing', fields: { id: [{ type: 'text', text: 'abc' }], platform: [{ type: 'text', text: 'xhs' }] } },
    ]);
    table.getFieldById = async id => ({
      id, getType: async () => id === 'url' ? 15 : 1,
      createCell: async value => ({ getValue: async () => id === 'url' ? [{ type: 'url', text: value, link: value }] : [{ type: 'text', text: value }] }),
    });
    host.state.tables.push(table);
    await host.modules[0].useBloggerData(() => '结果').createAndWriteData([{ user_id: 'abc', social_type: 'xhs', profile_url: 'https://example.com/abc' }], 'stream', 'task', 'target', ['profile_url'], { writeMode: 'upsert' });
    assert.deepEqual(table.records[0].fields, {
      id: [{ type: 'text', text: 'abc' }], url: [{ type: 'url', text: 'https://example.com/abc', link: 'https://example.com/abc' }],
      platform: [{ type: 'text', text: 'xhs' }],
    });
  } finally { await host.close(); }
});

test('映射目标不存在时验证失败，不自动新建同名字段替代', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '结果', [{ id: 'id', name: '作者ID', type: 1 }]);
    host.state.tables.push(table);
    const valid = await host.modules[0].useBloggerData(() => '结果').validateTableFields('target', ['nickname'], { fieldMappings: [{ source_key: 'nickname', target_field_id: 'deleted' }] });
    assert.equal(valid, false);
    assert.equal(table.fields.length, 1);
  } finally { await host.close(); }
});

test('更新或新增可跨页匹配已有作者，不重复创建记录', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '结果', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'name', name: '作者名称', type: 1 }, { id: 'platform', name: '平台', type: 1 }], [
      { recordId: 'existing', fields: { id: 'abc', name: '旧名', platform: 'xhs' } },
    ]);
    table.getRecordsByPage = async ({ pageToken }) => pageToken
      ? { records: [{ recordId: 'existing', fields: { id: 'abc', name: '旧名', platform: 'xhs' } }], hasMore: false }
      : { records: [], hasMore: true, pageToken: 'page-2' };
    host.state.tables.push(table);
    await host.modules[0].useBloggerData(() => '结果').createAndWriteData(
      [{ user_id: 'abc', social_type: 'xhs', nickname: '更新后' }], 'stream', 'task-page', 'target', ['nickname'], { writeMode: 'upsert' },
    );
    assert.equal(table.records.length, 1);
    assert.equal(table.records[0].fields.name, '更新后');
  } finally { await host.close(); }
});

test('现有表分页游标不前进时停止写入，避免无限读取', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '结果', [{ id: 'id', name: '作者ID', type: 1 }]);
    table.getRecordsByPage = async () => ({ records: [], hasMore: true, pageToken: 'same-page' });
    host.state.tables.push(table);
    await assert.rejects(host.modules[0].useBloggerData(() => '结果').createAndWriteData(
      [{ user_id: 'abc' }], 'stream', 'task-page', 'target', [], { writeMode: 'upsert' },
    ), /分页游标/);
    assert.equal(table.records.length, 0);
  } finally { await host.close(); }
});


for (const accepted of [0, 1, 2]) {
  test(`更新模式新增已生效${accepted}条后响应超时，原页重试重新查表补齐`, async () => {
    const host = await loadModules(paths);
    try {
      const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'platform', name: '平台', type: 1 }]);
      host.state.tables.push(table);
      const add = table.addRecords; let fail = true;
      table.addRecords = async batch => {
        if (fail) { fail = false; await add(batch.slice(0, accepted)); throw new Error('SDK响应超时'); }
        return add(batch);
      };
      const writer = host.modules[0].useBloggerData(() => '作者');
      const rows = [{ user_id: 'a', social_type: 'xhs' }, { user_id: 'a', social_type: 'douyin' }];
      await assert.rejects(writer.createAndWriteData(rows, 'stream', 'task', 'target', [], { writeMode: 'upsert' }), /SDK响应超时/);
      await writer.createAndWriteData(rows, 'stream', 'task', 'target', [], { writeMode: 'upsert' });
      assert.equal(table.records.length, 2);
      assert.deepEqual(table.records.map(record => record.fields.platform).sort(), ['douyin', 'xhs']);
    } finally { await host.close(); }
  });
}

for (const accepted of [0, 1, 2]) {
  test(`追加模式新增已生效${accepted}条后响应超时，重进仅补缺失且保留历史重复`, async () => {
    const host = await loadModules(paths);
    try {
      const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }], [{ recordId: 'historical', fields: { id: 'a' } }]);
      host.state.tables.push(table);
      const add = table.addRecords; let fail = true;
      table.addRecords = async batch => {
        if (fail) { fail = false; await add(batch.slice(0, accepted)); throw new Error('SDK响应超时'); }
        return add(batch);
      };
      const state = {};
      const rows = [{ user_id: 'a' }, { user_id: 'a' }];
      const first = host.modules[0].useBloggerData(() => '作者');
      await assert.rejects(first.createAndWriteData(rows, 'stream', 'task', 'target', [], { writeMode: 'append', appendState: state }), /SDK响应超时/);
      const next = host.modules[0].useBloggerData(() => '作者');
      await next.createAndWriteData(rows, 'stream', 'task', 'target', [], { writeMode: 'append', appendState: structuredClone(state) });
      assert.equal(table.records.length, 3);
      assert.equal(table.records[0].recordId, 'historical');
    } finally { await host.close(); }
  });
}


test('追加超过200条的中间批部分生效后超时，恢复跳过已确认批次并补齐失败批次', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }]);
    host.state.tables.push(table);
    const add = table.addRecords; let calls = 0;
    table.addRecords = async batch => {
      if (++calls === 2) { await add(batch.slice(0, 50)); throw new Error('中间批次响应超时'); }
      return add(batch);
    };
    const state = {}, rows = Array.from({ length: 401 }, (_, index) => ({ user_id: String(index) }));
    const writer = host.modules[0].useBloggerData(() => '作者');
    await assert.rejects(writer.createAndWriteData(rows, 'stream', 'task', 'target', [], { writeMode: 'append', appendState: state }), /中间批次响应超时/);
    const next = host.modules[0].useBloggerData(() => '作者');
    const result = await next.createAndWriteData(rows, 'stream', 'task', 'target', [], { writeMode: 'append', appendState: structuredClone(state) });
    assert.equal(table.records.length, 401);
    assert.equal(new Set(table.records.map(record => record.fields.id)).size, 401);
    assert.equal(result.recordIds.length, 401);
  } finally { await host.close(); }
});

test('更新模式缺少身份信息的行响应超时，复用追加检查点避免重复新增', async () => {
  const host = await loadModules(paths);
  try {
    const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'platform', name: '平台', type: 1 }]);
    host.state.tables.push(table);
    const add = table.addRecords; let first = true;
    table.addRecords = async batch => { const ids = await add(batch); if (first) { first = false; throw new Error('SDK响应超时'); } return ids; };
    const state = {}, rows = [{ social_type: 'xhs' }], writer = host.modules[0].useBloggerData(() => '作者');
    await assert.rejects(writer.createAndWriteData(rows, 'stream', 'task', 'target', [], { writeMode: 'upsert', appendState: state }), /SDK响应超时/);
    await writer.createAndWriteData(rows, 'stream', 'task', 'target', [], { writeMode: 'upsert', appendState: state });
    assert.equal(table.records.length, 1);
  } finally { await host.close(); }
});


for (const historical of [false, true]) {
  for (const legacy of [false, true]) {
    test(`URL字段属性顺序不同的超时恢复，保留历史${historical}并兼容旧检查点${legacy}`, async () => {
      const host = await loadModules(paths);
      try {
        const url = 'https://example.com/a';
        const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'url', name: '作者主页链接', type: 15 }],
          historical ? [{ recordId: 'historical', fields: { id: 'a', url: [{ link: url, text: url, type: 'url' }] } }] : []);
        const get = table.getFieldById;
        table.getFieldById = async id => {
          const field = await get(id);
          if (id === 'url') field.createCell = async value => {
            const segments = [{ type: 'url', text: value, link: value }];
            return { fieldId: id, value: segments, getValue: async () => segments };
          };
          return field;
        };
        table.getRecordsByPage = async () => ({ records: table.records.map(record => ({ ...record,
          fields: { ...record.fields, url: record.fields.url.map(segment => ({ link: segment.link, text: segment.text, type: segment.type })) },
        })), hasMore: false });
        const add = table.addRecords; let first = true;
        table.addRecords = async batch => {
          const ids = await add(batch);
          if (first) { first = false; throw new Error('写入已生效但响应超时'); }
          return ids;
        };
        host.state.tables.push(table);
        const state = {}, rows = [{ user_id: 'a', profile_url: url }];
        const firstWriter = host.modules[0].useBloggerData(() => '作者');
        await assert.rejects(firstWriter.createAndWriteData(rows, 'stream', 'task', 'target', ['profile_url'], { writeMode: 'append', appendState: state }), /写入已生效但响应超时/);
        const saved = structuredClone(state);
        if (legacy) {
          saved.pending.keys = saved.pending.keys.map(key => {
            const values = JSON.parse(key);
            const index = saved.pending.fieldIds.indexOf('url');
            values[index] = values[index].map(segment => ({ link: segment.link, text: segment.text, type: segment.type }));
            return JSON.stringify(values);
          });
        }
        const next = host.modules[0].useBloggerData(() => '作者');
        const result = await next.createAndWriteData(rows, 'stream', 'task', 'target', ['profile_url'], { writeMode: 'append', appendState: saved });
        assert.equal(table.records.length, historical ? 2 : 1);
        assert.equal(table.writes, 1);
        assert.equal(result.recordIds.length, 1);
        assert.notEqual(result.recordIds[0], 'historical');
      } finally { await host.close(); }
    });
  }
}


for (const [from, to, expected] of [[2, 1, [{ type: 'text', text: '0' }]], [1, 2, 0]]) {
  test(`独立作者真实 SDK 1.0.2：首次校验缓存 ${from} 类型，同页改为 ${to} 后继续写入`, async () => {
    const host = await loadModules(paths);
    try {
      const table = fakeTable('target', '作者', [{ id: 'id', name: '作者ID', type: 1 }, { id: 'count', name: '粉丝数', type: from }]);
      host.state.tables.push(table);
      await installSDKCells(table, bitable);
      const writer = host.modules[0].useBloggerData(() => '作者');
      await writer.validateTableFields('target', ['user_id', 'follower_count'], { throwOnError: true });
      table.fields[1].type = to;
      await writer.createAndWriteData([{ user_id: 'one', follower_count: 0 }], 'stream', 'task', 'target', ['user_id', 'follower_count'], { writeMode: 'append' });
      assert.equal(table.records.length, 1);
      assert.deepEqual(table.records[0].fields.count, expected);
      assert.equal(table.fields[1].type, to);
    } finally { await host.close(); }
  });
}
