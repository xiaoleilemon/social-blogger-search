import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';

// SDK 与多维表格通信，测试只替换宿主边界；业务模块仍由 Vite 加载执行。
export async function loadModules(paths, mode = 'development', options = {}) {
  const state = { baseId: 'base-1', saved: {}, tables: [], notices: [] };
  const sdk = {
    base: {
      onSelectionChange: () => () => {},
      getSelection: async () => ({ baseId: state.baseId }),
      getTableMetaList: async () => state.tables.map(table => ({ id: table.id, name: table.name })),
      getTableById: async id => {
        const table = state.tables.find(table => table.id === id);
        if (!table) throw new Error(`Missing table: ${id}`);
        return table;
      },
      getTable: async id => sdk.base.getTableById(id),
      addTable: async ({ name }) => {
        const table = fakeTable(`table-${state.tables.length + 1}`, name);
        state.tables.push(table);
        return { tableId: table.id };
      },
    },
    ui: { switchToTable: async () => {} },
    bridge: {
      getData: async key => structuredClone(state.saved[key]),
      setData: async (key, value) => { state.saved[key] = structuredClone(value); },
    },
  };
  const token = `__bloggerTest${Math.random().toString(36).slice(2)}`;
  globalThis[token] = { sdk, state };
  const server = await createServer({
    configFile: false,
    root: options.root,
    mode,
    resolve: { alias: { '@': options.root ? `${options.root}/src` : fileURLToPath(new URL('../src', import.meta.url)) } },
    optimizeDeps: { disabled: true },
    server: { middlewareMode: true, watch: null, hmr: { server: createHttpServer() } },
    plugins: [vue(), {
      name: 'test-host-boundary', enforce: 'pre',
      resolveId(id) {
        if (id === 'axios' && options.mockAxios) return '\0test:axios';
        if (id === '@lark-base-open/js-sdk' || id === 'element-plus') return `\0test:${id}`;
      },
      load(id) {
        if (id === '\0test:axios') return `
          const service = config => globalThis.${token}.state.axiosHandler(config);
          service.interceptors = { request: { use() {} }, response: { use() {} } };
          export default { create: () => service };
        `;
        if (id === '\0test:@lark-base-open/js-sdk') return `
          export const bitable = globalThis.${token}.sdk;
          export const FieldType = {Text:1,Number:2,SingleSelect:3,MultiSelect:4,DateTime:5,Url:15,Attachment:17};
          export const NumberFormatter = {INTEGER:'0'};
          export const DateFormatter = {DATE_TIME:'yyyy/MM/dd HH:mm'};
        `;
        if (id === '\0test:element-plus') return `
          export const ElMessage = notice => globalThis.${token}.state.notices.push(notice);
          export const ElNotification = ElMessage;
        `;
      },
    }],
    ssr: { noExternal: ['@lark-base-open/js-sdk', 'element-plus', ...(options.mockAxios ? ['axios'] : [])] },
  });
  try {
    const modules = await Promise.all(paths.map(path => server.ssrLoadModule(path)));
    return { modules, state, sdk, close: async () => { await server.close(); delete globalThis[token]; } };
  } catch (error) {
    await server.close(); delete globalThis[token]; throw error;
  }
}

export function fakeTable(id, name, fields = [], records = []) {
  const table = { id, name, records: structuredClone(records), fields: structuredClone(fields), writes: 0 };
  const field = meta => ({
    id: meta.id,
    getType: async () => meta.type,
    setFormatter: async formatter => { meta.formatter = formatter; },
    setDateFormat: async format => { meta.dateFormat = format; },
    createCell: async value => ({ fieldId: meta.id, value, getValue: async () => value }),
  });
  Object.assign(table, {
    getFieldMetaList: async () => table.fields,
    getField: async name => {
      const meta = table.fields.find(meta => meta.name === name);
      if (!meta) throw new Error('Field not found');
      return field(meta);
    },
    getFieldById: async id => {
      const meta = table.fields.find(meta => meta.id === id);
      if (!meta) throw new Error('Field not found');
      return field(meta);
    },
    setField: async (id, config) => Object.assign(table.fields.find(meta => meta.id === id), config),
    addField: async config => {
      const id = `field-${table.fields.length + 1}`;
      table.fields.push({ ...config, id });
      return id;
    },
    getRecordsByPage: async () => ({ records: structuredClone(table.records), hasMore: false }),
    addRecords: async batch => {
      table.writes++;
      return batch.map(cells => {
        const record = { recordId: `record-${table.records.length + 1}`, fields: Object.fromEntries(cells.map(cell => [cell.fieldId, cell.value])) };
        table.records.push(record);
        return record.recordId;
      });
    },
    setRecords: async batch => {
      table.writes++;
      return batch.map(update => {
        Object.assign(table.records.find(record => record.recordId === update.recordId).fields, update.fields);
        return update.recordId;
      });
    },
  });
  return table;
}
