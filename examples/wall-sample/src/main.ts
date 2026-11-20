import { charge } from './modules/billing/index.ts'
import { createBooking } from './modules/booking/index.ts'

console.log(charge(createBooking(100)))
