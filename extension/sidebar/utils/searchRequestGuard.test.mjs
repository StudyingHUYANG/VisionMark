import assert from 'node:assert/strict';
import test from 'node:test';

import { createSearchRequestGuard } from './searchRequestGuard.mjs';

test('only the newest search request can update UI state', () => {
  const guard = createSearchRequestGuard();
  const currentRequest = guard.begin();
  const libraryRequest = guard.begin();

  assert.equal(guard.isCurrent(currentRequest), false);
  assert.equal(guard.isCurrent(libraryRequest), true);
});

test('scope or bvid change invalidates an in-flight request', () => {
  const guard = createSearchRequestGuard();
  const requestId = guard.begin();
  guard.invalidate();

  assert.equal(guard.isCurrent(requestId), false);
});
