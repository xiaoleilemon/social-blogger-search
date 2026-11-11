const toFieldOption = field => ({ id: field.id, name: field.name, type: field.type });

// 数据表字段列表不保证与视图列顺序一致，字段映射优先使用当前视图的有序字段。
export async function getOrderedTableFields(table) {
  try {
    const view = await table.getActiveView();
    const fields = await view.getFieldMetaList();
    return fields.map(toFieldOption);
  } catch {
    const fields = await table.getFieldMetaList();
    return fields.map(toFieldOption);
  }
}

// SDK 0.5.0 / 1.0.2 按 ID 缓存字段实例；getType() 更新不会改变实例的转换方法。
// SDK 未提供公开刷新接口，仅在类型变化时清除该字段缓存；刷新失败则拒绝写入。
export async function resolveWritableField(table, sourceField) {
  let field = sourceField;
  const fieldType = await field.getType();
  if (field.type != null && field.type !== fieldType) {
    if (table.fieldCache?.get(field.id)?.type !== fieldType) {
      table.fieldCache?.delete(field.id);
    }
    field = await table.getFieldById(field.id);
    if (field.type !== fieldType) {
      throw new Error(`字段“${field.id}”类型已更改，暂时无法刷新字段，请稍后重试`);
    }
  }
  return { field, fieldType };
}
