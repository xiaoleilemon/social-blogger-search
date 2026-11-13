import fs from 'node:fs';
import axios from 'axios';

// Run the real request module and Axios interceptors; replace only build-time env.
export function loadRequestModule(env) {
  const source = fs.readFileSync(new URL('../../src/utils/request.js', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace('const env = import.meta.env;', `const env = ${JSON.stringify(env)};`)
    .replaceAll('export const ', 'const ')
    .replace('export default service', 'return { service, API_BASE_URL, FEISHU_API_BASE_URL, FEISHU_API_PATH_PREFIX, LEGACY_FEISHU_API_PATH_PREFIX, buildApiUrl, buildFeishuApiUrl, buildFeishuApiPath, feishuRequest };');
  return new Function('axios', 'PLUGIN_VERSION', source)(axios, 'test-version');
}
