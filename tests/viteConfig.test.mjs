import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, loadEnv } from 'vite';
import { loadRequestModule } from './helpers/feishuRequest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.js', import.meta.url));

const withEnvFiles = async callback => {
  const previousCwd = process.cwd();
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-proxy-env-'));
  try {
    for (const name of ['.env.development', '.env.development-prod']) {
      fs.copyFileSync(path.join(root, name), path.join(envDir, name));
    }
    process.chdir(envDir);
    return await callback(envDir);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(envDir, { recursive: true, force: true });
  }
};

const proxyEnvKeys = ['VITE_API_BASE_URL', 'VITE_FEISHU_API_BASE_URL', 'VITE_DEV_PROXY_TARGET', 'VITE_FEISHU_DEV_PROXY_TARGET'];
const withCleanProxyEnv = async callback => {
  const original = new Map(proxyEnvKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of proxyEnvKeys) delete process.env[key];
    return await callback();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const loadMode = mode => withCleanProxyEnv(() => withEnvFiles(async envDir => {
  const api = loadRequestModule(loadEnv(mode, envDir, 'VITE_'));
  const { config } = await loadConfigFromFile({ command: 'serve', mode }, configFile, envDir);
  return { api, config };
}));

const getProxyTarget = async mode => {
  const { config } = await loadMode(mode);
  return config.server.proxy['/social/api'].target;
};

test('开发模式默认代理测试后端', async () => {
  assert.equal(await getProxyTarget('development'), 'https://test-lotto.weiyoubot.cn');
});

test('development-prod 同源请求由新旧代理分别转发到生产后端', async () => {
  const { api, config } = await loadMode('development-prod');
  assert.equal(api.buildApiUrl('/social/api/v1/feishu/example'), '/social/api/v1/feishu/example');
  assert.equal(api.buildFeishuApiUrl(api.buildFeishuApiPath('/v1/feishu/example')), '/socialdatax/api/v1/feishu/example');
  assert.equal(config.server.proxy['/social/api'].target, 'https://api.52choujiang.cn');
  assert.equal(config.server.proxy['/socialdatax/api'].target, 'https://api.socialdatax.com');
});

for (const [mode, expected] of [
  ['development', 'https://test-lotto.weiyoubot.cn'],
  ['development-prod', 'https://api.socialdatax.com'],
]) {
  test(`${mode} 新接口使用独立代理`, async () => {
    const { config } = await loadMode(mode);
    assert.equal(config.server.proxy['/socialdatax/api'].target, expected);
    assert.equal(config.server.proxy['/socialdatax/api'].changeOrigin, true);
  });
}

for (const [label, overrides, shouldReject] of [
  ['成功后恢复原代理变量', {
    VITE_API_BASE_URL: 'https://override-legacy.example',
    VITE_FEISHU_API_BASE_URL: 'https://override-feishu.example',
    VITE_DEV_PROXY_TARGET: 'https://override-legacy-proxy.example',
    VITE_FEISHU_DEV_PROXY_TARGET: 'https://override-feishu-proxy.example',
  }, false],
  ['异步失败后恢复空值和未设置变量', {
    VITE_API_BASE_URL: '',
    VITE_FEISHU_API_BASE_URL: undefined,
    VITE_DEV_PROXY_TARGET: 'https://override-proxy.example',
    VITE_FEISHU_DEV_PROXY_TARGET: undefined,
  }, true],
]) {
  test(`默认代理测试隔离外部环境，${label}`, async () => {
    await withCleanProxyEnv(async () => {
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const failure = new Error('配置读取失败');
      const operation = withCleanProxyEnv(async () => {
        for (const key of Object.keys(overrides)) assert.equal(process.env[key], undefined);
        await Promise.resolve();
        for (const key of Object.keys(overrides)) assert.equal(process.env[key], undefined);
        if (shouldReject) throw failure;
        return 'loaded';
      });
      if (shouldReject) await assert.rejects(operation, error => error === failure);
      else assert.equal(await operation, 'loaded');
      for (const [key, value] of Object.entries(overrides)) assert.equal(process.env[key], value);
    });
  });
}

test('运行时仍优先使用进程中的新旧基址和代理覆盖', async () => {
  await withCleanProxyEnv(async () => {
    process.env.VITE_API_BASE_URL = 'https://override-legacy.example';
    process.env.VITE_FEISHU_API_BASE_URL = 'https://override-feishu.example';
    process.env.VITE_DEV_PROXY_TARGET = 'https://override-legacy-proxy.example';
    process.env.VITE_FEISHU_DEV_PROXY_TARGET = 'https://override-feishu-proxy.example';
    const mode = 'development-prod';
    const api = loadRequestModule(loadEnv(mode, root, 'VITE_'));
    const { config } = await loadConfigFromFile({ command: 'serve', mode }, configFile, root);
    assert.equal(api.API_BASE_URL, 'https://override-legacy.example');
    assert.equal(api.FEISHU_API_BASE_URL, 'https://override-feishu.example');
    assert.equal(config.server.proxy['/social/api'].target, 'https://override-legacy-proxy.example');
    assert.equal(config.server.proxy['/socialdatax/api'].target, 'https://override-feishu-proxy.example');
  });
});

test('本地环境文件不干扰默认配置测试，运行时仍应用本地覆盖', async () => {
  await withCleanProxyEnv(() => withEnvFiles(async envDir => {
    const overrides = 'VITE_API_BASE_URL=https://local-legacy.example\n'
      + 'VITE_FEISHU_API_BASE_URL=https://local-feishu.example\n'
      + 'VITE_DEV_PROXY_TARGET=https://local-legacy-proxy.example\n'
      + 'VITE_FEISHU_DEV_PROXY_TARGET=https://local-feishu-proxy.example\n';
    fs.writeFileSync(path.join(envDir, '.env.local'), overrides);
    for (const [mode, legacy, feishu] of [
      ['development', 'https://test-lotto.weiyoubot.cn', 'https://test-lotto.weiyoubot.cn'],
      ['development-prod', 'https://api.52choujiang.cn', 'https://api.socialdatax.com'],
    ]) {
      fs.writeFileSync(path.join(envDir, `.env.${mode}.local`), overrides);
      const { api, config } = await loadMode(mode);
      assert.equal(api.API_BASE_URL, '');
      assert.equal(api.FEISHU_API_BASE_URL, '');
      assert.equal(config.server.proxy['/social/api'].target, legacy);
      assert.equal(config.server.proxy['/socialdatax/api'].target, feishu);
      assert.equal(process.cwd(), fs.realpathSync(envDir));

      const runtimeApi = loadRequestModule(loadEnv(mode, envDir, 'VITE_'));
      const runtime = await loadConfigFromFile({ command: 'serve', mode }, configFile, envDir);
      assert.equal(runtimeApi.API_BASE_URL, 'https://local-legacy.example');
      assert.equal(runtimeApi.FEISHU_API_BASE_URL, 'https://local-feishu.example');
      assert.equal(runtime.config.server.proxy['/social/api'].target, 'https://local-legacy-proxy.example');
      assert.equal(runtime.config.server.proxy['/socialdatax/api'].target, 'https://local-feishu-proxy.example');
    }
  }));
});

test('环境目录异步失败后恢复工作目录并清理临时文件', async () => {
  const previousCwd = process.cwd();
  const failure = new Error('读取环境目录失败');
  let envDir;
  await assert.rejects(withEnvFiles(async directory => {
    envDir = directory;
    await Promise.resolve();
    throw failure;
  }), error => error === failure);
  assert.equal(process.cwd(), previousCwd);
  assert.equal(fs.existsSync(envDir), false);
});
