export const settings = { currency: "USD" };

export function formatPrice(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${whole}.${frac} ${settings.currency}`;
}

export function applyDiscount(cents: number): number {
  if (cents >= 10000) {
    return Math.round((cents * 90) / 100);
  }
  return cents;
}

export function parseAmount(input: string): number {
  const match = /^(\d+)(?:\.(\d{2}))?$/.exec(input.trim());
  if (!match) {
    throw new Error(`invalid amount: ${input}`);
  }
  return Number(match[1]) * 100 + Number(match[2] ?? 0);
}

export function backoffMs(attempt: number): number {
  const base = 100 * 2 ** attempt;
  return base + Math.floor(Math.random() * base);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function reconcile(charged: number[], settled: number[]): number {
  let diff = 0;
  for (const c of charged) diff += c;
  for (const s of settled) diff -= s;
  return diff;
}

export interface Order {
  email: string;
  items: number[];
  total?: number;
}

export interface Store {
  save(order: Order): Promise<void>;
}

export interface Mailer {
  send(to: string, body: string): Promise<void>;
}

export async function checkout(store: Store, mailer: Mailer, order: Order): Promise<Order> {
  let total = 0;
  for (const item of order.items) total += item;
  const saved = { ...order, email: normalizeEmail(order.email), total: applyDiscount(total) };
  await store.save(saved);
  await mailer.send(saved.email, `Total: ${formatPrice(saved.total)}`);
  return saved;
}
