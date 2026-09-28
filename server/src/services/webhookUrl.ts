import net from 'node:net';
import dns from 'node:dns';

/**
 * Whether a hostname resolves to a private, loopback or link-local address.
 * The literal-address rules in webhookUrlProblem cannot see a public name that
 * resolves inward; this can, and is asked both when a webhook is created and
 * again at each delivery, since DNS answers change. A name that does not
 * resolve at all is reported as not private: the delivery will fail on its own
 * and say why.
 */
export async function webhookHostResolvesPrivate(
  host: string,
  lookup: (host: string) => Promise<Array<{ address: string }>> = (h) => dns.promises.lookup(h, { all: true }),
): Promise<boolean> {
  if (net.isIP(host)) return isPrivateAddress(host);
  try {
    const answers = await lookup(host);
    return answers.some((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Whether a webhook destination is one this server should be willing to POST
 * to, as a sentence for the admin, or null when it is.
 *
 * A webhook is the server making an outbound request to an address a tenant
 * admin typed. Left unchecked that is a way to make Questor call its own
 * loopback port, a cloud metadata service, or anything else on the private
 * network the server sits on, with a signed body attached. The rules here are
 * literal-address rules; they do not resolve names, so a public name that
 * resolves to a private address is not caught. That is a known gap, bounded by
 * the fact that only tenant admins can create webhooks and every creation is
 * audited.
 */
export function webhookUrlProblem(raw: string, nodeEnv: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full URL, starting with https://';
  }
  if (url.username || url.password) return 'Put credentials in a header your receiver checks, not in the URL.';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && nodeEnv !== 'production')) {
    return 'Webhooks must use https.';
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'Webhooks cannot point at this machine or a private network.';
  }
  if (isPrivateAddress(host)) return 'Webhooks cannot point at this machine or a private network.';
  return null;
}

function isPrivateAddress(host: string): boolean {
  const kind = net.isIP(host);
  if (kind === 4) return isPrivateV4(host);
  if (kind === 6) return isPrivateV6(host);
  return false;
}

export { isPrivateAddress };

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map((part) => Number(part));
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // IPv4 mapped into IPv6 is still the IPv4 address. The URL parser rewrites
  // "::ffff:127.0.0.1" into its hex form "::ffff:7f00:1", so both are read.
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateV4(dotted[1]);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}
