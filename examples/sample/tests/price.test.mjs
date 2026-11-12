import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDiscount, total } from '../src/price.mjs'

test('total adds price times quantity', () => {
  assert.equal(total([{ price: 3, quantity: 2 }, { price: 5, quantity: 1 }]), 11)
})

test('applyDiscount takes a percentage off', () => {
  assert.equal(applyDiscount(200, 15), 170)
})

test('applyDiscount rejects percentages outside 0..100', () => {
  assert.throws(() => applyDiscount(100, 120), RangeError)
})
