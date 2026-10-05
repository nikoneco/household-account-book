'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../gas/Server.gs'), 'utf8');
function fixture(parentIds, configured = true) {
  const folder = id => ({getId: () => id, getSharingAccess: () => 'PRIVATE', getEditors: () => [], getViewers: () => []});
  const pool = folder('pool');
  const archive = folder('archive');
  let reads = 0;
  const file = {...folder('image'), isTrashed: () => false, getParents() {
    let i = 0; const parents = parentIds.map(folder);
    return {hasNext: () => i < parents.length, next: () => parents[i++]};
  }};
  const context = {
    PropertiesService: {getScriptProperties: () => ({getProperty: key => key === 'HOUSEHOLD_RECEIPT_ARCHIVE_FOLDER_ID' && configured ? 'archive' : null})},
    DriveApp: {Access: {PRIVATE: 'PRIVATE'}, getFileById: id => {assert.equal(id, 'image'); return file;},
      getFolderById: id => {reads++; assert.equal(id, 'archive'); return archive;}}
  };
  vm.runInNewContext(source, context);
  return {file, archive, read: () => context.receiptFile_({fileId:'image'}, pool), reads: () => reads};
}
test('original Pool images stay readable without archive configuration', () => {
  const f = fixture(['pool'], false); assert.equal(f.read(), f.file); assert.equal(f.reads(), 0);
});
test('same file ID remains readable after moving to configured private archive', () => {
  const f = fixture(['archive']); assert.equal(f.read(), f.file); assert.equal(f.reads(), 1);
});
test('unconfigured or unrelated parents cannot bypass receipt folder restrictions', () => {
  assert.throws(() => fixture(['archive'], false).read(), /IMAGE_NOT_FOUND/);
  assert.throws(() => fixture(['unrelated']).read(), /IMAGE_NOT_FOUND/);
});
test('archived image requires both file and archive to remain private', () => {
  const f = fixture(['archive']); f.archive.getViewers = () => ['viewer'];
  assert.throws(() => f.read(), /STORAGE_NOT_PRIVATE/);
  const g = fixture(['archive']); g.file.getEditors = () => ['editor'];
  assert.throws(() => g.read(), /STORAGE_NOT_PRIVATE/);
});
test('trashed archived image stays unavailable', () => {
  const f = fixture(['archive']); f.file.isTrashed = () => true;
  assert.throws(() => f.read(), /IMAGE_NOT_FOUND/);
});
