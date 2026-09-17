import { z } from 'zod';

// A meeting link is rendered as a clickable link for recruiters and emailed,
// so only absolute https URLs are accepted — never javascript:, data: or http:.
export const meetingUrlSchema = z.string().trim().max(2048).url('Enter the full meeting link, starting with https://')
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Meeting links must start with https://');

// Long enough for a panel, short enough that a typo (600 instead of 60) is caught.
export const durationSchema = z.number().int().min(15).max(480);
