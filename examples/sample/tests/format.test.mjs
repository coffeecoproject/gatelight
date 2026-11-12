import assert from 'node:assert/strict'
import { test } from 'node:test'
import { yuan } from '../src/format.mjs'

test('yuan shows two decimals', () => {
  assert.equal(yuan(3.5), '¥3.50')
})
