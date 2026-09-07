import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CollabError } from '@claudian-collab/protocol';

import { boundProjectAuthorityPage } from '../../src/project-authority/ProjectAuthorityPage.js';

const CREATED_AT = '2026-09-07T00:00:00.000Z';
const comments = Object.freeze([
  Object.freeze({ id: 'one', body: 'é\n"' }),
  Object.freeze({ id: 'two', body: '😀\\' }),
  Object.freeze({ id: 'three', body: '\u0000' }),
]);
const key = (item: typeof comments[number]) => ({
  createdAt: CREATED_AT,
  id: item.id,
});

describe('ProjectAuthorityPage', () => {
  it('fits an exact UTF-8 boundary and resumes at the last accepted item', () => {
    const firstPageJson = '{"comments":[{"id":"one","body":"é\\n\\""},{"id":"two","body":"😀\\\\"}],"nextCursor":"two"}';
    const result = boundProjectAuthorityPage(comments, {
      encodeKey: cursor => cursor.id,
      hasMore: false,
      itemField: 'comments',
      key,
      maximumUtf8Bytes: Buffer.byteLength(firstPageJson),
    });
    assert.deepEqual(result, { items: comments.slice(0, 2), nextCursor: 'two' });
    assert.equal(JSON.stringify({ comments: result.items, nextCursor: result.nextCursor }), firstPageJson);
    assert.equal(Object.isFrozen(result.items), true);
    assert.equal(comments.length, 3);

    const smaller = boundProjectAuthorityPage(comments, {
      encodeKey: cursor => cursor.id,
      hasMore: false,
      itemField: 'comments',
      key,
      maximumUtf8Bytes: Buffer.byteLength(firstPageJson) - 1,
    });
    assert.deepEqual(smaller, { items: comments.slice(0, 1), nextCursor: 'one' });
  });

  it('omits the terminal cursor and counts the chosen cursor length', () => {
    const finalPageJson = '{"comments":[{"id":"one","body":"é\\n\\""}]}';
    assert.deepEqual(boundProjectAuthorityPage(comments.slice(0, 1), {
      encodeKey: cursor => `longer-${cursor.id}`,
      hasMore: false,
      itemField: 'comments',
      key,
      maximumUtf8Bytes: Buffer.byteLength(finalPageJson),
    }), { items: comments.slice(0, 1), nextCursor: undefined });
    assert.throws(() => boundProjectAuthorityPage(comments.slice(0, 1), {
      encodeKey: cursor => `longer-${cursor.id}`,
      hasMore: true,
      itemField: 'comments',
      key,
      maximumUtf8Bytes: Buffer.byteLength(finalPageJson),
    }), CollabError);
  });

  it('retains count-limited cursors, empty pages, and first-item rejection', () => {
    const limited = boundProjectAuthorityPage(comments, {
      hasMore: true,
      itemField: 'comments',
      key,
      maximumUtf8Bytes: 1_024,
    });
    assert.deepEqual(limited.items, comments);
    assert.ok(limited.nextCursor);
    assert.deepEqual(JSON.parse(Buffer.from(limited.nextCursor, 'base64url').toString('utf8')), {
      createdAt: CREATED_AT,
      id: 'three',
    });
    assert.deepEqual(boundProjectAuthorityPage([], {
      hasMore: false,
      itemField: 'tickets',
      key,
      maximumUtf8Bytes: 1_024,
    }), { items: [], nextCursor: undefined });
    assert.throws(() => boundProjectAuthorityPage(comments, {
      hasMore: false,
      itemField: 'comments',
      key,
      maximumUtf8Bytes: 1,
    }), (error: unknown) => error instanceof CollabError
      && error.code === 'authority-integrity-error');
  });
});
