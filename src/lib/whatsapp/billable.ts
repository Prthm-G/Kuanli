// Meta attaches a `pricing` object to sent/delivered/read status webhooks
// (per-message pricing since 2025-07-01). One row per message id is enough to
// count a month's API usage per number; later statuses for the same id are
// ignored by the primary key.
export interface StatusPricing {
  billable?: boolean
  category?: string
  type?: string
  pricing_model?: string
}

export interface PricingRow {
  message_id: string
  phone_number_id: string
  billable: boolean | null
  category: string | null
  pricing_type: string | null
  pricing_model: string | null
}

export function pricingRow(
  status: { id: string; status: string; pricing?: StatusPricing },
  phoneNumberId: string,
): PricingRow | null {
  if (!status.id || !status.pricing || status.status === 'failed') return null
  const p = status.pricing
  return {
    message_id: status.id,
    phone_number_id: phoneNumberId,
    billable: typeof p.billable === 'boolean' ? p.billable : null,
    category: p.category ?? null,
    pricing_type: p.type ?? null,
    pricing_model: p.pricing_model ?? null,
  }
}
