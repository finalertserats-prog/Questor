// Telling an organisation's admins that its scoring changed.
//
// An automatic activation that nobody is told about is an automatic activation
// nobody can revert. The email is the thing that makes "visible and reversible"
// true rather than merely available, so it is sent on every activation and on
// every withdrawal — and never on the far more common "still not enough
// evidence", which would train people to ignore it.

import { logger } from '../logger.js';
import { prisma } from '../db.js';
import { getEmail } from '../providers/email/index.js';
import { brandedEmail, emailButton, escapeHtml, headerSafe } from '../providers/email/branding.js';
import { config } from '../config.js';

export interface CalibrationNotice {
  readonly tenantId: string;
  readonly activated: boolean;
  readonly competencyName: string;
  readonly band: string;
  readonly statement: string;
}

/** Every admin of the organisation. Calibration is tenant-wide, not per candidate. */
export async function calibrationAdminRecipients(tenantId: string): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { tenantId, role: 'admin' },
    select: { email: true },
  });
  return admins.map((a) => a.email).filter((e) => typeof e === 'string' && e.includes('@'));
}

export async function notifyCalibrationAdmins(notice: CalibrationNotice): Promise<{ sentTo: number }> {
  try {
    const email = getEmail();
    // `delivers` is not `configured`: the console provider is configured and
    // delivers nothing, and sending into it would look like a notice was sent.
    if (!email.delivers) return { sentTo: 0 };
    const to = await calibrationAdminRecipients(notice.tenantId);
    if (to.length === 0) return { sentTo: 0 };

    const band = notice.band ? ` (${notice.band})` : '';
    const subject = notice.activated
      ? `Scoring adjusted for ${notice.competencyName}${band}`
      : `Scoring adjustment withdrawn for ${notice.competencyName}${band}`;
    const intro = notice.activated
      ? `Questor has adjusted how it scores ${notice.competencyName}${band}, because your reviewers have consistently read it differently from the model. ${notice.statement}`
      : `Questor has stopped adjusting how it scores ${notice.competencyName}${band}. ${notice.statement}`;
    const tail = notice.activated
      ? 'The model\'s own level is still recorded on every assessment, next to the adjusted one. This affects interviews assessed from now on; nothing already assessed has changed. You can switch it off in one click.'
      : 'Interviews assessed from now on use the model\'s own level. Nothing already assessed has changed.';
    const link = `${config.webOrigin.replace(/\/+$/, '')}/admin/calibration`;

    await email.send(brandedEmail({
      to: to.join(', '),
      subject: headerSafe(subject),
      text: `${intro}\n\n${tail}\n\n${link}`,
      html: `<p>${escapeHtml(intro)}</p><p>${escapeHtml(tail)}</p>${emailButton(link, 'Review calibration')}`,
    }));
    return { sentTo: to.length };
  } catch (err) {
    // A notice that cannot be sent must never stop the calibration run; the
    // audit event is written either way, so the record is complete regardless.
    logger.error({ err: String(err), tenantId: notice.tenantId }, 'The calibration notice to admins could not be sent');
    return { sentTo: 0 };
  }
}
