import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_CLIENT_ID_STORAGE_KEY,
  generateBrowserClientId,
  getOrCreateBrowserClientId,
  isValidBrowserClientId,
} from './clientIdentity.ts';

test('generateBrowserClientId produces valid persistent client IDs', () => {
  const idA = generateBrowserClientId();
  const idB = generateBrowserClientId();
  assert.equal(isValidBrowserClientId(idA), true);
  assert.equal(isValidBrowserClientId(idB), true);
  assert.notEqual(idA, idB);
});

test('getOrCreateBrowserClientId reuses stored ID and replaces invalid values', () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => {
      store.set(key, val);
    },
  };

  const first = getOrCreateBrowserClientId(mockStorage);
  const second = getOrCreateBrowserClientId(mockStorage);
  assert.equal(first, second);
  assert.equal(store.get(BROWSER_CLIENT_ID_STORAGE_KEY), first);

  store.set(BROWSER_CLIENT_ID_STORAGE_KEY, 'bad id!');
  const regenerated = getOrCreateBrowserClientId(mockStorage);
  assert.notEqual(regenerated, 'bad id!');
  assert.equal(isValidBrowserClientId(regenerated), true);
});
