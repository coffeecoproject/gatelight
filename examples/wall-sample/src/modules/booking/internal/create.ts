import { round } from '../../../shared/money.ts'

export function createBooking(amount: number): number {
  return round(price(amount))
}

export function price(amount: number): number {
  return amount * 2
}
