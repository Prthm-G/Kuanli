import { describe, expect, it } from 'vitest'
import { pricingRow } from './billable'

describe('pricingRow', () => {
  it('maps a sent status with pricing', () => {
    expect(
      pricingRow(
        { id: 'wamid.A', status: 'sent', pricing: { billable: true, category: 'service', type: 'regular', pricing_model: 'PMP' } },
        '1320822847785161',
      ),
    ).toEqual({ message_id: 'wamid.A', phone_number_id: '1320822847785161', billable: true, category: 'service', pricing_type: 'regular', pricing_model: 'PMP' })
  })
  it('keeps a free entry point message', () => {
    expect(pricingRow({ id: 'wamid.B', status: 'delivered', pricing: { billable: false, category: 'service', type: 'free_entry_point' } }, 'x')?.pricing_type).toBe('free_entry_point')
  })
  it('ignores statuses without pricing, failed sends, or no id', () => {
    expect(pricingRow({ id: 'wamid.C', status: 'read' }, 'x')).toBeNull()
    expect(pricingRow({ id: 'wamid.D', status: 'failed', pricing: { billable: true } }, 'x')).toBeNull()
    expect(pricingRow({ id: '', status: 'sent', pricing: { billable: true } }, 'x')).toBeNull()
  })
})
