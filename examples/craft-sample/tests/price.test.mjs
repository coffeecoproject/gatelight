import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCoupon, total } from '../src/price.mjs'

test('合计是单价乘数量再相加', () => {
  assert.equal(total([{ price: 3, quantity: 2 }, { price: 5, quantity: 1 }]), 11)
})

test('满额才减', () => {
  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 80)
  assert.equal(applyCoupon(99, { threshold: 100, off: 20 }), 99)
})
