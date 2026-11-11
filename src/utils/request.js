import axios from 'axios'
import { PLUGIN_VERSION } from '@/utils/version'

const env = import.meta.env;
const baseURL = env.VITE_API_BASE_URL === '/' ? '' : (env.VITE_API_BASE_URL || '');
export const API_BASE_URL = baseURL;

export const buildApiUrl = (path) => {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (!API_BASE_URL) {
    return path;
  }
  const normalizedBase = API_BASE_URL.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};
// 创建 axios 实例
const service = axios.create({
  baseURL: baseURL, // 自动获取当前环境的 API 基址
  timeout: 60000,
})

service.interceptors.request.use((config) => {
  const method = (config.method || 'get').toLowerCase();

  if (method === 'get') {
    config.params = config.params || {};
    if (config.params.version === undefined) {
      config.params.version = PLUGIN_VERSION;
    }
    return config;
  }

  config.data = config.data || {};
  if (config.data.version === undefined) {
    config.data.version = PLUGIN_VERSION;
  }
  return config;
})

service.interceptors.response.use((response) => {
  if (Number(response.data?.sta) === 4001) {
    const error = new Error(response.data?.msg || '请输入正确的apikey');
    error.code = 'INVALID_API_KEY';
    error.response = response;
    return Promise.reject(error);
  }

  return response;
})

export default service
