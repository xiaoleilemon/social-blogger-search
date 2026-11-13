import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.js', import.meta.url));

const getProxyTarget = async mode => {
  const { config } = await loadConfigFromFile({ command: 'serve', mode }, configFile, root);
  return config.server.proxy['/social/api'].target;
};

test('开发模式默认代理测试后端', async () => {
  assert.equal(await getProxyTarget('development'), 'https://test-lotto.weiyoubot.cn');
});

test('development-prod 模式代理生产后端', async () => {
  assert.equal(await getProxyTarget('development-prod'), 'https://api.52choujiang.cn');
});

for (const [mode, expected] of [
  ['development', 'https://test-lotto.weiyoubot.cn'],
  ['development-prod', 'https://api.socialdatax.com'],
]) {
  test(`${mode} 新接口使用独立代理`, async () => {
    const { config } = await loadConfigFromFile({ command: 'serve', mode }, configFile, root);
    assert.equal(config.server.proxy['/socialdatax/api'].target, expected);
    assert.equal(config.server.proxy['/socialdatax/api'].changeOrigin, true);
  });
}
