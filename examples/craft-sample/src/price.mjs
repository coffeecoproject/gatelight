// 订单金额：商品合计，满额减。

export function total(items) {
  let sum = 0
  for (const item of items) {
    sum += item.price * item.quantity
  }
  return sum
}

export function applyCoupon(amount, coupon) {
  if (amount >= coupon.threshold) {
    return amount - coupon.off
  }
  return amount
}
