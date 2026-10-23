import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReferences, sha256 } from '../../packages/ui-testing/dist/index.js';

async function setup(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ui-reference-reads-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, 'source.txt');
  await fs.writeFile(path, 'frozen');
  const readFile = fs.readFile, calls = [];
  t.mock.method(fs, 'readFile', async (...args) => {
    calls.push(args[0]);
    return readFile(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { root, path, calls, ref: { path: 'source.txt', sha256: sha256('frozen') } };
}

test('one reference verification reads repeated identical evidence once', async t => {
  const { root, calls, ref } = await setup(t);
  await verifyReferences(root, { files: [ref], bindings: [{ script_ref: ref }, { source: { ref } }] });
  assert.equal(calls.length, 1);
});

test('conflicting digests for the same path cannot reuse a previous successful check', async t => {
  const { root, calls, ref } = await setup(t);
  await assert.rejects(verifyReferences(root, [ref, { ...ref, sha256: sha256('different') }]), /摘要不匹配/);
  assert.equal(calls.length, 2);
});

test('later calls revalidate changed, deleted and escaping evidence', async t => {
  const { root, path, calls, ref } = await setup(t);
  await verifyReferences(root, [ref, ref]);
  await fs.writeFile(path, 'changed');
  await assert.rejects(verifyReferences(root, [ref, ref]), /摘要不匹配/);
  assert.equal(calls.length, 2);
  await fs.rm(path);
  await assert.rejects(verifyReferences(root, [ref]), /不存在或不可读取/);
  const outside = await fs.mkdtemp(join(tmpdir(), 'ui-reference-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(join(outside, 'source.txt'), 'frozen');
  await fs.symlink(join(outside, 'source.txt'), path);
  await assert.rejects(verifyReferences(root, [ref]), /真实路径边界/);
});

test('concurrent verifications do not share successful evidence across calls', async t => {
  const { root, calls, ref } = await setup(t);
  await Promise.all([verifyReferences(root, [ref, ref]), verifyReferences(root, [ref, ref])]);
  assert.equal(calls.length, 2);
});
