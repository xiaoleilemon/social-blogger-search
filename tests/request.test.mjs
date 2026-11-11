import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './helpers.mjs';

test('创建作者任务保留鉴权和关键词，并附加后端兼容版本', async () => {
  const host = await loadModules(['/src/utils/request.js']);
  try {
    const service = host.modules[0].default;
    let sent;
    service.defaults.adapter = async config => {
      sent = config;
      return { data: { sta: 0, data: { task_id: 'task-1' } }, status: 200, statusText: 'OK', headers: {}, config };
    };
    const result = await service({ url: '/social/api/v1/feishu/blogger/search/task', method: 'post', headers: { authorization: 'Bearer test-only-key' }, data: { keyword: ['小猫'], social_type: 'douyin', pages: 1 } });
    assert.equal(sent.baseURL, '');
    assert.equal(sent.headers.authorization, 'Bearer test-only-key');
    assert.deepEqual(JSON.parse(sent.data), { keyword: ['小猫'], social_type: 'douyin', pages: 1, version: 'web-10.29' });
    assert.equal(result.data.data.task_id, 'task-1');
  } finally { await host.close(); }
});

test('查询配置时附加版本并保留调用方参数，失效密钥转换为可识别错误', async () => {
  const host = await loadModules(['/src/utils/request.js']);
  try {
    const service = host.modules[0].default;
    let sent;
    service.defaults.adapter = async config => {
      sent = config;
      return { data: { sta: 4001, msg: '请输入正确的apikey' }, status: 200, statusText: 'OK', headers: {}, config };
    };
    await assert.rejects(service({ url: '/social/api/v1/feishu/profile-fetch/table-output-configs', method: 'get', params: { plugin_type: 'blogger_search', base_id: 'base-1' } }), error => error.code === 'INVALID_API_KEY');
    assert.deepEqual(sent.params, { plugin_type: 'blogger_search', base_id: 'base-1', version: 'web-10.29' });
  } finally { await host.close(); }
});

test('生产接口地址由环境注入，构造路径时保留绝对 URL', async () => {
  const host = await loadModules(['/src/utils/request.js'], 'production');
  try {
    const { buildApiUrl } = host.modules[0];
    assert.equal(buildApiUrl('/social/api/v1/feishu/blogger/search/task'), 'https://api.52choujiang.cn/social/api/v1/feishu/blogger/search/task');
    assert.equal(buildApiUrl('https://example.com/existing'), 'https://example.com/existing');
  } finally { await host.close(); }
});
