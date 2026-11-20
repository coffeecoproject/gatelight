import assert from 'node:assert/strict'
import { test } from 'node:test'
import { price } from '../src/modules/booking/internal/create.ts'

test('预订价是金额的两倍', () => {
  assert.equal(price(10), 20)
})
