(function (root, factory) {
  const api = factory();
  root.HSLStorage = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(globalThis, function () {
  'use strict';

  function isKey(key) {
    return typeof key === 'string' && key.length > 0;
  }

  function isPlainObject(value) {
    if (value == null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (isPlainObject(value)) {
      const result = {};
      for (const key of Object.keys(value)) result[key] = clone(value[key]);
      return result;
    }
    return value;
  }

  function isJSONValue(value, seen) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    if (!Array.isArray(value) && !isPlainObject(value)) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const values = Array.isArray(value) ? value : Object.values(value);
    const valid = values.every((child) => isJSONValue(child, seen));
    seen.delete(value);
    return valid;
  }

  function isCloneableJSONShape(value, seen) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return true;
    if (typeof value !== 'object') return false;
    if (!Array.isArray(value) && !isPlainObject(value)) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const values = Array.isArray(value) ? value : Object.values(value);
    const valid = values.every((child) => isCloneableJSONShape(child, seen));
    seen.delete(value);
    return valid;
  }

  function encodeJSON(value) {
    try {
      if (!isJSONValue(value, new Set())) return null;
      const encoded = JSON.stringify(value);
      return typeof encoded === 'string' ? encoded : null;
    } catch (_) {
      return null;
    }
  }

  function sameJSON(left, right) {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((value, index) => sameJSON(value, right[index]));
    }
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJSON(left[key], right[key]));
  }

  function mergeDefaultValues(defaults, stored) {
    if (!isPlainObject(defaults)) return clone(stored);
    if (!isPlainObject(stored)) return clone(defaults);
    const result = clone(defaults);
    for (const key of Object.keys(stored)) {
      result[key] = Object.prototype.hasOwnProperty.call(defaults, key)
        ? mergeDefaultValues(defaults[key], stored[key])
        : clone(stored[key]);
    }
    return result;
  }

  function create(storage) {
    function get(key) {
      if (!isKey(key) || storage == null) return null;
      try {
        if (typeof storage.getItem !== 'function') return null;
        return storage.getItem(key);
      } catch (_) {
        return null;
      }
    }

    function set(key, value) {
      if (!isKey(key) || storage == null) return false;
      try {
        if (typeof storage.setItem !== 'function') return false;
        storage.setItem(key, value);
        return true;
      } catch (_) {
        return false;
      }
    }

    function fallbackValue(fallback) {
      return clone(fallback);
    }

    function readJSON(key, fallback, options) {
      if (!isKey(key)) return fallbackValue(fallback);
      const raw = get(key);
      if (typeof raw !== 'string') return fallbackValue(fallback);
      let value;
      try {
        value = JSON.parse(raw);
      } catch (_) {
        return fallbackValue(fallback);
      }
      const settings = options && typeof options === 'object' ? options : {};
      try {
        if (settings.mergeDefaults === true) {
          value = mergeDefaultValues(fallback, value);
        } else if (typeof settings.mergeDefaults === 'function') {
          value = settings.mergeDefaults(clone(value), fallbackValue(fallback));
        } else {
          value = clone(value);
        }
        if (!isCloneableJSONShape(value, new Set())) return fallbackValue(fallback);
        const beforeMigration = clone(value);
        if (typeof settings.migrate === 'function') value = settings.migrate(clone(value));
        if (!isJSONValue(value, new Set())) return fallbackValue(fallback);
        if (typeof settings.validate === 'function' && !settings.validate(clone(value))) {
          return fallbackValue(fallback);
        }
        const result = clone(value);
        if (typeof settings.migrate === 'function' && !sameJSON(beforeMigration, value)) {
          const encoded = encodeJSON(value);
          if (encoded !== null) set(key, encoded);
        }
        return result;
      } catch (_) {
        return fallbackValue(fallback);
      }
    }

    function writeJSON(key, value) {
      if (!isKey(key)) return false;
      const encoded = encodeJSON(value);
      return encoded === null ? false : set(key, encoded);
    }

    function readString(key, fallback, validate) {
      if (!isKey(key)) return fallback;
      const value = get(key);
      if (typeof value !== 'string') return fallback;
      try {
        return typeof validate === 'function' && !validate(value) ? fallback : value;
      } catch (_) {
        return fallback;
      }
    }

    function writeString(key, value) {
      return isKey(key) && typeof value === 'string' ? set(key, value) : false;
    }

    function readNumber(key, fallback, validate) {
      if (!isKey(key)) return fallback;
      const raw = get(key);
      if (typeof raw !== 'string' || raw.trim() === '') return fallback;
      const value = Number(raw);
      if (!Number.isFinite(value)) return fallback;
      try {
        return typeof validate === 'function' && !validate(value) ? fallback : value;
      } catch (_) {
        return fallback;
      }
    }

    function writeNumber(key, value) {
      return isKey(key) && typeof value === 'number' && Number.isFinite(value) ? set(key, String(value)) : false;
    }

    function remove(key) {
      if (!isKey(key) || storage == null) return false;
      try {
        if (typeof storage.removeItem !== 'function') return false;
        storage.removeItem(key);
        return true;
      } catch (_) {
        return false;
      }
    }

    return { readJSON, writeJSON, readString, writeString, readNumber, writeNumber, remove };
  }

  return { create };
}));
