import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRequestModule } from './helpers/feishuRequest.mjs';

for (const [label, env, base] of [
  ['production', { VITE_API_BASE_URL: 'https://api.52choujiang.cn', VITE_FEISHU_API_BASE_URL: 'https://api.socialdatax.com/' }, 'https://api.socialdatax.com'],
  ['test', { VITE_API_BASE_URL: 'https://legacy.example', VITE_FEISHU_API_BASE_URL: 'https://test-lotto.weiyoubot.cn' }, 'https://test-lotto.weiyoubot.cn'],
  ['same-origin', { VITE_API_BASE_URL: '/', VITE_FEISHU_API_BASE_URL: '/' }, ''],
]) {
  test(`${label}: migrated requests use their own origin and keep auth/version`, async () => {
    const api = loadRequestModule(env), calls = [];
    api.service.defaults.adapter = async config => { calls.push(config); return { config, status: 200, data: { sta: 0, data: [] } }; };
    await api.feishuRequest({ url: api.buildFeishuApiPath('/v1/feishu/example'), method: 'post', headers: { authorization: 'Bearer test-only' }, data: { keyword: '猫' } });
    await api.feishuRequest({ url: api.buildFeishuApiPath('/v1/feishu/example'), method: 'get', params: { task_id: 'task' } });
    assert.deepEqual(calls.map(c => c.baseURL), [base, base]);
    assert.equal(calls[0].url, '/socialdatax/api/v1/feishu/example');
    assert.deepEqual(JSON.parse(calls[0].data), { keyword: '猫', version: 'test-version' });
    assert.equal(calls[0].headers.authorization, 'Bearer test-only');
    assert.deepEqual(calls[1].params, { task_id: 'task', version: 'test-version' });
    assert.equal(api.buildFeishuApiUrl('/download'), `${base}/download`);
    assert.equal(api.buildFeishuApiUrl('https://cdn.example/file'), 'https://cdn.example/file');
    assert.equal(api.API_BASE_URL, env.VITE_API_BASE_URL === '/' ? '' : env.VITE_API_BASE_URL);
  });
}

test('explicit saved source including empty origin/prefix overrides the new default', async () => {
  const api = loadRequestModule({ VITE_API_BASE_URL: 'https://legacy.example', VITE_FEISHU_API_BASE_URL: 'https://api.socialdatax.com' });
  const calls = [];
  api.service.defaults.adapter = async config => { calls.push(config); return { config, status: 200, data: {} }; };
  for (const baseURL of ['', 'https://saved.example']) await api.feishuRequest({ url: api.buildFeishuApiPath('/task', ''), baseURL });
  assert.deepEqual(calls.map(c => [c.baseURL, c.url]), [['', '/task'], ['https://saved.example', '/task']]);
});
