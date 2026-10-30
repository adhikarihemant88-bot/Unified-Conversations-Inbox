import { advance, timestamp } from './domain';
import { Channels } from './channels';

describe('Domain rules', () => {
  it('accepts only forward transitions with failed terminal', () => {
    expect(advance('read', 'sent')).toBe('read');
    expect(advance('queued', 'delivered')).toBe('delivered');
    expect(advance('read', 'failed')).toBe('failed');
    expect(advance('failed', 'read')).toBe('failed');
  });
  it('normalizes channel identities and rejects ambiguous local phone numbers', () => {
    const c = new Channels();
    expect(c.get('sms').normalize('+91 (98765) 43210')).toBe('+919876543210');
    expect(c.get('whatsapp').normalize('whatsapp:+919876543210')).toBe(
      '+919876543210',
    );
    expect(c.get('email').normalize(' Customer@Example.com ')).toBe(
      'customer@example.com',
    );
    expect(() => c.get('sms').normalize('9876543210')).toThrow();
    expect(() => c.get('email').normalize('bad-email')).toThrow();
  });
  it('validates calendar dates before normalization', () => {
    expect(timestamp('2026-10-28T10:15:00+05:30', 'sentAt')).toBe(
      '2026-10-28T04:45:00.000Z',
    );
    expect(() => timestamp('2026-10-28', 'sentAt')).toThrow();
    expect(() => timestamp('2026-02-30T10:15:00Z', 'sentAt')).toThrow();
    expect(() => timestamp('2026-10-28T24:00:00Z', 'sentAt')).toThrow();
  });
  it('mock failure boundary can be tested deterministically', async () => {
    const old = process.env.MOCK_FAILURE_RATE;
    process.env.MOCK_FAILURE_RATE = '0.2';
    const adapter = new Channels().get('sms');
    const random = jest.spyOn(Math, 'random');
    const message = { providerMessageId: 'x', to: '+919876543210', body: 'Hi' };
    try {
      random.mockReturnValue(0.19);
      await expect(adapter.send(message)).rejects.toThrow();
      random.mockReturnValue(0.2);
      await expect(adapter.send(message)).resolves.toBeUndefined();
    } finally {
      random.mockRestore();
      if (old === undefined) delete process.env.MOCK_FAILURE_RATE;
      else process.env.MOCK_FAILURE_RATE = old;
    }
  });
});
