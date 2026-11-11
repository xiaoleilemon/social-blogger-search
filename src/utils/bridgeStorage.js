import { bitable } from '@lark-base-open/js-sdk';
import { toRaw } from 'vue';

const OMIT = Symbol('omit');

const toStorableValue = (value, seen) => {
  const raw = toRaw(value);
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === 'function' || typeof raw === 'symbol') return OMIT;
  if (typeof raw !== 'object') return raw;
  if (seen.has(raw)) return OMIT;

  seen.add(raw);
  if (Array.isArray(raw)) {
    return raw.map(item => {
      const cloned = toStorableValue(item, seen);
      return cloned === OMIT ? null : cloned;
    });
  }
  if (raw instanceof Date) return new Date(raw.getTime());

  return Object.fromEntries(Object.entries(raw)
    .map(([key, item]) => [key, toStorableValue(item, seen)])
    .filter(([, item]) => item !== OMIT));
};

export const toBridgeData = value => {
  const cloned = toStorableValue(value, new WeakSet());
  return cloned === OMIT ? undefined : cloned;
};

export const setBridgeData = (key, value) => bitable.bridge.setData(key, toBridgeData(value));
