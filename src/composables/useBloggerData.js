import { resolveWritableField } from "../utils/tableFields.js";
import { bitable, DateFormatter, FieldType, NumberFormatter } from '@lark-base-open/js-sdk';
import { ElMessage } from 'element-plus';

// 提取自 social-data-bridge，只保留作者字段及表格写入行为。
export const BLOGGER_FIELD_MAPPING = [
  { key: 'nickname', name: '作者名称', legacyNames: ['作者'], type: FieldType.Text, defaultSelected: true },
  { key: 'uid', name: '作者账号', type: FieldType.Text, defaultSelected: true },
  { key: 'user_id', name: '作者ID', legacyNames: ['用户ID'], type: FieldType.Text, defaultSelected: true, required: true },
  { key: 'profile_url', name: '作者主页链接', type: FieldType.Url, defaultSelected: true },
  { key: 'avatar', name: '作者头像', legacyNames: ['博主头像'], type: FieldType.Text, defaultSelected: true },
  { key: 'signature', name: '个人简介', type: FieldType.Text, defaultSelected: true },
  { key: 'follower_count', name: '粉丝数', type: FieldType.Number, defaultSelected: true, formatter: NumberFormatter.INTEGER },
  { key: 'following_count', name: '关注数', type: FieldType.Number, defaultSelected: true, formatter: NumberFormatter.INTEGER },
  { key: 'total_favorited', name: '获赞数', type: FieldType.Number, defaultSelected: true, formatter: NumberFormatter.INTEGER },
  { key: 'aweme_count', name: '作品数', type: FieldType.Number, defaultSelected: true, formatter: NumberFormatter.INTEGER },
  { key: 'verified', name: '认证状态', type: FieldType.Text, defaultSelected: true },
  { key: 'verification_category', name: '认证类型', type: FieldType.Text, defaultSelected: true },
  { key: 'social_type', name: '平台', type: FieldType.Text, defaultSelected: true, requiredForUpsert: true },
  { key: 'ip_location', name: 'IP属地', type: FieldType.Text, defaultSelected: true },
  { key: 'ctime', name: '提取时间', type: FieldType.DateTime, defaultSelected: true, isTimestamp: true, dateFormat: DateFormatter.DATE_TIME },
];

export const showErrorMsg = (message, duration = 3000) => ElMessage({ message, type: 'error', plain: true, duration });
export const getDefaultSelectedFieldKeys = (mapping = BLOGGER_FIELD_MAPPING) => mapping
  .filter(field => field.defaultSelected || field.required).map(field => field.key);
const activeFields = (keys, options = {}) => BLOGGER_FIELD_MAPPING.filter(field => field.required
  || (field.requiredForUpsert && options.writeMode === 'upsert') || keys.includes(field.key));
const chunks = (items, size = 200) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

const allowedTypes = config => {
  if (config.type === FieldType.Number) return [FieldType.Number, FieldType.Text];
  if (['nickname', 'social_type'].includes(config.key)) return [FieldType.Text, FieldType.SingleSelect];
  if (config.key === 'profile_url') return [FieldType.Text, FieldType.Url];
  return [config.type];
};
const normalizeKey = value => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(normalizeKey).filter(Boolean).join(',');
  if (typeof value === 'object') return normalizeKey(value.text ?? value.name ?? value.value);
  return String(value).trim();
};
const authorKey = (userId, platform) => {
  const id = normalizeKey(userId);
  const source = normalizeKey(platform).toLowerCase();
  // 无法确定平台归属的历史行不能按 ID 匹配，避免覆盖其他平台作者。
  return id && source ? JSON.stringify([source, id]) : '';
};
const cellValue = (item, config, type) => {
  let value = item[config.key];
  if ((type === FieldType.Number || type === FieldType.DateTime) && (value == null || value === '')) return null;
  if (config.isTimestamp && value != null && value !== '') value = Number(value) * 1000;
  if (config.key === 'verified') return value === true ? '已认证' : value === false ? '未认证' : String(value ?? '');
  if (type === FieldType.SingleSelect) return String(value ?? '').trim() || null;
  if (config.type === FieldType.Number && type === FieldType.Text) return String(value ?? '');
  return value ?? '';
};
const applyFormat = async (field, config) => {
  const type = await field.getType();
  if (config.formatter && type === FieldType.Number) await field.setFormatter(config.formatter);
  if (config.dateFormat && type === FieldType.DateTime) await field.setDateFormat(config.dateFormat);
};

const safeTableName = name => (String(name || '').replace(/[\u0000-\u001f\u007f]/g, '')
  .replace(/[\\/:*?\[\]]/g, ' ').replace(/\s+/g, ' ').trim() || '作者搜索').slice(0, 80);

export async function createSequentialTable(name) {
  const stem = safeTableName(name);
  const tables = await bitable.base.getTableMetaList();
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}(\\d+)$`);
  const suffixes = tables.map(table => table.name.match(pattern)).filter(Boolean).map(match => Number(match[1]));
  const exists = tables.some(table => table.name === stem) || suffixes.length;
  return bitable.base.addTable({ name: exists ? `${stem}${Math.max(0, ...suffixes) + 1}` : stem });
}

// 先验证现有列，再补齐缺失列；显式映射失效时不能退回同名匹配。
async function resolveFields(table, selectedKeys, options = {}) {
  const metas = await table.getFieldMetaList();
  const mappings = new Map((options.fieldMappings || []).map(mapping => [mapping.source_key, mapping.target_field_id]));
  const resolved = [];
  for (const config of activeFields(selectedKeys, options)) {
    const mappedId = mappings.get(config.key);
    const meta = mappedId
      ? metas.find(meta => meta.id === mappedId)
      : [config.name, ...(config.legacyNames || [])].map(name => metas.find(meta => meta.name === name)).find(Boolean);
    if (mappedId && !meta) throw new Error(`字段“${config.name}”映射的目标字段不存在`);
    const { field, fieldType: type } = meta
      ? await resolveWritableField(table, await table.getFieldById(meta.id))
      : { field: null, fieldType: config.type };
    if (!allowedTypes(config).includes(type)) throw new Error(`字段“${config.name}”类型不匹配，请修改目标字段类型或字段映射`);
    resolved.push({ config, field, type });
  }
  for (const entry of resolved) {
    if (!entry.field) {
      options.onProgress?.(`正在创建字段：${entry.config.name}...`);
      const id = await table.addField({ type: entry.config.type, name: entry.config.name });
      entry.field = await table.getFieldById(id);
    }
    await applyFormat(entry.field, entry.config);
  }
  return resolved;
}

const readTableRecords = async table => {
  const records = [];
  let pageToken;
  do {
    const page = await table.getRecordsByPage({ pageSize: 200, pageToken });
    records.push(...(page.records || []));
    if (page.hasMore && (!page.pageToken || page.pageToken === pageToken)) throw new Error('读取现有表记录时未返回有效分页游标');
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined);
  return records;
};

export function useBloggerData(getTableName) {
  const indexes = new Map();
  const validateTableFields = async (tableId, selectedKeys = [], options = {}) => {
    try {
      await resolveFields(await bitable.base.getTableById(tableId), selectedKeys, options);
      return true;
    } catch (error) {
      if (options.throwOnError) throw error;
      showErrorMsg(error.message || '验证表格字段失败，请稍后重试');
      return false;
    }
  };

  const createAndWriteData = async (items, _type, taskId, targetTableId = '', selectedKeys = [], options = {}) => {
    if (!items?.length) return { tableId: targetTableId, recordIds: [] };
    let tableId = targetTableId;
    if (!tableId) {
      const result = await createSequentialTable(getTableName());
      tableId = result.tableId;
      // 创建成功立即通知任务层，写入失败重试时继续使用此表。
      await options.onTargetTableReady?.(tableId);
      const table = await bitable.base.getTableById(tableId);
      const first = (await table.getFieldMetaList()).find(meta => meta.type === FieldType.Text);
      const config = activeFields(selectedKeys, options)[0];
      if (first && config) await table.setField(first.id, { type: config.type, name: config.name });
      await bitable.ui.switchToTable(tableId);
    }
    const table = await bitable.base.getTableById(tableId);
    const fields = await resolveFields(table, selectedKeys, options);
    const prepared = [];
    for (const item of items) {
      const values = fields.map(({ field, config, type }) => ({ field, value: cellValue(item, config, type) }));
      const cells = await Promise.all(values.map(({ field, value }) => field.createCell(value)));
      prepared.push({
        key: authorKey(item.user_id, item.social_type),
        cells,
        fields: Object.fromEntries(await Promise.all(cells.map(async (cell, index) => [values[index].field.id, await cell.getValue()]))),
      });
    }

    const recordIds = [];
    let cacheKey;
    const append = async records => {
      for (const batch of chunks(records)) {
        let added;
        try {
          await options.onBeforeWrite?.();
          added = await table.addRecords(batch.map(record => record.cells));
          if (added.length !== batch.length) throw new Error('写入未完成，请核对目标表后重试');
        } catch (error) {
          indexes.delete(cacheKey);
          throw error;
        }
        added.forEach((recordId, i) => {
          recordIds.push(recordId);
          if (existing && batch[i].key) existing.set(batch[i].key, recordId);
        });
      }
    };
    const appendRecovered = async records => {
      if (!options.appendState) return append(records);
      // 沿用推荐词的失败批次核对；只保存当前批次匹配的历史ID，保留正常追加语义。
      const state = options.appendState;
      if (state.totalCount !== undefined && state.totalCount !== records.length) {
        throw Object.assign(new Error('待核对批次与原结果不一致，请核对后重新进入插件'), { stopPolling: true, requiresReopen: true });
      }
      state.totalCount = records.length;
      const fieldIds = fields.map(({ field }) => field.id);
      const recordKey = values => JSON.stringify(fields.map(({ field, type }) => {
        const value = values[field.id];
        if (type === FieldType.Text) return Array.isArray(value) ? value.map(part => part.text).join('') : String(value ?? '');
        if (type === FieldType.SingleSelect) return value?.text ?? value ?? '';
        if (type === FieldType.Url && Array.isArray(value)) return value.map(({ type, text, link }) => ({ type, text, link }));
        return value ?? null;
      }));
      recordIds.push(...(state.recordIds || []));
      for (const batch of chunks(records.slice(state.completedCount || 0))) {
        const keys = batch.map(record => recordKey(record.fields));
        let pending = batch;
        const recovered = [];
        if (state.pending) {
          // 旧检查点沿用原key格式，比较时同样归一化URL字段。
          const savedKeys = state.pending.keys.map(key => {
            const values = JSON.parse(key);
            return recordKey(Object.fromEntries(state.pending.fieldIds.map((id, index) => [id, values[index]])));
          });
          if (JSON.stringify(state.pending.fieldIds) !== JSON.stringify(fieldIds) || JSON.stringify(savedKeys) !== JSON.stringify(keys)) {
            throw Object.assign(new Error('待核对批次或目标字段与原结果不一致，请核对后重新进入插件'), { stopPolling: true, requiresReopen: true });
          }
          const known = new Set(state.pending.knownRecordIds);
          const expected = new Map();
          keys.forEach(key => expected.set(key, (expected.get(key) || 0) + 1));
          const matches = new Map();
          for (const record of await readTableRecords(table)) {
            if (known.has(record.recordId)) continue;
            const key = recordKey(record.fields);
            if (!expected.has(key)) continue;
            const ids = matches.get(key) || [];
            ids.push(record.recordId);
            if (ids.length > expected.get(key)) throw Object.assign(new Error('核对到多于预期的相同记录，请检查目标表后重新进入插件'), { stopPolling: true, requiresReopen: true });
            matches.set(key, ids);
          }
          pending = batch.filter((_, index) => {
            const ids = matches.get(keys[index]);
            if (!ids?.length) return true;
            recovered.push(ids.shift());
            return false;
          });
        } else {
          const expected = new Set(keys);
          state.pending = { fieldIds, keys, knownRecordIds: (await readTableRecords(table))
            .filter(record => expected.has(recordKey(record.fields))).map(record => record.recordId) };
        }
        await options.onBeforeWrite?.();
        const added = pending.length ? await table.addRecords(pending.map(record => record.cells)) : [];
        if (added.length !== pending.length) throw new Error('写入未完成，请核对目标表后重试');
        recordIds.push(...recovered, ...added);
        state.recordIds = [...(state.recordIds || []), ...recovered, ...added];
        state.completedCount = (state.completedCount || 0) + batch.length;
        delete state.pending;
      }
    };
    let existing;
    if (options.writeMode === 'upsert') {
      const idField = fields.find(entry => entry.config.key === 'user_id').field;
      const platformField = fields.find(entry => entry.config.key === 'social_type').field;
      cacheKey = `${taskId}:${tableId}:${idField.id}:${platformField.id}`;
      existing = indexes.get(cacheKey);
      if (!existing) {
        existing = new Map();
        for (const record of await readTableRecords(table)) {
          const key = authorKey(record.fields?.[idField.id], record.fields?.[platformField.id]);
          if (key) existing.set(key, record.recordId);
        }
        indexes.set(cacheKey, existing);
      }
      const unique = new Map(prepared.filter(record => record.key).map(record => [record.key, record]));
      const updates = [...unique.values()].filter(record => existing.has(record.key))
        .map(record => ({ recordId: existing.get(record.key), fields: record.fields }));
      for (const batch of chunks(updates)) {
        try {
          await options.onBeforeWrite?.();
          const updated = await table.setRecords(batch);
          if (updated.length !== batch.length) throw new Error('更新未完成，请核对目标表后重试');
          recordIds.push(...updated);
        } catch (error) {
          indexes.delete(cacheKey);
          throw error;
        }
      }
      await append([...unique.values()].filter(record => !existing.has(record.key)));
      await appendRecovered(prepared.filter(record => !record.key));
    } else {
      await appendRecovered(prepared);
    }
    return { tableId, recordIds };
  };
  return { createAndWriteData, validateTableFields };
}
